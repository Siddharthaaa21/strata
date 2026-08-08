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
  /**
   * Set when the stored document is tombstoned — its file was pruned earlier and has now returned.
   *
   * The lookup deliberately reports deleted rows rather than hiding them, so a restored file
   * resurrects its original id instead of minting a second one against a unique constraint that
   * would then reject the write.
   */
  readonly deletedAt?: string;
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

/** One live document's identity, as `listKnown` returns it. The inventory renames are found in. */
export interface KnownIdentity {
  readonly docId: DocId;
  readonly externalId: string;
  readonly contentHash: string;
}

/** Injected so tests are deterministic; defaults to `crypto.randomUUID` in `runIngest`. */
export type IdFactory = () => DocId;

export type Outcome = 'new' | 'unchanged' | 'changed' | 'renamed';

export interface Decision {
  readonly outcome: Outcome;
  /** For `new`, freshly minted. For the others, the id storage already holds. */
  readonly docId: DocId;
  readonly pending: PendingDoc;
  /** Only on `renamed`: the path this document used to live at. For the operator, and for logs. */
  readonly previousExternalId?: string;
}

/** A document whose file is gone. Acted on only when the caller asked to prune. */
export interface Deletion {
  readonly docId: DocId;
  readonly externalId: string;
}

export interface IngestResult {
  readonly decisions: readonly Decision[];
  /**
   * Stored documents with no file behind them any more. **Always computed** when `known` was
   * supplied, whether or not pruning was asked for.
   *
   * Computing is not acting, and separating them is what makes a prune safe to run: without the
   * flag this is a dry run the operator can read before deleting anything. A list that only exists
   * once you have already opted into deletion cannot warn you that the list is wrong.
   */
  readonly deletions: readonly Deletion[];
  /** Whether the caller authorized acting on `deletions`. The persist stage reads this, not a flag. */
  readonly prune: boolean;
  readonly events: readonly ImportEvent[];
  readonly counts: Readonly<Record<Outcome | 'failed' | 'deleted', number>>;
}

const STATUS: Record<Outcome, ImportEvent['status']> = {
  new: 'imported',
  changed: 'updated',
  // A move is a modification of the document, not a new document and not a no-op. `updated` rather
  // than a status of its own: the audit trail's question is "did this document change", and the
  // answer is yes. Which path it moved from is on the Decision.
  renamed: 'updated',
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
  /**
   * Every live document already stored for this source (R5).
   *
   * Needed for the two questions a per-path lookup cannot answer, because both are about files the
   * scan did NOT find: a stored path with no file is either a rename — some newly-seen path holds
   * the same bytes — or a deletion.
   *
   * Optional, and omitting it simply disables both. A caller that cannot cheaply produce the
   * inventory still gets the old, correct-but-lossy behaviour rather than an error.
   */
  readonly known?: readonly KnownIdentity[];
  /**
   * Whether to propose deleting documents whose files are gone.
   *
   * OFF by default, and that default is the whole safety argument. `externalId` is relative to the
   * scanned root, so ingesting a SUBFOLDER of a source produces a run in which almost every stored
   * document is legitimately "not seen" — with prune on by default, one narrower-than-usual command
   * empties the vault and reports it as success. Deletion has to be something the operator asked
   * for in the sentence they typed.
   *
   * Even then this only *proposes*: `runIngest` is storage-free, so it returns `deletions` and the
   * persist stage is what acts.
   */
  readonly prune?: boolean;
  /** ISO-8601 UTC. Injected so results are reproducible. */
  readonly now: string;
}

/**
 * Matches newly-seen files against stored documents whose files have disappeared.
 *
 * Content hash, because that is the only thing a moved file keeps. The rule is deliberately timid:
 * a hash must correspond to **exactly one** unseen stored document AND **exactly one** newly-seen
 * file before anything is matched. Identical files are ordinary — empty files, copied templates,
 * generated stubs — and a wrong match silently rewrites one document's identity to another's path.
 * Two candidates is not a puzzle to solve with a heuristic; it is a case to leave alone, where the
 * cost is the old behaviour (a delete plus a create) rather than a corrupted link.
 *
 * A rename whose content ALSO changed is not detectable this way and is not detected. That is a
 * real limit, and the alternative — similarity scoring over bodies — buys a maybe in exchange for a
 * class of confident mistakes.
 */
