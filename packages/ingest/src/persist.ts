/**
 * The persist stage: the one part of the pipeline ADR 0003 could not build, because `svc-storage`
 * did not exist yet.
 *
 * Deliberately a separate module from `./pipeline.ts`, which stays free of any storage dependency.
 * The decision logic is pure and testable on its own; only this file knows a store exists.
 */

import type { DocId, Scope, SourceId } from '@strata/core';
import type { DocStore } from '@strata/storage';
import { MARKDOWN_ERRORS } from './markdown.ts';
import type { Decision, IngestResult, KnownDocLookup } from './pipeline.ts';

/** Adapts a `DocStore` to the lookup `runIngest` needs. Scope-filtered, like every store read. */
export function storeLookup(scope: Scope, store: DocStore): KnownDocLookup {
  return (sourceId: SourceId, externalId: string) => store.findKnown(scope, sourceId, externalId);
}

export interface PersistResult {
  readonly written: number;
  readonly skipped: number;
  /**
   * Provisional id -> the id storage actually kept, for every write where they differed.
   *
   * ADR 0003 calls the minted `DocId` a proposal, and `upsert` honors that by returning the
   * existing row's id on conflict. That return value used to be discarded, which made the proposal
   * authoritative again everywhere else: `runIngest` stamps `ImportEvent.docId` with the minted id
   * *before* the write, so any write where storage's id won left an event pointing at a row that
   * does not exist. `apps/web` hid it by dropping events whose docId is not in the doc map, so the
   * audit trail was wrong in the database and invisible in the UI at the same time.
   */
  readonly reconciled: ReadonlyMap<DocId, DocId>;
  /**
   * Documents whose write failed, by `externalId`.
   *
   * Persist used to fail the whole batch on the first error, which meant `scripts/ingest.mjs` never
   * reached `events.append` and the run left **zero** rows in `import_events` — including for the
   * documents that had already been written. The state was invisible in the database and in the
   * Import screen simultaneously.
   *
   * Per-document tolerance mirrors what the scan stage already does: one unreadable file in a
   * folder of two hundred must not lose the other hundred and ninety-nine. The difference is that a
   * failure here is recorded rather than thrown away.
   */
  readonly failed: readonly { readonly externalId: string; readonly code: string }[];
}

/**
 * Writes decisions to the store.
 *
 * `unchanged` rows are skipped rather than re-upserted. Re-writing them would be harmless for
 * correctness — the upsert is idempotent — but it would rewrite `updated_at` and the search vector
 * on every scan, making every document look freshly modified and quietly destroying recency as a
 * ranking tiebreaker (ADR 0004).
 *
 * The id passed to `upsert` is provisional: on conflict the stored id wins and is returned, so a
 * crash between two documents plus a re-run converges rather than double-writing (ADR 0003).
 */
export async function persistDecisions(
  scope: Scope,
  store: DocStore,
  decisions: readonly Decision[],
): Promise<PersistResult> {
  let written = 0;
  let skipped = 0;
  const reconciled = new Map<DocId, DocId>();
  const failed: { externalId: string; code: string }[] = [];

  for (const decision of decisions) {
    if (decision.outcome === 'unchanged') {
      skipped++;
      continue;
    }

    const { pending } = decision;

    // A move is `relocate` THEN the ordinary upsert, and it needs both.
    //
    // `relocate` moves the row to the new path keeping its id — the whole point of R5, since every
    // DocId already recorded in import_events, in the access log, or by an agent must keep pointing
    // at the same document. It cannot be done by `upsert` alone: `upsert` resolves conflicts on
    // (workspace, source, externalId), and a rename's new path has no row, so it would INSERT and
    // collide on the PRIMARY KEY — a raw constraint error exactly where an operator can least
    // interpret one.
    //
    // But relocating is not enough on its own, and assuming it was is a bug this file shipped with
    // for about an hour. `folder`, `tags`, and the search vector are all DERIVED FROM THE PATH. A
    // document moved from `Architecture/` to `Design/` kept `folder: 'Architecture'` — so the
    // Library's filter pills, which are built from that column, offered a directory that no longer
    // existed and hid the document under it. Byte-identical content does not mean nothing changed.
    //
    // Falling through to the upsert fixes every derived field at once, and it does so through the
    // same single-statement atomic write everything else uses. The row now sits at the new path, so
    // the upsert conflicts there and updates in place, returning the id it already had.
    if (decision.outcome === 'renamed') {
      try {
        await store.relocate(scope, decision.docId, pending.externalId);
      } catch {
        failed.push({ externalId: pending.externalId, code: 'persist-failed' });
        continue;
      }
    }
    try {
      const storedId = await store.upsert(scope, {
        id: decision.docId,
        sourceId: pending.sourceId,
        externalId: pending.externalId,
        contentHash: pending.contentHash,
        // Untrusted<string> is structurally a string; storage holds it as text and the MCP layer is
        // what must fence it on the way back out (ADR 0005).
        title: pending.title,
        excerpt: { ...pending.excerpt, value: pending.excerpt.value },
        folder: { ...pending.folder, value: pending.folder.value },
        tags: { ...pending.tags, value: [...pending.tags.value] },
        createdAt: pending.createdAt,
        updatedAt: pending.updatedAt,
        body: pending.body,
      });
      if (storedId !== decision.docId) reconciled.set(decision.docId, storedId);
      written++;
    } catch {
      // Recorded and skipped, never rethrown. Throwing here aborted the run before
      // `scripts/ingest.mjs` reached `events.append`, so a single failing document erased the audit
      // trail for every document in the batch — including the ones already written.
      //
      // The caught error is deliberately discarded rather than surfaced: a driver error can carry
      // SQL, column names, and fragments of the row it choked on, and `ImportEvent.error.message`
      // is sanitized by contract (ADR 0003). The externalId identifies the file; the operator can
      // re-run one document with far less risk than putting a raw exception into a stored message.
      failed.push({ externalId: pending.externalId, code: 'persist-failed' });
    }
  }

  return { written, skipped, reconciled, failed };
}

