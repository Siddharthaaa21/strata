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

**Increments 2-3 (OPEN):** 2 = human sessions with Supabase Auth, user_identities table, vault() async, delete localDevScope;
3 = Agent Access screen + access log. The no-cache rule is tied to the Agent Access screen's copy
(immediate revocation), and that rule outlives this decision. Max legitimate cache TTL = the revocation
latency the UI promises.

**Key properties held by design:**
- One active Grant per principal (partial unique index); many tokens per principal (rotation without gaps)
- Verification is per-request, one indexed lookup (SHA-256 of secret stored, never the secret itself)
- Unauthorized distinguishable from NotFound (the oracle boundary is the vault, not the caller's own credential)
- Source.credentialRef (outbound) and AgentToken (inbound) never unified in type, table, tool, or screen
- Provider swappable by two rules: provider subject id is never a PrincipalId; authorization never delegated to provider
