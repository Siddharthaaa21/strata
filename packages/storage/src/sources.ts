/**
 * Source storage. Backs the `list_sources` MCP tool and the Import screen.
 *
 * `Source` is returned independently of any `Doc`, which is why it carries its own `workspaceId`
 * (ADR 0002) — without it this store would have to join through docs, and a workspace with no docs
 * would leak every connected account.
 */

import { requireSourceInGrant } from '@strata/core';
import { isVisible, scopeFilter, type Scope, type Source, type SourceId, type SourceKind, type WorkspaceId } from '@strata/core';
import type { SqlDriver } from './index.ts';

export interface UpsertSourceInput {
  readonly id: SourceId;
  readonly kind: SourceKind;
  readonly name: string;
  readonly description: string;
  readonly status: Source['status'];
  readonly lastSyncAt?: string;
  readonly credentialRef?: string;
}

export interface SourceStore {
  upsert(scope: Scope, input: UpsertSourceInput): Promise<SourceId>;
  /**
   * Lists the sources this scope may reach.
   *
   * Filters with `isVisible` and silently drops rows that fail, rather than asserting per row:
   * `assertSourceVisible` throws, so using it here would turn one out-of-grant source into a
   * `NotFound` for the whole call and tell the caller that a source they cannot see exists. See
   * `.claude/skills/mcp-surface/SKILL.md`.
   */
  list(scope: Scope): Promise<readonly Source[]>;
}

export function createSourceStore(db: SqlDriver): SourceStore {
  return {
    /**
     * `credential_ref` updates through COALESCE, not EXCLUDED — every other column overwrites.
     *
     * An upsert that omits `credentialRef` must not erase a stored one. It did, and no caller
     * passes one: `scripts/ingest.mjs` upserts the source on every run, so ingesting Markdown
     * against an existing connector's source id nulled that connector's credential reference.
     *
     * A credential is the one field here that cannot be re-derived by re-running anything — every
     * other column comes back from the next scan. Clearing it therefore needs an explicit path,
     * which is a disconnect operation, not a side effect of an unrelated write.
     */
    async upsert(scope, input) {
      // A narrowed principal may not create or redefine a source outside its grant (ADR 0006 §6).
      requireSourceInGrant(scope, input.id);
      const { workspaceId } = scopeFilter(scope);
      await db.query(
        `INSERT INTO sources (workspace_id, id, kind, name, description, status, last_sync_at, credential_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           kind = EXCLUDED.kind, name = EXCLUDED.name, description = EXCLUDED.description,
           status = EXCLUDED.status, last_sync_at = EXCLUDED.last_sync_at,
           credential_ref = COALESCE(EXCLUDED.credential_ref, sources.credential_ref)`,
        [
          workspaceId,
          input.id,
          input.kind,
          input.name,
          input.description,
          input.status,
          input.lastSyncAt ?? null,
          input.credentialRef ?? null,
        ],
      );
      return input.id;
    },

    async list(scope) {
      const { workspaceId } = scopeFilter(scope);
      const { rows } = await db.query<{
        id: string;
        kind: string;
        name: string;
        description: string;
        status: string;
        last_sync_at: Date | string | null;
        credential_ref: string | null;
      }>(
        `SELECT id, kind, name, description, status, last_sync_at, credential_ref
           FROM sources WHERE workspace_id = $1 ORDER BY name`,
        [workspaceId],
      );

      return rows
        .map((r) => {
          const source: Source = {
            id: r.id as SourceId,
            workspaceId: workspaceId as WorkspaceId,
            kind: r.kind as SourceKind,
            name: r.name,
            description: r.description,
            status: r.status as Source['status'],
            ...(r.last_sync_at == null ? {} : { lastSyncAt: new Date(r.last_sync_at).toISOString() }),
            ...(r.credential_ref == null ? {} : { credentialRef: r.credential_ref }),
          };
          return source;
        })
        // A Source row is reachable when the grant allows its own id as a source.
        .filter((s) => isVisible(scope, { workspaceId: s.workspaceId, sourceId: s.id }));
    },
  };
}
