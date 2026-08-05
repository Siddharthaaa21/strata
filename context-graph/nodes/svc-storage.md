---
id: svc-storage
kind: service
title: Storage
status: in-progress
owner: core
spec: docs/adr/0004-storage-and-search.md
depends_on: [contract-doc, dec-tenancy, contract-scope, dec-storage-search, guarantee-storage-atomicity, dec-auth, guarantee-grant-completeness]
---

PostgreSQL, decided with search in one pass (dec-storage-search). Implemented in packages/storage:
schema, scope-filtered ranked query, and an upsert that is now ONE data-modifying CTE writing docs
and doc_bodies together (M4 fix). It was two unwrapped queries, so a crash between them left a
permanently bodyless document that was searchable but unreadable, and that a retry reported as
unchanged and never repaired. The guarantee-storage-atomicity node describes this property. Honors
ADR 0003's provisional-id rule — on conflict the stored id wins, so a retry after a mid-persist
crash converges instead of double-writing. Also: credential_ref now updates through COALESCE, so
an upsert omitting it cannot erase a stored credential (M4 fix).

All nine store methods now enforce Grant.sourceIds for both reads and writes (dec-auth, increment 0).
Previously four methods ignored sourceIds narrowing on writes, creating a write-only injection channel
into sources a principal cannot read. Now: docs.upsert, docs.findKnown, sources.upsert, events.append,
events.recent all enforce the same grant boundary as docs.search/list/get and sources.list. Completeness
is held by guarantee-grant-completeness: an enumerating test that fails loudly on any store method with
no declared narrowing behavior, catching new methods tomorrow without editing the test.

Dec-auth increment 2 (IN PROGRESS): New `memberships` and `user_identities` tables support human sessions.
`memberships` keyed on lower-cased email with `principal_id` filled on first sign-in (ADR 0006 §6b).
`user_identities` holds the provider's subject id, kept OUT of PrincipalId (ADR 0006 §5 rule 1) so a
provider swap rewrites one table. AuthStore.resolveSession, addMember, removeMember, listMembers
implemented in auth-store.ts. removeMember revokes person, all agents they created, and those agents'
tokens atomically — a prior test failure: it checked session but never verified the token was actually
revoked. addMember is restorative: remove-then-re-add round-trips membership, principal, and grant.

Two new aggregate methods added to fix Library truncation: `count(scope, {folder?})` returns the true
vault total, not the clamped page; `folders(scope)` returns every distinct folder in scope. Both apply
the full scope filter (workspace AND Grant.sourceIds) in the WHERE clause, so they see past MAX_RESULTS
but respect the grant boundary. Held complete by guarantee-grant-completeness with value assertions
(a non-zero count discloses an out-of-grant doc as surely as returning it).

Dec-auth increment 1 (DONE): New tables `principals`, `grants`, `agent_tokens` hold agent authentication state.
Principal + grant + token created atomically via one data-modifying CTE (createAgent). Grants carry `source_ids`
NULL (all sources) or '{}' (deny-all) or a set of source ids; partial unique index enforces at most one ACTIVE
grant per principal. AuthStore implementation: lookupToken is ONE indexed query (token → principal → grant);
touchToken rate-limited to once per minute. ReadonlySourceStore and ReadonlyDocStore types exported so MCP server
can depend only on read operations by type.

M7R4 (HIGH privilege escalation + MED timestamp handling): `lookupToken` query now selects `g.principal_id` instead of the TOKEN row's `principal_id`, so `mintScope`'s check performs a live validation that cannot be bypassed by re-pointing an `agent_tokens` row to another principal's grant. Composite FK `agent_tokens (workspace_id, grant_id, principal_id) REFERENCES grants (workspace_id, id, principal_id)` plus unique constraint prevents the bad row from being written. The FK is load-bearing because revoke-then-insert to re-scope an agent leaves grant_id dangling; the FK ensures the insert re-validates the pair. Also: Postgres `infinity`/`-infinity` expiry now fails closed as expired instead of throwing RangeError on `new Date(v).toISOString()`, collapsing to `Unauthorized` rather than leaking `InternalError`.

New `external_id` column on `import_events` table, populated by `runIngest` on every event. Migration uses
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` because `CREATE TABLE IF NOT EXISTS` is a no-op on an existing
database — the live database would otherwise never get the column. This pattern generalizes: tests always start
from empty schema, so a missing migration passes every test and fails only on the database that matters. Lesson:
verify additive migrations land on the live system, not just test fixtures.

Tested against real Postgres 18 via PGlite (WASM, in-process) — the SQL under test is the SQL that
ships. Still open: connecting a live server (no Postgres in the dev environment yet) and retiring
the fixtures the screens currently read from.

Also backs list_sources: a sources table carrying its own workspaceId, since Source is returned
independently of any Doc and joining through docs would leak every connected account in a workspace
with no documents.

M6 access log: new `access_log` table (workspace, principal, tool, outcome, doc_ids, result_hash, occurred_at), indexed by workspace+time and principal+time. Stores a SHA-256 of each response and never the response itself — a log holding the payload is a second copy of the problem it exists to detect. Nothing prunes it yet; retention is open.
