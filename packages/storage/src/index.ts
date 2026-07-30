/**
 * Storage and retrieval. Implements ADR 0004.
 *
 * Every function here takes a `Scope`. There is no way to read or write a Doc without one, and
 * scope is applied as a WHERE clause inside the ranking query — never as a post-filter. See ADR
 * 0004: rank-then-filter both leaks across workspaces and starves small ones, because the top-N is
 * drawn from the whole corpus before scoping.
 */

import {
  assertVisible,
  scopeFilter,
  type Derived,
  type Doc,
  type DocId,
  type Scope,
  type SourceId,
  type Visible,
  type WorkspaceId,
} from '@strata/core';

export * from './driver.ts';
export * from './sources.ts';

/** Minimal driver surface. Satisfied by PGlite (tests) and node-postgres (production). */
export interface SqlDriver {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

/**
 * Hot metadata splits from cold body because `contract-doc` requires metadata-only retrieval —
 * a requirement, not an optimization. An agent doing search_docs cannot afford to pull bodies to
 * judge relevance.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS docs (
  workspace_id     text        NOT NULL,
  id               text        NOT NULL,
  source_id        text        NOT NULL,
  external_id      text        NOT NULL,
  content_hash     text        NOT NULL,
  source_url       text,
  title            text        NOT NULL,
  excerpt          text        NOT NULL,
  excerpt_prov     text        NOT NULL,
  folder           text        NOT NULL,
  folder_prov      text        NOT NULL,
  tags             text[]      NOT NULL DEFAULT '{}',
  tags_prov        text        NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  search_vector    tsvector    NOT NULL,
  PRIMARY KEY (workspace_id, id),
  -- ADR 0003's identity tuple. This constraint is what makes re-import idempotent.
  UNIQUE (workspace_id, source_id, external_id)
);

CREATE TABLE IF NOT EXISTS doc_bodies (
  workspace_id text NOT NULL,
  doc_id       text NOT NULL,
  body         text NOT NULL,
  PRIMARY KEY (workspace_id, doc_id)
);

CREATE TABLE IF NOT EXISTS sources (
  workspace_id   text NOT NULL,
  id             text NOT NULL,
  kind           text NOT NULL,
  name           text NOT NULL,
  description    text NOT NULL,
  status         text NOT NULL,
  last_sync_at   timestamptz,
  -- A reference to a credential, never the credential. See ADR 0002 / contract-source.
  credential_ref text,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS docs_fts ON docs USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS docs_scope ON docs (workspace_id, source_id) INCLUDE (updated_at);
`;

export async function migrate(db: SqlDriver): Promise<void> {
  await db.exec(SCHEMA_SQL);
}

/**
 * The A/B/C/D weighting from ADR 0004.
 *
 * `Doc.tags` is `Derived<readonly string[]>` — one provenance for the whole array, not per tag.
 * So the B-vs-D split is per-document: a doc whose tags were authored gets all of them at B, a doc
 * whose tags were guessed gets all of them at D. If tags ever become individually provenanced, this
 * expression is where that shows up.
 *
 * Casts are explicit because Postgres cannot infer a parameter's type inside `array_to_string`.
 */
const SEARCH_VECTOR = `
  setweight(to_tsvector('english', coalesce($7::text, '')), 'A') ||
  setweight(to_tsvector('english',
    CASE WHEN $13::text IN ('user','source') THEN array_to_string($12::text[], ' ') ELSE '' END), 'B') ||
  setweight(to_tsvector('english', coalesce($8::text, '') || ' ' || coalesce($10::text, '')), 'C') ||
  setweight(to_tsvector('english',
    CASE WHEN $13::text IN ('user','source') THEN '' ELSE array_to_string($12::text[], ' ') END), 'D')
`;

export interface UpsertDocInput {
  /** Provisional per ADR 0003 — used only on insert. On conflict the stored id wins. */
  readonly id: DocId;
  readonly sourceId: SourceId;
  readonly externalId: string;
  readonly contentHash: string;
  readonly sourceUrl?: string;
  readonly title: string;
  readonly excerpt: Derived<string>;
  readonly folder: Derived<string>;
  readonly tags: Derived<readonly string[]>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly body: string;
}

export interface DocSummary {
  readonly id: DocId;
  readonly sourceId: SourceId;
  readonly title: string;
  readonly excerpt: string;
  readonly folder: string;
  readonly tags: readonly string[];
  readonly updatedAt: string;
  readonly rank: number;
}

/** Hard ceiling on any result set. A caller's `limit` is clamped to this, never honored above it. */
export const MAX_RESULTS = 50;

export interface DocStore {
  upsert(scope: Scope, input: UpsertDocInput): Promise<DocId>;
  /**
   * Prior state for one `(sourceId, externalId)` pair — what ingest needs to decide
   * new/unchanged/changed. Keyed on the pair, not the identity triple: the triple cannot tell a
   * changed file from a new one (ADR 0003).
   */
  findKnown(
    scope: Scope,
    sourceId: SourceId,
    externalId: string,
  ): Promise<{ readonly docId: DocId; readonly contentHash: string } | undefined>;
  search(scope: Scope, query: string, limit?: number): Promise<readonly DocSummary[]>;
  get(scope: Scope, id: DocId): Promise<Visible<Doc> & { readonly body: string }>;
}

export function createDocStore(db: SqlDriver): DocStore {
  return {
    /**
     * Honors ADR 0003's provisional-id rule: `DO UPDATE` returns the *existing* row's id, so a
     * crash mid-persist followed by a retry converges on one row instead of double-writing.
     */
    async upsert(scope, input) {
      const { workspaceId } = scopeFilter(scope);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO docs (
           workspace_id, id, source_id, external_id, content_hash, source_url,
           title, excerpt, excerpt_prov, folder, folder_prov, tags, tags_prov,
           created_at, updated_at, search_vector
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, ${SEARCH_VECTOR})
         ON CONFLICT (workspace_id, source_id, external_id) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           source_url   = EXCLUDED.source_url,
           title        = EXCLUDED.title,
           excerpt      = EXCLUDED.excerpt,
           excerpt_prov = EXCLUDED.excerpt_prov,
           folder       = EXCLUDED.folder,
           folder_prov  = EXCLUDED.folder_prov,
           tags         = EXCLUDED.tags,
           tags_prov    = EXCLUDED.tags_prov,
           updated_at   = EXCLUDED.updated_at,
           search_vector = EXCLUDED.search_vector
         RETURNING id`,
        [
          workspaceId,
          input.id,
          input.sourceId,
          input.externalId,
          input.contentHash,
          input.sourceUrl ?? null,
          input.title,
          input.excerpt.value,
          input.excerpt.provenance,
          input.folder.value,
          input.folder.provenance,
          input.tags.value,
          input.tags.provenance,
          input.createdAt,
          input.updatedAt,
        ],
      );

      const storedId = rows[0]?.id as DocId | undefined;
      if (!storedId) throw new Error('upsert returned no id');

      await db.query(
        `INSERT INTO doc_bodies (workspace_id, doc_id, body) VALUES ($1,$2,$3)
         ON CONFLICT (workspace_id, doc_id) DO UPDATE SET body = EXCLUDED.body`,
        [workspaceId, storedId, input.body],
      );

      return storedId;
    },

    async findKnown(scope, sourceId, externalId) {
      const { workspaceId } = scopeFilter(scope);
      const { rows } = await db.query<{ id: string; content_hash: string }>(
        `SELECT id, content_hash FROM docs
          WHERE workspace_id = $1 AND source_id = $2 AND external_id = $3`,
        [workspaceId, sourceId, externalId],
      );
      const row = rows[0];
      return row === undefined ? undefined : { docId: row.id as DocId, contentHash: row.content_hash };
    },

    /**
     * Metadata and excerpt only — never bodies. `doc_bodies` is not joined here, which is the
     * mechanical guarantee behind the contract's body-separability requirement.
     */
    async search(scope, query, limit = MAX_RESULTS) {
      const filter = scopeFilter(scope);
      const capped = Math.max(1, Math.min(limit, MAX_RESULTS));
      const sourceIds = filter.sourceIds;

      const { rows } = await db.query<{
        id: string;
        source_id: string;
        title: string;
        excerpt: string;
        folder: string;
        tags: string[];
        updated_at: Date | string;
        rank: number | string;
      }>(
        `SELECT id, source_id, title, excerpt, folder, tags, updated_at,
                ts_rank_cd(search_vector, websearch_to_tsquery('english', $2)) AS rank
           FROM docs
          WHERE workspace_id = $1
            AND ($3::text[] IS NULL OR source_id = ANY($3::text[]))
            AND search_vector @@ websearch_to_tsquery('english', $2)
          ORDER BY rank DESC, updated_at DESC
          LIMIT $4`,
        [filter.workspaceId, query, sourceIds === undefined ? null : [...sourceIds], capped],
      );

      return rows.map((r) => ({
        id: r.id as DocId,
        sourceId: r.source_id as SourceId,
        title: r.title,
        excerpt: r.excerpt,
        folder: r.folder,
        tags: r.tags,
        updatedAt: new Date(r.updated_at).toISOString(),
        rank: Number(r.rank),
      }));
    },

    /**
     * Re-checks scope via `assertVisible` even though the WHERE clause already scoped the read.
     * Belt and braces is deliberate here: this is the one path that returns a body, and
     * `.claude/skills/mcp-surface/SKILL.md` requires the tool itself to re-check rather than trust
     * an upstream filter. `assertVisible` throws `NotFound`, so out-of-scope and nonexistent are
     * indistinguishable to a caller — no enumeration oracle over doc ids.
     */
    async get(scope, id) {
      const filter = scopeFilter(scope);
      const { rows } = await db.query<Record<string, never>>(
        `SELECT d.id, d.workspace_id, d.source_id, d.external_id, d.content_hash, d.source_url,
                d.title, d.excerpt, d.excerpt_prov, d.folder, d.folder_prov, d.tags, d.tags_prov,
                d.created_at, d.updated_at, b.body
           FROM docs d
           JOIN doc_bodies b ON b.workspace_id = d.workspace_id AND b.doc_id = d.id
          WHERE d.workspace_id = $1 AND d.id = $2`,
        [filter.workspaceId, id],
      );

      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error('NotFound');

      const iso = (v: unknown) => new Date(v as string).toISOString();
      const derived = <T>(value: T, provenance: unknown): Derived<T> => ({
        value,
        provenance: provenance as Derived<T>['provenance'],
        derivedAt: iso(row['updated_at']),
      });

      const doc: Doc = {
        id: row['id'] as DocId,
        workspaceId: row['workspace_id'] as WorkspaceId,
        sourceId: row['source_id'] as SourceId,
        externalId: row['external_id'] as string,
        contentHash: row['content_hash'] as string,
        ...(row['source_url'] == null ? {} : { sourceUrl: row['source_url'] as string }),
        title: row['title'] as string,
        excerpt: derived(row['excerpt'] as string, row['excerpt_prov']),
        folder: derived(row['folder'] as string, row['folder_prov']),
        tags: derived(row['tags'] as readonly string[], row['tags_prov']),
        createdAt: iso(row['created_at']),
        updatedAt: iso(row['updated_at']),
        bodyRef: `body:${row['id'] as string}` as Doc['bodyRef'],
      };

      return { ...assertVisible(scope, doc), body: row['body'] as string };
    },
  };
}
