/**
 * The persist stage: the one part of the pipeline ADR 0003 could not build, because `svc-storage`
 * did not exist yet.
 *
 * Deliberately a separate module from `./pipeline.ts`, which stays free of any storage dependency.
 * The decision logic is pure and testable on its own; only this file knows a store exists.
 */

import type { Scope, SourceId } from '@strata/core';
import type { DocStore } from '@strata/storage';
import type { Decision, IngestResult, KnownDocLookup } from './pipeline.ts';

/** Adapts a `DocStore` to the lookup `runIngest` needs. Scope-filtered, like every store read. */
export function storeLookup(scope: Scope, store: DocStore): KnownDocLookup {
  return (sourceId: SourceId, externalId: string) => store.findKnown(scope, sourceId, externalId);
}

export interface PersistResult {
  readonly written: number;
  readonly skipped: number;
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

  for (const decision of decisions) {
    if (decision.outcome === 'unchanged') {
      skipped++;
      continue;
    }

    const { pending } = decision;
    await store.upsert(scope, {
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
    written++;
  }

  return { written, skipped };
}

/** Convenience for callers that want the ingest result and the write counts together. */
export async function persistIngest(
  scope: Scope,
  store: DocStore,
  result: IngestResult,
): Promise<IngestResult & PersistResult> {
  const persisted = await persistDecisions(scope, store, result.decisions);
  return { ...result, ...persisted };
}
