/**
 * Dedupe and `ImportEvent` emission. Implements ADR 0003's identity rules.
 *
 * Deliberately has no storage dependency: it takes a lookup of what is already known and returns
 * decisions plus events. That is what lets M5 land ahead of M4 (D10).
 */

import type { DocId, ImportEvent, Scope, SourceId } from '@strata/core';
import { scopeFilter } from '@strata/core';
import type { MarkdownErrorCode, PendingDoc } from './markdown.ts';
import { MARKDOWN_ERRORS } from './markdown.ts';

/** What storage already holds for a given `(sourceId, externalId)`. */
export interface KnownDoc {
  readonly docId: DocId;
  readonly contentHash: string;
}

/**
 * Looks up prior state.
 *
 * Keyed on the PAIR, not the full identity triple. The triple alone cannot distinguish "new" from
 * "changed": a changed file misses on the triple and looks new, which would mint a second `DocId`
 * for the same file on every edit.
 */
export type KnownDocLookup = (
  sourceId: SourceId,
  externalId: string,
) => Promise<KnownDoc | undefined>;

/** Injected so tests are deterministic; defaults to `crypto.randomUUID` in `runIngest`. */
export type IdFactory = () => DocId;

export type Outcome = 'new' | 'unchanged' | 'changed';

export interface Decision {
  readonly outcome: Outcome;
  /** For `new`, freshly minted. For the others, the id storage already holds. */
  readonly docId: DocId;
  readonly pending: PendingDoc;
}

export interface IngestResult {
  readonly decisions: readonly Decision[];
  readonly events: readonly ImportEvent[];
  readonly counts: Readonly<Record<Outcome | 'failed', number>>;
}

const STATUS: Record<Outcome, ImportEvent['status']> = {
  new: 'imported',
  changed: 'updated',
  // A normal outcome, not an error — idempotent re-import is the design (03-data-contracts.md).
  unchanged: 'skipped-duplicate',
};

export interface RunIngestInput {
  readonly scope: Scope;
  readonly sourceId: SourceId;
  readonly pending: readonly PendingDoc[];
  readonly failures: readonly { readonly externalId: string; readonly code: MarkdownErrorCode }[];
  readonly lookup: KnownDocLookup;
  readonly newId?: IdFactory;
  readonly newEventId?: () => string;
  /** ISO-8601 UTC. Injected so results are reproducible. */
  readonly now: string;
}

/**
 * Decides new/unchanged/changed per document and emits one `ImportEvent` each, including failures.
 *
 * Takes a `Scope` rather than a bare `workspaceId`: this authorizes the write. A deliberate
 * under-approximation — `Grant` models *read* narrowing and is reused here to gate an import, which
 * is strictly more restrictive than no check, never a widening. "Which principals may import into
 * which sources" has no proper home yet (ADR 0003 open item 3, routed to R7/M7).
 */
export async function runIngest(input: RunIngestInput): Promise<IngestResult> {
  // The workspace every emitted event is stamped with. ADR 0002: tenancy comes from an
  // authenticated Scope, never a hand-passed string.
  const { workspaceId } = scopeFilter(input.scope);

  const mintDocId: IdFactory = input.newId ?? (() => globalThis.crypto.randomUUID() as DocId);
  const mintEventId = input.newEventId ?? (() => globalThis.crypto.randomUUID());

  const decisions: Decision[] = [];
  const events: ImportEvent[] = [];
  const counts = { new: 0, unchanged: 0, changed: 0, failed: 0 };

  // Guards against the same file being enumerated twice within one run — a different job from the
  // pair lookup, and the one `docIdentityKey`'s full triple is actually for.
  const seenThisRun = new Set<string>();

  for (const pending of input.pending) {
    const runKey = `${pending.sourceId}/${pending.externalId}/${pending.contentHash}`;
    if (seenThisRun.has(runKey)) continue;
    seenThisRun.add(runKey);

    const known = await input.lookup(pending.sourceId, pending.externalId);
    const outcome: Outcome =
      known === undefined ? 'new' : known.contentHash === pending.contentHash ? 'unchanged' : 'changed';

    const docId = known?.docId ?? mintDocId();
    decisions.push({ outcome, docId, pending });
    counts[outcome]++;

    events.push({
      id: mintEventId(),
      workspaceId,
      sourceId: input.sourceId,
      docId,
      status: STATUS[outcome],
      occurredAt: input.now,
    });
  }

  for (const failure of input.failures) {
    counts.failed++;
    events.push({
      id: mintEventId(),
      workspaceId,
      sourceId: input.sourceId,
      status: 'failed',
      // Fixed template keyed on the code. Never a caught exception's own message, and never the
      // file's content — `ImportEvent.error.message` is sanitized by contract.
      error: { code: failure.code, message: MARKDOWN_ERRORS[failure.code] },
      occurredAt: input.now,
    });
  }

  return { decisions, events, counts };
}