/**
 * Convenience for callers that want the ingest result and the write counts together.
 *
 * Also the place where events are reconciled against what storage kept. `runIngest` cannot do this
 * itself — it is storage-free by construction (ADR 0003 / D10), so it stamps the provisional id and
 * this stage corrects it once the real one is known.
 */
export async function persistIngest(
  scope: Scope,
  store: DocStore,
  result: IngestResult,
  now: string = new Date().toISOString(),
): Promise<IngestResult & PersistResult & { readonly deleted: number }> {
  const persisted = await persistDecisions(scope, store, result.decisions);

  // Tombstones, applied after the writes.
  //
  // Order matters and this is the safe one. A rename is a delete of the old path plus a write at
  // the new one; doing deletions first would tombstone a document that the relocate in the same run
  // is about to move — and `runIngest` already excludes moved-from paths, so this is belt and
  // braces rather than the primary guard. Doing them last also means a crash mid-run leaves extra
  // documents rather than missing ones, which is the recoverable direction.
  // `result.prune`, not `result.deletions.length`. The list is a proposal that is always computed;
  // the flag is the authorization. Acting on the list alone would turn every ordinary ingest of a
  // subfolder into a mass deletion — the exact failure the opt-in exists to prevent.
  const deleted =
    result.prune && result.deletions.length > 0
      ? await store.softDelete(scope, result.deletions.map((d) => d.docId), now)
      : 0;

  if (persisted.reconciled.size === 0 && persisted.failed.length === 0) {
    return { ...result, ...persisted, deleted };
  }

  const failedIds = new Set(persisted.failed.map((f) => f.externalId));

  const events = result.events.map((e) => {
    // A document that did not persist must not be recorded as `imported`. `runIngest` decided the
    // status before the write happened — it is storage-free by construction — so this is the only
    // stage that knows the difference, and an unrewritten event here is a success in the audit
    // trail for a document that is not in the vault.
    if (e.externalId !== undefined && failedIds.has(e.externalId) && e.status !== 'failed') {
      // Rebuilt field by field rather than spread-minus-docId. `docId` must be absent, not merely
      // overwritten with undefined, and an explicit shape makes it obvious that it is gone: a
      // failed write claiming a document id points the audit trail at a row that does not exist.
      return {
        id: e.id,
        workspaceId: e.workspaceId,
        sourceId: e.sourceId,
        externalId: e.externalId,
        status: 'failed' as const,
        error: { code: 'persist-failed', message: MARKDOWN_ERRORS['persist-failed'] },
        occurredAt: e.occurredAt,
      };
    }
    const canonical = e.docId === undefined ? undefined : persisted.reconciled.get(e.docId);
    return canonical === undefined ? e : { ...e, docId: canonical };
  });

  // A decision whose write failed did not happen. Dropping it keeps `decisions` a record of what is
  // actually in the vault rather than of what was intended — the same reason the event is rewritten.
  const decisions = result.decisions
    .filter((d) => !failedIds.has(d.pending.externalId))
    .map((d) => {
      const canonical = persisted.reconciled.get(d.docId);
      return canonical === undefined ? d : { ...d, docId: canonical };
    });

  // And the counts have to move with them. Incrementing `failed` alone left `new 3 ... failed 1`
  // printed next to `written 2` for three files — a total of four, which is the kind of arithmetic
  // that makes an operator distrust every other number on the screen.
  const counts = { ...result.counts };
  for (const d of result.decisions) {
    if (!failedIds.has(d.pending.externalId)) continue;
    counts[d.outcome] = Math.max(0, counts[d.outcome] - 1);
    counts.failed += 1;
  }

  return { ...result, decisions, events, counts, ...persisted, deleted };
}