function matchRenames(
  pendingByHash: ReadonlyMap<string, readonly PendingDoc[]>,
  unseen: readonly KnownIdentity[],
): ReadonlyMap<string, KnownIdentity> {
  const unseenByHash = new Map<string, KnownIdentity[]>();
  for (const k of unseen) {
    const bucket = unseenByHash.get(k.contentHash);
    if (bucket === undefined) unseenByHash.set(k.contentHash, [k]);
    else bucket.push(k);
  }

  const matched = new Map<string, KnownIdentity>();
  for (const [hash, candidates] of unseenByHash) {
    if (candidates.length !== 1) continue;
    const arrivals = pendingByHash.get(hash);
    if (arrivals === undefined || arrivals.length !== 1) continue;
    matched.set(arrivals[0]!.externalId, candidates[0]!);
  }
  return matched;
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
  const counts = { new: 0, unchanged: 0, changed: 0, renamed: 0, failed: 0, deleted: 0 };

  // Renames are resolved BEFORE the main loop, not patched up afterwards.
  //
  // The ordering matters: a rename decided after the fact would already have minted a DocId and
  // emitted an `imported` event for a document that turns out to be an existing one. Working it out
  // first means the loop makes one decision per file and the audit trail never records a document
  // being created that was not.
  const known = input.known ?? [];
  const seenPaths = new Set(input.pending.map((p) => p.externalId));
  const unseen = known.filter((k) => !seenPaths.has(k.externalId));

  const knownPaths = new Set(known.map((k) => k.externalId));
  const pendingByHash = new Map<string, PendingDoc[]>();
  for (const p of input.pending) {
    // Only files with no stored document at their own path can be the destination of a rename.
    // A file that already exists where it is has not moved, however its bytes compare.
    if (knownPaths.has(p.externalId)) continue;
    const bucket = pendingByHash.get(p.contentHash);
    if (bucket === undefined) pendingByHash.set(p.contentHash, [p]);
    else bucket.push(p);
  }

  const renames = matchRenames(pendingByHash, unseen);
  /** Old paths consumed by a rename. They are moves, so pruning must not also delete them. */
  const movedFrom = new Set([...renames.values()].map((k) => k.externalId));

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
          // Names the file that LOST. Without it, "another file already claims this identifier" is
          // advice the operator cannot act on across a large vault.
          externalId: pending.externalId,
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

    const prior = await input.lookup(pending.sourceId, pending.externalId);
    const movedHere = prior === undefined ? renames.get(pending.externalId) : undefined;

    const outcome: Outcome =
      movedHere !== undefined
        ? 'renamed'
        : prior === undefined
          ? 'new'
          : // A tombstoned document whose file is back must be REWRITTEN, not skipped. Its content
            // hash still matches, so the ordinary comparison says `unchanged` and nothing is
            // written — leaving the row deleted, invisible to every read path, while the run
            // reports the file as present. `upsert` is what clears `deleted_at`, so the decision
            // has to reach it.
            prior.deletedAt !== undefined || input.reprocess || prior.contentHash !== pending.contentHash
            ? 'changed'
            : 'unchanged';

    const docId = movedHere?.docId ?? prior?.docId ?? mintDocId();
    decisions.push({
      outcome,
      docId,
      pending,
      ...(movedHere === undefined ? {} : { previousExternalId: movedHere.externalId }),
    });
    counts[outcome]++;

    events.push({
      id: mintEventId(),
      workspaceId,
      sourceId: input.sourceId,
      docId,
      externalId: pending.externalId,
      status: STATUS[outcome],
      occurredAt: input.now,
    });
  }

  // Files that are simply gone. ALWAYS computed, so a run without `prune` is a dry run the operator
  // can read — a warning that only appears after you have opted into deletion is not a warning.
  const deletions: Deletion[] = unseen
    .filter((k) => !movedFrom.has(k.externalId))
    .map((k) => ({ docId: k.docId, externalId: k.externalId }));

  // Events and counts, however, describe what HAPPENED. A `deleted` event for a document still
  // sitting in the vault would be a lie in the audit trail, so only a run that actually prunes
  // records one.
  if (input.prune === true) {
    for (const deletion of deletions) {
      counts.deleted++;
      events.push({
        id: mintEventId(),
        workspaceId,
        sourceId: input.sourceId,
        docId: deletion.docId,
        externalId: deletion.externalId,
        status: 'deleted',
        occurredAt: input.now,
      });
    }
  }

  for (const failure of input.failures) {
    counts.failed++;
    events.push({
      id: mintEventId(),
      workspaceId,
      sourceId: input.sourceId,
      // The scan stage already knows which file failed; this is where that survives into storage.
      externalId: failure.externalId,
      status: 'failed',
      // Fixed template keyed on the code. Never a caught exception's own message, and never the
      // file's content — `ImportEvent.error.message` is sanitized by contract.
      error: { code: failure.code, message: MARKDOWN_ERRORS[failure.code] },
      occurredAt: input.now,
    });
  }

  return { decisions, deletions, prune: input.prune === true, events, counts };
}
