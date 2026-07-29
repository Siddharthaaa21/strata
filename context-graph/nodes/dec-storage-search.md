---
id: dec-storage-search
kind: decision
title: Postgres storage with native full-text retrieval
status: done
owner: core
spec: docs/adr/0004-storage-and-search.md
depends_on: [contract-doc, contract-scope, dec-tenancy]
---

Closes R4 and R6 together, as R6 required. Postgres is the only datastore; retrieval is native
tsvector/ts_rank_cd, with no second search system to keep in sync. Docs split into hot metadata and
a cold body table because contract-doc requires metadata-only retrieval, not for performance.

Ranking is weighted for the agent case: title (A) > authored tags (B) > excerpt/folder (C) >
model-provenance tags and body (D). Provenance-weighted tags are the substantive part — Derived<T>
carries provenance for re-sync safety, and ranking is the second thing that buys. Recency is a
tiebreaker only, since updatedAt derives from mtime and is writer-influenced.

Scope is applied as a WHERE clause inside the ranking query, never as a post-filter: rank-then-filter
both leaks across workspaces and starves small ones. pgvector is deliberately deferred with the seam
designed — adding it now would put an embedding call in the ingest path and pull R2 forward into M5.
