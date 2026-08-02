---
id: svc-storage
kind: service
title: Storage
status: in-progress
owner: core
spec: docs/adr/0004-storage-and-search.md
depends_on: [contract-doc, dec-tenancy, contract-scope, dec-storage-search, guarantee-storage-atomicity]
---

PostgreSQL, decided with search in one pass (dec-storage-search). Implemented in packages/storage:
schema, scope-filtered ranked query, and an upsert that is now ONE data-modifying CTE writing docs
and doc_bodies together (M4 fix). It was two unwrapped queries, so a crash between them left a
permanently bodyless document that was searchable but unreadable, and that a retry reported as
unchanged and never repaired. The guarantee-storage-atomicity node describes this property. Honors
ADR 0003's provisional-id rule — on conflict the stored id wins, so a retry after a mid-persist
crash converges instead of double-writing. Also: credential_ref now updates through COALESCE, so
an upsert omitting it cannot erase a stored credential (M4 fix).

Tested against real Postgres 18 via PGlite (WASM, in-process) — the SQL under test is the SQL that
ships. Still open: connecting a live server (no Postgres in the dev environment yet) and retiring
the fixtures the screens currently read from.

Also backs list_sources: a sources table carrying its own workspaceId, since Source is returned
independently of any Doc and joining through docs would leak every connected account in a workspace
with no documents.
