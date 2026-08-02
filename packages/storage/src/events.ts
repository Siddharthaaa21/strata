/**
 * ImportEvent storage. Backs the Import screen's "Recent imports" list.
 *
 * Failures are recorded, not just successes: the Recent Imports list rendering only successes is a
 * UI choice, but *storing* only successes would make partial-sync bugs undetectable
 * (03-data-contracts.md).
 */

import { requireSourceInGrant, scopeFilter, type ImportEvent, type DocId, type Scope, type SourceId, type WorkspaceId } from '@strata/core';
import type { SqlDriver } from './index.ts';

export interface EventStore {
  append(scope: Scope, events: readonly ImportEvent[]): Promise<number>;
  recent(scope: Scope, limit?: number): Promise<readonly ImportEvent[]>;
}

export function createEventStore(db: SqlDriver): EventStore {
  return {
    async append(scope, events) {
      const { workspaceId } = scopeFilter(scope);
      // Checked for the whole batch before anything is written, so a denial cannot leave a partial
      // audit trail. An event names the source it happened to; writing one for a source outside the
      // grant would let a narrowed principal forge history in a source it cannot see.
      for (const e of events) requireSourceInGrant(scope, e.sourceId);
      for (const e of events) {
        await db.query(
          `INSERT INTO import_events
             (workspace_id, id, source_id, doc_id, status, error_code, error_message, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (workspace_id, id) DO NOTHING`,
          [
            workspaceId,
            e.id,
            e.sourceId,
            e.docId ?? null,
            e.status,
            e.error?.code ?? null,
            e.error?.message ?? null,
            e.occurredAt,
          ],
        );
      }
      return events.length;
    },

    async recent(scope, limit = 20) {
      const { workspaceId, sourceIds } = scopeFilter(scope);
      const { rows } = await db.query<{
        id: string;
        source_id: string;
        doc_id: string | null;
        status: string;
        error_code: string | null;
        error_message: string | null;
        occurred_at: Date | string;
      }>(
        // The grant filter is a WHERE clause, never a post-filter — same rule as every other read.
        // Without it a narrowed principal saw sourceId and docId for every source in the workspace,
        // which is a full enumeration of the vault it was explicitly narrowed away from.
        `SELECT id, source_id, doc_id, status, error_code, error_message, occurred_at
           FROM import_events
          WHERE workspace_id = $1
            AND ($2::text[] IS NULL OR source_id = ANY($2::text[]))
          ORDER BY occurred_at DESC
          LIMIT $3`,
        [
          workspaceId,
          sourceIds === undefined ? null : [...sourceIds],
          Math.max(1, Math.min(limit, 100)),
        ],
      );

      return rows.map((r) => ({
        id: r.id,
        workspaceId: workspaceId as WorkspaceId,
        sourceId: r.source_id as SourceId,
        ...(r.doc_id == null ? {} : { docId: r.doc_id as DocId }),
        status: r.status as ImportEvent['status'],
        ...(r.error_code == null
          ? {}
          : { error: { code: r.error_code, message: r.error_message ?? '' } }),
        occurredAt: new Date(r.occurred_at).toISOString(),
      }));
    },
  };
}
