---
id: svc-storage
kind: service
title: Storage
status: in-progress
owner: core
spec: docs/adr/0004-storage-and-search.md
depends_on: [contract-doc, dec-tenancy, contract-scope, dec-storage-search]
---

PostgreSQL, decided with search in one pass (dec-storage-search). Implemented in packages/storage:
schema, scope-filtered ranked query, and an upsert that honors ADR 0003's provisional-id rule — on
conflict the stored id wins, so a retry after a mid-persist crash converges instead of double-writing.

Tested against real Postgres 18 via PGlite (WASM, in-process) — the SQL under test is the SQL that
ships. Still open: connecting a live server (no Postgres in the dev environment yet) and retiring
the fixtures the screens currently read from.

Also backs list_sources: a sources table carrying its own workspaceId, since Source is returned
independently of any Doc and joining through docs would leak every connected account in a workspace
with no documents.
