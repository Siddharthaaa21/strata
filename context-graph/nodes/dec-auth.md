---
id: dec-auth
kind: decision
title: Authentication—agent tokens, human sessions, and completing the grant
status: in-progress
owner: core
spec: docs/adr/0006-authentication.md
depends_on: [risk-auth-provider, dec-tenancy, contract-scope]
---

Closes R7 (design half); resolves ADR 0002 open items 2, 3, 4 and ADR 0003 open item 3.

**Increment 0 (DONE):** Grant.sourceIds now gates all nine store methods—`docs.search`, `docs.list`,
`docs.get`, `docs.upsert`, `docs.findKnown`, `sources.list`, `sources.upsert`, `events.append`,
`events.recent`. Completeness is held by `packages/storage/src/grant-completeness.test.ts`, which
enumerates the live store surface and fails loudly on any method with no declared narrowing behavior.
This resolves ADR 0003 open item 3 (sourceIds gates writes as well as reads, closing the write-only
injection channel). No schema changes, no signature changes, no UI.

**Increment 1 (DONE):** Agent tokens on stdio with tables, scopeFromAgentToken, bootstrap. Token format
`stra_at_<tokenId>_<secret>`, verified by SHA-256 lookup of secret (never stored). AuthStore port declared
in packages/auth, implemented in packages/storage with lookupToken (one indexed query) and createAgent (one
data-modifying CTE). Principal + grant + token created atomically; one active grant per principal enforced by
partial unique index. Scope minted from a verified token, no caching. MCP server now requires STRATA_AGENT_TOKEN,
rejects unauthenticated clients with Unauthorized (not NotFound). ReadonlyDocStore enforces D5 structurally: MCP
server cannot upsert by type.

**Increment 1.5 (M7R3):** Revocation error taxonomy. `mintScope` previously threw a bare Error on grant revocation, falling through the MCP server's catch to InternalError and making revocation indistinguishable from bugs in operator logs. Translated to `AuthError('revoked')` so the third revocation lever (grant revocation) is now distinguishable from the other two (token and principal revocation) and operators see the message meant for bugs. See `packages/auth/src/index.ts`.

**Increment 1.75 (M7R4 — HIGH, privilege escalation):** `lookupToken` returned a `Grant` with the TOKEN row's `principal_id` instead of the GRANT row's, so the principal/grant check in `mintScope` compared a value with itself and could never fail. An `agent_tokens` row re-pointed at another principal's grant would silently inherit that grant's scope — a narrowed agent widened to the entire workspace by editing one column. Fixed two ways: (1) query now selects `g.principal_id` so `mintScope` performs a live check, and (2) composite FK `agent_tokens (workspace_id, grant_id, principal_id) REFERENCES grants (workspace_id, id, principal_id)` plus unique constraint prevents the bad write in the first place. The FK is load-bearing because the operator workflow revokes by deleting the grant then inserting a new one, leaving grant_id briefly dangling; the FK ensures the insert re-validates the (grant_id, principal_id) pair. See `packages/storage/src/auth-store.ts` and `packages/storage/src/index.ts`.

**Increment 2 (IN PROGRESS):** Membership, sessions, and user identity mapping. New `memberships` table (keyed on lower-cased email, `principal_id` filled on first sign-in per ADR 0006 §6b) and `user_identities` table (provider subject id, kept OUT of PrincipalId per ADR 0006 §5 rule 1). `resolveSession(claims: SessionClaims)` on AuthStore, gated on membership. `scopeFromSession(claims)` in Authenticator, failing `'no-membership'` if unlisted. `addMember`, `removeMember`, `listMembers` on AuthStore port; removeMember revokes person and all their agents and tokens atomically (a prior test passed for the wrong reason: it checked the session, never the token). Member management via `npm run member -- <list|add|remove> [email]`. Still open: provider integration (Supabase Auth) and `vault()` async on ServerDeps. Both are blocked on risk-auth-provider.

**Increment 3 (OPEN):** Agent Access screen + access log. The no-cache rule is tied to the Agent Access screen's copy
(immediate revocation), and that rule outlives this decision. Max legitimate cache TTL = the revocation
latency the UI promises.

**Key properties held by design:**
- One active Grant per principal (partial unique index); many tokens per principal (rotation without gaps)
- Verification is per-request, one indexed lookup (SHA-256 of secret stored, never the secret itself)
- Unauthorized distinguishable from NotFound (the oracle boundary is the vault, not the caller's own credential)
- Source.credentialRef (outbound) and AgentToken (inbound) never unified in type, table, tool, or screen
- Provider swappable by two rules: provider subject id is never a PrincipalId; authorization never delegated to provider
