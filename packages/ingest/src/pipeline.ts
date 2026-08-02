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
  /**
   * Treats every document as changed, ignoring contentHash.
   *
   * The manual backfill path ADR 0003 names. Needed whenever the normalizer or the search vector
   * changes: stored content is identical, so a normal run reports everything unchanged and the
   * stale derivation is never corrected.
   */
  readonly reprocess?: boolean;
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
  // pair lookup.
  //
  // Keyed on the PAIR, not the full triple. The triple was the bug: two genuinely different files
  // that normalize to one `externalId` (a literal `a\b.md` beside a real `a/b.md`, since
  // `toExternalId` folds backslashes; or NFC/NFD variants of one filename) have different content
  // hashes, so the triple key missed and BOTH were decided `new`. The second then upserted over the
  // first — 4 files in, `new: 4`, zero failures reported, 2 rows stored. Worse, it never converged:
  // each later run rewrote the surviving row with the other file's title and body, flip-flopping
  // forever and burning an `updated` event every time.
  //
  // Two files claiming one identity is an error, not something to silently resolve in favour of
  // whichever was enumerated last. The first wins and the rest are reported as failures — visible
  // in `import_events`, and never a silent deletion.
  const seenThisRun = new Map<string, string>();

  for (const pending of input.pending) {
    const runKey = `${pending.sourceId}/${pending.externalId}`;
    const already = seenThisRun.get(runKey);
    if (already !== undefined) {
      // Same bytes twice (the same file reached by two walks) is a duplicate to skip quietly.
      // Different bytes under one identity is a collision, and it must not be silent.
      if (already !== pending.contentHash) {
        counts.failed++;
        events.push({
          id: mintEventId(),
          workspaceId,
          sourceId: input.sourceId,
          status: 'failed',
          error: {
            code: 'duplicate-identity',
            message: MARKDOWN_ERRORS['duplicate-identity'],
          },
          occurredAt: input.now,
        });
      }
      continue;
    }
    seenThisRun.set(runKey, pending.contentHash);

    const known = await input.lookup(pending.sourceId, pending.externalId);
    const outcome: Outcome =
      known === undefined
        ? 'new'
        : input.reprocess || known.contentHash !== pending.contentHash
          ? 'changed'
          : 'unchanged';

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
