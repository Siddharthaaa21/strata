# ADR 0004 — Storage and retrieval

**Status:** accepted · **Date:** 2026-07-29 · **Log entry:** D11 · **Closes:** R4, R6 · **Scope:** M4

## Context

R6 says decide storage and search in one pass, because picking a store before deciding retrieval
is how you end up running a second system for search six weeks later. This ADR does both.

Three constraints are already committed and are not reopened here:

1. **ADR 0002** — every persisted entity carries `workspaceId`. `scopeFilter(scope)` yields
   `{ workspaceId, sourceIds? }`, and that is the only legitimate way to narrow a query.
2. **ADR 0003** — persist must upsert on `(workspaceId, sourceId, externalId)` and treat the
   `DocId` ingestion mints as a proposal, not an assertion: a crash mid-persist plus a retry must
   not double-write.
3. **`contract-doc`** — body is separable from metadata. Every retrieval path must be able to
   return metadata without the body. This is a hard requirement, not an optimization.

R4 sets the design target: **an agent gets one shot at a ranked list and acts on it**, where a
human scans twenty results and refines. Design for the agent; the UI case is its subset.

## Decision

**Postgres is the only datastore.** Full-text retrieval via native `tsvector`/`ts_rank_cd`.
No separate search service, no second system to keep in sync.

**Two tables, splitting hot metadata from cold body:**

```
docs         workspace_id, id, source_id, external_id, content_hash,
             title, excerpt, folder, tags, provenance columns,
             created_at, updated_at, search_vector tsvector
doc_bodies   doc_id -> body text
```

The split is required by the contract, not chosen for performance. A body column in `docs` means
every search touches TOASTed text it will not return.

**Upsert honors ADR 0003 exactly:**

```sql
INSERT INTO docs (...) VALUES (...)
ON CONFLICT (workspace_id, source_id, external_id) DO UPDATE SET ...
RETURNING id
```

The ingest-minted `DocId` is used only on insert. On conflict the **existing** id wins and is
returned, which is what makes the id provisional rather than asserted. Retry after a mid-persist
crash converges instead of double-writing.

**Scope is a WHERE clause, never a post-filter.** `scopeFilter()`'s output is applied inside the
ranking query, and the primary index leads with `workspace_id`:

```
INDEX docs_scope_search ON docs (workspace_id, source_id) INCLUDE (updated_at)
INDEX docs_fts          ON docs USING GIN (search_vector)
```

Filtering after ranking is both the canonical tenancy leak and a ranking bug: rank-then-filter
starves a small workspace, because the top-N is drawn from the whole corpus before scoping.

**Ranking, weighted for the agent case:**

| Weight | Field | Why |
| --- | --- | --- |
| A | `title` | The one field an agent can judge relevance from without reading anything. |
| B | `tags` where `provenance IN ('user','source')` | Authored. A human filed this deliberately. |
| C | `excerpt`, `folder` | Derived but cheap and usually right. |
| D | `tags` where `provenance = 'model'`, body text | Guessed, or long. |

**Provenance-weighted tags are the substantive part of this design.** `Derived<T>` already carries
provenance for the re-sync-safety reason in `03-data-contracts.md`; ranking is the second thing it
buys. A curated tag and a guessed one are not equally strong relevance evidence, and flattening
them into one `tsvector` weight throws away information the contract went out of its way to keep.

**Recency is a tiebreaker only**, never a primary signal. `updatedAt` comes from filesystem mtime
(ADR 0003), which is influenced by whoever writes the file. Bounding it to tie-breaking bounds
that influence.

**Result shape:** `search_docs` returns metadata plus excerpt, hard-capped server-side. The cap is
the tool's own limit clamped to a maximum, not the caller's `limit` parameter honored as given.

## Rationale

1. **One system.** Postgres gives transactional upsert, workspace filtering, and full-text ranking
   in the same query. That is R6's entire requirement, satisfied by not adding anything.
2. **Corpus size does not justify more.** A small engineering team's AI-generated Markdown is
   hundreds to low tens of thousands of documents per workspace. Native FTS is comfortable well
   past that; reaching for a search cluster now buys latency headroom nobody needs and a
   synchronization bug surface everybody gets.
3. **Semantic search is deliberately deferred, and the seam is designed.** Adding `pgvector` later
   is additive: one column, one index, one term in the rank expression. Doing it *now* would put
   an embedding-model call inside the ingest path — which D10 explicitly avoided keeping out of
   M5 ("no LLM call anywhere in the path"), and which turns R2 from an M6 problem into an M5 one.
4. **The metadata channel stays as narrow as ADR 0002 left it.** Ranking reads `title`, `excerpt`,
   `tags`, `folder` — all derived from untrusted content. This ADR does not widen that exposure,
   but it does not close it either; see Open.

## Rejected

| Alternative | Why not |
| --- | --- |
| Elasticsearch / Typesense / Meilisearch | A second system to operate, and a sync path that can silently drift from Postgres. Exactly what R6 names. |
| SQLite + FTS5 | Genuinely good, and wrong here: workspace tenancy plus concurrent ingest writes plus a hosted MCP server all want a real server. Migrating later is a rewrite of every query. |
| pgvector / hybrid ranking now | Requires an embedding call per document in the ingest path, pulling R2 forward into M5 and adding per-doc model cost before anyone has asked for semantic recall. Seam designed, decision deferred. |
| Rank first, filter by scope after | Tenancy leak, and it starves small workspaces. Non-negotiable. |
| Single `docs` table with a body column | Violates the body-separability requirement in `contract-doc`; makes every metadata query pay for text it will not return. |
| Flatten tags to one FTS weight | Discards the provenance distinction the contract deliberately preserves — a curated tag and a guessed one are not equal evidence. |
| Recency as a primary ranking signal | `updatedAt` derives from mtime, which the writer influences. Fine as a tiebreaker; a lever if it ranks. |
| Honor the caller's `limit` verbatim | An unbounded `limit` from an MCP client is a cheap way to pull an entire workspace in one call. |

## Migration risk

**Low now, medium once real data exists.**

Additive and safe later: `pgvector`, new ranking weights (a reindex), new derived columns.

Expensive later: the `(workspace_id, source_id, external_id)` uniqueness constraint, which is
inherited from ADR 0003 rather than chosen here — changing it orphans every stored row. The
hot/cold table split is also structural; merging or splitting further is a data migration.

Nothing in `packages/core`, no MCP tool signature, and no screen changes as a result of this ADR.

## Open

1. **Deletion and tombstones.** ADR 0003 left renames destructive and deletes unmodeled. Storage
   is where a tombstone would live, but the semantics ("a source no longer offers this doc" vs "a
   user deleted it") are a product question. Routed to R5.
2. **R2's metadata channel, still.** `search_docs` returns `title`/`excerpt`/`tags`, all derived
   from untrusted content — a document *titled* as an instruction is not covered by "fence the
   returned content as data." Unchanged by this ADR; still routed to the injection ADR that gates
   M6.
3. **Corpus statistics are shared within a workspace.** FTS ranking uses corpus-wide term
   statistics, so a document influences how other documents rank. Bounded by tenancy — the blast
   radius is one workspace, which is a property ADR 0002 already bought — but it is not zero, and
   it is worth stating rather than discovering.
4. **Hosting, pooling, migrations tooling.** Deliberately not decided here. This ADR fixes the
   data model and the query shape, not the operational stack.
5. **Where a failed import surfaces.** Carried out of M3: failed `ImportEvent`s are excluded from
   Recent Imports because that list has no status indicator, but ADR 0003 requires failures not be
   silent. The real-data pass on the Import screen is this milestone's job and must answer it.
