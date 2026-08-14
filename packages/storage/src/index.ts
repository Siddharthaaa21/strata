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
  requireSourceInGrant,
  isSourceInGrant,
} from '@strata/core';

export * from './driver.ts';
export * from './sources.ts';
export * from './events.ts';
export * from './auth-store.ts';
export * from './access-log.ts';

// `export *` re-exports but does not bring a name into this module's scope; ReadonlySourceStore
// below is declared here, so the type it narrows has to be imported explicitly.
import type { SourceStore } from './sources.ts';

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

CREATE TABLE IF NOT EXISTS import_events (
  workspace_id  text        NOT NULL,
  id            text        NOT NULL,
  source_id     text        NOT NULL,
  doc_id        text,
  -- Which file. doc_id is absent precisely in the failure case, so without this a failed import
  -- says only "something in this source failed" — see ADR 0003 on why failures must be actionable.
  external_id   text,
  status        text        NOT NULL,
  error_code    text,
  -- Sanitized by contract: a fixed per-code template, never a caught exception's message and never
  -- document content. See ADR 0003.
  error_message text,
  occurred_at   timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS import_events_recent
  ON import_events (workspace_id, occurred_at DESC);

-- Authentication (ADR 0006). Revocation never deletes a row: an access log naming a principal id
-- that no longer resolves is worse than no access log.
CREATE TABLE IF NOT EXISTS principals (
  workspace_id text        NOT NULL,
  id           text        NOT NULL,
  kind         text        NOT NULL,          -- 'user' | 'agent' | 'service'
  display_name text        NOT NULL,
  created_at   timestamptz NOT NULL,
  created_by   text,                          -- null for the bootstrap owner
  revoked_at   timestamptz,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS grants (
  workspace_id text        NOT NULL,
  id           text        NOT NULL,
  principal_id text        NOT NULL,
  -- NULL means every source in the workspace. '{}' means deny-all. These are NOT the same value,
  -- and a COALESCE(source_ids, '{}') anywhere silently turns deny-all into allow-all.
  source_ids   text[],
  created_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  PRIMARY KEY (workspace_id, id)
);

-- "At most one active grant per principal" enforced by the database, not by application discipline.
-- Scope holds a single Grant, so two active grants would need a union at mint time — and union is
-- the one operation that turns "narrows only, can never widen" into its opposite (ADR 0006 §2).
CREATE UNIQUE INDEX IF NOT EXISTS grants_one_active
  ON grants (workspace_id, principal_id) WHERE revoked_at IS NULL;

-- Who may sign in to a workspace, keyed on EMAIL rather than on a principal.
--
-- The allowlist IS the membership row: an address is added before its owner has ever signed in, and
-- principal_id is filled on first successful sign-in. That is deliberately simpler than invite
-- tokens — no token to expire, no accept flow, no pending state that can be abandoned — and it
-- fails in the safe direction: an address nobody added cannot sign in at all, so a stray OAuth
-- login never creates an orphan account with a workspace attached.
--
-- Email is stored lower-cased. Providers vary on case and an allowlist that misses on capitalisation
-- is an allowlist that locks out the person it was written for.
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id text        NOT NULL,
  email        text        NOT NULL,
  principal_id text,                              -- null until first sign-in
  invited_by   text,
  invited_at   timestamptz NOT NULL,
  joined_at    timestamptz,
  revoked_at   timestamptz,
  PRIMARY KEY (workspace_id, email)
);

-- The identity provider's subject id, kept OUT of PrincipalId (ADR 0006 section 5, rule 1).
--
-- Swapping providers rewrites this one table. Using their sub as our principal id would instead
-- rewrite created_by, every grants.principal_id, and every access-log row — which is how an
-- identity provider stops being swappable at any price.
CREATE TABLE IF NOT EXISTS user_identities (
  provider     text NOT NULL,
  subject      text NOT NULL,
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  linked_at    timestamptz NOT NULL,
  PRIMARY KEY (provider, subject)
);

-- Referenceable target for the composite foreign key below. Redundant with the primary key on its
-- own, and that is the point: it lets a child row require that a grant belongs to a named principal.
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_principal_identity;
ALTER TABLE grants ADD CONSTRAINT grants_principal_identity
  UNIQUE (workspace_id, id, principal_id);

CREATE TABLE IF NOT EXISTS agent_tokens (
  -- NOT workspace-scoped, and this is the one deliberate exception to the leading-workspace_id
  -- convention: it is the lookup key used BEFORE any workspace is known. That is the whole point of
  -- splitting a public id off the secret — verification is a primary-key hit, not a scan over every
  -- stored hash.
  token_id     text        PRIMARY KEY,
  workspace_id text        NOT NULL,
  principal_id text        NOT NULL,
  grant_id     text        NOT NULL,
  token_hash   bytea       NOT NULL,          -- sha256 of the secret. The secret is never stored.
  last4        text        NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,

  -- A token may only point at a grant belonging to ITS OWN principal.
  --
  -- Without this, re-pointing grant_id at another principal's grant let a token inherit that
  -- grant's scope — a narrowed agent widened to the whole workspace by editing one column, and the
  -- application check meant to catch it was comparing a value with itself. That check is fixed too;
  -- this makes the bad row unwritable rather than merely detected, which matters because the write
  -- is one an operator is led toward: the one-active-grant index forces revoke-then-insert to
  -- re-scope an agent, and that leaves grant_id pointing at a revoked row.
  CONSTRAINT agent_tokens_grant_belongs_to_principal
    FOREIGN KEY (workspace_id, grant_id, principal_id)
    REFERENCES grants (workspace_id, id, principal_id)
);

-- Additive migrations for databases created before a column existed. CREATE TABLE IF NOT EXISTS is
-- a no-op on an existing table, so a new column needs its own statement or it only ever appears on
-- freshly created databases — which is exactly the class of bug that passes every test (tests start
-- empty) and fails on the one database that matters.
ALTER TABLE import_events ADD COLUMN IF NOT EXISTS external_id text;

-- A tombstone, not a DELETE (R5). When a file disappears from a source, the document stops being
-- visible but the row stays.
--
-- Three reasons it is soft. import_events.doc_id and access_log.doc_ids both point here, so a hard
-- delete either breaks the audit trail or cascades through it — and an audit trail that loses rows
-- when the thing they describe is removed is worst exactly when it is needed. Second, a prune
-- driven by a mis-scoped scan is recoverable by clearing one column instead of by re-importing.
-- Third, re-adding a deleted file resurrects its original DocId rather than minting a second one,
-- which is the whole reason identity is stable in the first place.
--
-- Every read path filters on it. findKnown deliberately does NOT — see the method.
ALTER TABLE docs ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS docs_live_by_source
  ON docs (workspace_id, source_id) WHERE deleted_at IS NULL;

-- Who read what (ADR 0005 section 5). Promised when the fencing strategy was designed and not built
-- until now; it is the compensating control for that ADR's own admission that prevention is
-- incomplete. An injection that succeeds is discovered here or not at all.
--
-- NEVER stores content. A log holding the payload is a second copy of the problem: it would sit
-- outside every fence, be read by whoever debugs an incident, and grow without the retention anyone
-- applies to documents. result_hash is enough to answer "was this the same response as that one"
-- and cannot answer "what did it say", which is the correct amount of power for an audit trail.
--
-- Failures are logged too, and the UNAUTHORIZED ones are the point: a stream of them is what a
-- credential being probed looks like. principal_id is null exactly there, because a request that
-- failed to authenticate has no principal to attribute it to, and inventing one would be worse.
CREATE TABLE IF NOT EXISTS access_log (
  id           text        NOT NULL,
  workspace_id text,                          -- null when authentication failed
  principal_id text,                          -- null when authentication failed
  tool         text        NOT NULL,
  outcome      text        NOT NULL,          -- 'ok' | 'NotFound' | 'Unauthorized' | ...
  doc_ids      text[]      NOT NULL DEFAULT '{}',
  result_hash  text,                          -- sha256 of the response. Never the response.
  occurred_at  timestamptz NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS access_log_recent
  ON access_log (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS access_log_by_principal
  ON access_log (principal_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS docs_fts ON docs USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS docs_scope ON docs (workspace_id, source_id) INCLUDE (updated_at);
`;

export async function migrate(db: SqlDriver): Promise<void> {
  await db.exec(SCHEMA_SQL);
}

/**
 * The A/B/C/D weighting from ADR 0004.
 *
 * Weight D carries both model-provenance tags and the document body.
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
    CASE WHEN $13::text IN ('user','source') THEN '' ELSE array_to_string($12::text[], ' ') END), 'D') ||
  setweight(to_tsvector('english', coalesce($16::text, '')), 'D')
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

/**
 * The read-only slice of each store, for callers that must not be able to write.
 *
 * Declared here rather than in `apps/mcp` so the constraint travels with the store it constrains —
 * anyone adding a store method sees these and has to decide which side it belongs on. D5's "no
 * mutating MCP tool exists" is held by this type, not by the absence of a line of code (ADR 0006 §6;
 * widening either one is R11's trigger).
 */
export type ReadonlyDocStore = Pick<DocStore, 'search' | 'list' | 'get'>;
export type ReadonlySourceStore = Pick<SourceStore, 'list'>;

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
  ): Promise<
    | {
        readonly docId: DocId;
        readonly contentHash: string;
        /**
         * The folder the document is currently filed under.
         *
         * Returned because the content hash cannot see it: `folder` derives partly from the scan
         * ROOT's name, which is not in the file. Without this the pipeline had no way to notice
         * that a re-ingest from a differently-named directory should refile the document (D30).
         */
        readonly folder: string;
        /** Set when the document is tombstoned. Present so the caller can force a restore (R5). */
        readonly deletedAt?: string;
      }
    | undefined
  >;
  /**
   * Identity inventory for one source: every live document's id, path, and content hash.
   *
   * Ingest needs it to reason about the files a scan did NOT see — a stored path with no file is
   * either a rename (some new path has the same content hash) or a deletion. `findKnown` answers
   * per-path and so can never see either.
   */
  listKnown(
    scope: Scope,
    sourceId: SourceId,
  ): Promise<readonly { readonly docId: DocId; readonly externalId: string; readonly contentHash: string }[]>;
  /**
   * Moves a document to a new path, keeping its `DocId` (R5).
   *
   * Throws bare `NotFound` for unknown and out-of-grant alike, like every other keyed operation.
   */
  relocate(scope: Scope, docId: DocId, externalId: string): Promise<void>;
  /**
   * Tombstones documents. Returns how many rows this call actually changed.
   *
   * The count is a return value rather than a void, because "I deleted 40 documents" printed by a
   * CLI must be what the database did, not what the caller intended — the same defect `removeMember`
   * had (D16).
   */
  softDelete(scope: Scope, docIds: readonly DocId[], at: string): Promise<number>;
  search(scope: Scope, query: string, limit?: number): Promise<readonly DocSummary[]>;
  /**
   * Browsing, not searching: the Library shows everything in scope, newest first, with no query.
   * Separate from `search` because ts_rank_cd over an empty query is meaningless — ordering here is
   * recency, which is the only sensible default when the user has not asked for anything specific.
   */
  /**
   * `offset` is what makes a vault larger than `MAX_RESULTS` reachable at all.
   *
   * The ceiling stays exactly where it was — no single call may return more than 50 rows, which is
   * the anti-exfiltration property an agent is held to. Paging is the caller asking for a DIFFERENT
   * fifty, not a bigger page, so a human can reach document 51 while an agent still cannot drain the
   * workspace in one request.
   *
   * Ordering is `updated_at DESC, id DESC`, and the tiebreak is load-bearing rather than tidy: this
   * vault has 47 documents across 30 distinct timestamps, so seventeen of them share one with a
   * neighbour. Without a unique final key, Postgres may return tied rows in any order between two
   * queries — which under offset paging shows a document on page one AND page two while another is
   * never shown at all.
   */
  list(
    scope: Scope,
    options?: { readonly folder?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly DocSummary[]>;
  /**
   * How many documents are in scope, ignoring `MAX_RESULTS`.
   *
   * `list` is clamped, so `rows.length` is the size of a PAGE, not of the vault. The Library was
   * rendering that clamped number as "N docs" — a workspace with 312 documents reported "50 docs",
   * which is not a truncation the user can even see, let alone act on. A count is one cheap query
   * and it is the difference between a UI that is limited and one that is lying.
   */
  count(scope: Scope, options?: { readonly folder?: string }): Promise<number>;
  /**
   * Every distinct folder in scope, ignoring `MAX_RESULTS`.
   *
   * Same defect, worse consequence: the Library derived its filter pills from the clamped page, so a
   * folder whose documents were all older than the 50th vanished from the UI entirely — the filter
   * that would have revealed them was itself hidden by the truncation.
   */
  folders(scope: Scope): Promise<readonly string[]>;
  get(scope: Scope, id: DocId): Promise<Visible<Doc> & { readonly body: string }>;
}

export function createDocStore(db: SqlDriver): DocStore {
  return {
    /**
     * Honors ADR 0003's provisional-id rule: `DO UPDATE` returns the *existing* row's id, so a
     * crash mid-persist followed by a retry converges on one row instead of double-writing.
     *
     * ONE statement, deliberately — the metadata row and the body row are written by a single
     * data-modifying CTE rather than two sequential queries.
     *
     * This was two queries and it was not atomic. A connection lost between them (pooler timeout,
     * failover, kill) left a document in `docs` with no row in `doc_bodies`: searchable, listed in
     * the Library, and throwing `NotFound` on every `get_doc` and every Reader open, permanently.
     * The retry could not repair it either — `findKnown` saw the already-written `content_hash`,
     * the pipeline decided `unchanged`, and `persistDecisions` skipped the write. Only a manual
     * `--reindex` fixed it, and nothing told the operator the state existed. ADR 0004's "a crash
     * plus a retry converges" claim held for the row and failed for the pair.
     *
     * A CTE rather than BEGIN/COMMIT because `SqlDriver` is deliberately a bare `query`, and a
     * `pg.Pool` can route two `query` calls to two different connections — `pool.query('BEGIN')`
     * would open a transaction on a connection the next statement never sees. Making the write a
     * single statement gets atomicity from Postgres's implicit per-statement transaction instead,
     * which is true for every driver shape `fromPoolLike` accepts, PGlite included.
     */
    async upsert(scope, input) {
      // The grant gates writes, not only reads (ADR 0006 section 6). Without this a principal
      // narrowed to source A could inject a document into source B that it cannot itself read.
      requireSourceInGrant(scope, input.sourceId);
      const { workspaceId } = scopeFilter(scope);
      const { rows } = await db.query<{ id: string }>(
        `WITH upserted AS (
           INSERT INTO docs (
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
             search_vector = EXCLUDED.search_vector,
             -- Writing a document undeletes it. A file that comes back is the same document, with
             -- the same id and the same history — resurrecting it here means no caller has to
             -- remember to, and forgetting would leave a row that ingest reports as written and
             -- every read path hides.
             deleted_at   = NULL
           RETURNING id
         )
         INSERT INTO doc_bodies (workspace_id, doc_id, body)
         SELECT $1, upserted.id, $16::text FROM upserted
         ON CONFLICT (workspace_id, doc_id) DO UPDATE SET body = EXCLUDED.body
         RETURNING doc_id AS id`,
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
          // $16 — the body. Used twice now: to build search_vector at weight D, and as the
          // doc_bodies value. The body column still lives only in doc_bodies and is still never
          // selected by search, so metadata-first retrieval holds.
          input.body,
        ],
      );

      const storedId = rows[0]?.id as DocId | undefined;
      if (!storedId) throw new Error('upsert returned no id');
      return storedId;
    },

    async count(scope, options = {}) {
      const { workspaceId, sourceIds } = scopeFilter(scope);
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM docs
          WHERE workspace_id = $1
            AND deleted_at IS NULL
            AND ($2::text[] IS NULL OR source_id = ANY($2::text[]))
            AND ($3::text IS NULL OR folder = $3::text)`,
        [workspaceId, sourceIds === undefined ? null : [...sourceIds], options.folder ?? null],
      );
      return rows[0]?.n ?? 0;
    },

    async folders(scope) {
      const { workspaceId, sourceIds } = scopeFilter(scope);
      const { rows } = await db.query<{ folder: string }>(
        `SELECT DISTINCT folder FROM docs
          WHERE workspace_id = $1
            AND deleted_at IS NULL
            AND ($2::text[] IS NULL OR source_id = ANY($2::text[]))
          ORDER BY folder`,
        [workspaceId, sourceIds === undefined ? null : [...sourceIds]],
      );
      return rows.map((r) => r.folder);
    },

    async findKnown(scope, sourceId, externalId) {
      // Returns undefined rather than throwing: out-of-grant must be indistinguishable from
      // not-known. This method hands back {docId, contentHash}, so an unguarded version was both an
      // existence oracle and a content-confirmation oracle — hash a candidate file, ask, and learn
      // whether that exact content sits in a source you are not allowed to read.
      if (!isSourceInGrant(scope, sourceId)) return undefined;
      const { workspaceId } = scopeFilter(scope);
      // DELIBERATELY sees tombstoned rows — the only read here that does.
      //
      // This answers "what does storage already know at this identity", and a deleted document is
      // still known. Filtering it out would make a restored file look new: a second DocId minted
      // for the same path, the original row still tombstoned underneath it, and the identity
      // constraint then rejecting the write outright. Callers are told via `deletedAt` so the
      // pipeline can force a rewrite rather than deciding `unchanged` and leaving it invisible.
      const { rows } = await db.query<{
        id: string;
        content_hash: string;
        folder: string;
        deleted_at: Date | string | null;
      }>(
        `SELECT id, content_hash, folder, deleted_at FROM docs
          WHERE workspace_id = $1 AND source_id = $2 AND external_id = $3`,
        [workspaceId, sourceId, externalId],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        docId: row.id as DocId,
        contentHash: row.content_hash,
        folder: row.folder,
        ...(row.deleted_at === null ? {} : { deletedAt: new Date(row.deleted_at).toISOString() }),
      };
    },

    /**
     * Every live document in one source, as identity only — id, path, content hash.
     *
     * What ingest needs to answer the two questions `findKnown` cannot, because both are about the
     * documents a scan did NOT encounter: which stored document is this file's previous path
     * (a rename), and which stored documents no longer have a file at all (a delete).
     *
     * Returns no title, excerpt, or body. It is an identity inventory, and a method that hands back
     * content for a whole source is a far larger thing to have to reason about than one that hands
     * back hashes.
     */
    async listKnown(scope, sourceId) {
      if (!isSourceInGrant(scope, sourceId)) return [];
      const { workspaceId } = scopeFilter(scope);
      const { rows } = await db.query<{ id: string; external_id: string; content_hash: string }>(
        `SELECT id, external_id, content_hash FROM docs
          WHERE workspace_id = $1 AND source_id = $2 AND deleted_at IS NULL
          ORDER BY external_id`,
        [workspaceId, sourceId],
      );
      return rows.map((r) => ({
        docId: r.id as DocId,
        externalId: r.external_id,
        contentHash: r.content_hash,
      }));
    },

    /**
     * Moves a document to a new path, keeping its id.
     *
     * The whole point of R5: without this a rename is a delete plus a create, and every `DocId` the
     * rest of the system has recorded — import events, access log entries, anything a user or an
     * agent has referenced — points at a document that no longer exists.
     *
     * A dedicated statement rather than a flag on `upsert`, because the two conflict differently.
     * `upsert` resolves on `(workspace_id, source_id, external_id)`; a rename has no row at the new
     * path, so it would INSERT and collide on the PRIMARY KEY instead — a raw constraint error, on
     * the path where the operator is least able to interpret one.
     *
     * `updated_at` is untouched. A file that moved has not been edited, and bumping it would push
     * every renamed document to the top of a Library ordered by recency, which is a lie about what
     * changed and it destroys the recency tiebreaker for ranking (ADR 0004).
     */
    async relocate(scope, docId, externalId) {
      const { workspaceId } = scopeFilter(scope);
      const { rows } = await db.query<{ id: string }>(
        // The source predicate is the grant check: `scopeFilter`'s sourceIds is the narrowing, and
        // a NULL array means unnarrowed. Expressed as a WHERE clause rather than an early return so
        // an out-of-grant docId is simply not found — same shape as every other keyed read.
        `UPDATE docs SET external_id = $3
          WHERE workspace_id = $1 AND id = $2
            AND ($4::text[] IS NULL OR source_id = ANY($4::text[]))
          RETURNING id`,
        [
          workspaceId,
          docId,
          externalId,
          scopeFilter(scope).sourceIds === undefined ? null : [...scopeFilter(scope).sourceIds!],
        ],
      );
      if (rows.length === 0) throw new Error('NotFound');
    },

    /**
     * Tombstones documents whose files are gone.
     *
     * Soft, for the reasons on the `deleted_at` migration: the audit trail points here, a mis-scoped
     * prune stays recoverable, and a file that returns keeps its original id.
     *
     * Idempotent — `deleted_at IS NULL` in the predicate means re-pruning does not restamp the
     * timestamp, so "when did this leave the vault" survives a second run.
     */
    async softDelete(scope, docIds, at) {
      if (docIds.length === 0) return 0;
      const { workspaceId, sourceIds } = scopeFilter(scope);
      const { rows } = await db.query<{ id: string }>(
        `UPDATE docs SET deleted_at = $3
          WHERE workspace_id = $1 AND id = ANY($2::text[]) AND deleted_at IS NULL
            AND ($4::text[] IS NULL OR source_id = ANY($4::text[]))
          RETURNING id`,
        [workspaceId, [...docIds], at, sourceIds === undefined ? null : [...sourceIds]],
      );
      return rows.length;
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
        // Match on ALL terms if anything does, otherwise on ANY — decided in one statement rather
        // than by issuing a second query on a miss.
        //
        // `websearch_to_tsquery` is AND-semantics, so "tenancy zebrafish" returned nothing at all
        // when one term was absent: a user who adds a word to narrow a search got an empty page
        // instead of a shorter list, which reads as "the vault does not contain this" rather than
        // "one of your words does not appear".
        //
        // The `strict` CTE is the AND result. `EXISTS (SELECT 1 FROM strict)` picks which predicate
        // the outer query uses, so precision is preserved whenever precision is available and the
        // fallback only ever runs when the alternative was zero rows.
        //
        // Ranking then does the rest — but only because it ranks against the query that actually
        // matched. Scoring the fallback rows against `strict_q` gave every one of them rank 0, since
        // rank 0 is precisely what "did not match the AND query" means, and the fallback exists for
        // rows that did not. `ORDER BY rank DESC` over a column of zeroes silently degrades to the
        // tiebreaker, so the fallback returned newest-first: the exact opposite of the sentence
        // above, and wrong in the case that matters most, because a two-word search that falls back
        // is when the reader most needs the document matching both words at the top.
        `WITH q AS (
           SELECT websearch_to_tsquery('english', $2) AS strict_q,
                  -- OR form of the same terms. plainto_tsquery gives '&'-joined lexemes after the
                  -- same normalization, so replacing the operator keeps stemming and stop-word
                  -- handling identical rather than re-tokenizing by hand.
                  replace(plainto_tsquery('english', $2)::text, ' & ', ' | ')::tsquery AS loose_q
         ), strict AS (
           SELECT 1 FROM docs, q
            WHERE workspace_id = $1
              AND deleted_at IS NULL
              AND ($3::text[] IS NULL OR source_id = ANY($3::text[]))
              AND search_vector @@ q.strict_q
            LIMIT 1
         ), chosen AS (
           -- Resolved ONCE, then used for both the predicate and the ranking. Computing the CASE
           -- twice would let the two drift apart again, which is the whole defect: the filter and
           -- the score have to be about the same query.
           SELECT (CASE WHEN EXISTS (SELECT 1 FROM strict) THEN q.strict_q ELSE q.loose_q END) AS tsq
             FROM q
         )
         SELECT d.id, d.source_id, d.title, d.excerpt, d.folder, d.tags, d.updated_at,
                ts_rank_cd(d.search_vector, c.tsq) AS rank
           FROM docs d, chosen c
          WHERE d.workspace_id = $1
            AND d.deleted_at IS NULL
            AND ($3::text[] IS NULL OR d.source_id = ANY($3::text[]))
            AND d.search_vector @@ c.tsq
          -- Same reasoning as list: rank and timestamp can both tie, and without a unique final
          -- key two identical searches can disagree about the order of equally-good hits.
          ORDER BY rank DESC, d.updated_at DESC, d.id DESC
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

    async list(scope, options = {}) {
      const filter = scopeFilter(scope);
      const capped = Math.max(1, Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS));
      // Every non-integer is forced to 0 before it reaches SQL. All three cases are reachable by
      // hand-editing `?page=` in the address bar:
      //
      //   negative    -> Postgres rejects a negative OFFSET outright
      //   fractional  -> silently truncated, so the page quietly differs from the one requested
      //   NaN         -> `?page=abc` parses to NaN, and `Math.max(0, NaN)` is NaN, not 0. That
      //                  arrives as the literal string "NaN" and 500s the Library. The obvious
      //                  clamp does NOT cover this, which a test caught and review would not have.
      const requestedOffset = options.offset ?? 0;
      const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
      const sourceIds = filter.sourceIds;

      const { rows } = await db.query<{
        id: string;
        source_id: string;
        title: string;
        excerpt: string;
        folder: string;
        tags: string[];
        updated_at: Date | string;
      }>(
        `SELECT id, source_id, title, excerpt, folder, tags, updated_at
           FROM docs
          WHERE workspace_id = $1
            AND deleted_at IS NULL
            AND ($2::text[] IS NULL OR source_id = ANY($2::text[]))
            AND ($3::text IS NULL OR folder = $3::text)
          -- The id breaks the tie, and it is not decoration. 47 documents here share 30 timestamps,
          -- so ordering on updated_at alone leaves tied rows in whatever order the planner returns
          -- stable enough to look correct on one page, and wrong the moment OFFSET is involved.
          ORDER BY updated_at DESC, id DESC
          LIMIT $4 OFFSET $5`,
        [
          filter.workspaceId,
          sourceIds === undefined ? null : [...sourceIds],
          options.folder ?? null,
          capped,
          offset,
        ],
      );

      return rows.map((r) => ({
        id: r.id as DocId,
        sourceId: r.source_id as SourceId,
        title: r.title,
        excerpt: r.excerpt,
        folder: r.folder,
        tags: r.tags,
        updatedAt: new Date(r.updated_at).toISOString(),
        rank: 0,
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
          WHERE d.workspace_id = $1 AND d.id = $2 AND d.deleted_at IS NULL`,
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
