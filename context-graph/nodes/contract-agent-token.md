---
id: contract-agent-token
kind: contract
title: Agent token format, storage, and verification
status: done
owner: core
spec: packages/auth/src/tokens.ts:1
depends_on: []
---

Agent tokens authenticate MCP clients. Format is `stra_at_<tokenId>_<secret>`: opaque bearer token with 256 bits of CSPRNG entropy in the secret. SHA-256 hash of the secret is stored (never the secret itself), verified by a single indexed lookup per request. Token parsing splits on the FIRST underscore after the prefix (base64url legitimately contains underscores).

One active `Grant` per `Principal` enforced by partial unique index; many tokens per principal allowed (rotation without gaps). Token is revoked, never deleted. Principal and grant and token created atomically via one data-modifying CTE so a principal never exists without a grant and a token.

`packages/auth` declares the `AuthStore` port (`lookupToken`); `packages/storage` implements it. Wrong-secret is indistinguishable from unknown-token by design (both return `AuthError` kind `unknown`). Revocation of token/principal/grant all trigger `AuthError` kind `revoked`. Expiry supported with injected clock.

**Round-four fix (HIGH, privilege escalation):** M7R4 found that `lookupToken` returned a `Grant` with the TOKEN row's `principal_id` instead of the GRANT row's, so the principal/grant check in `mintScope` compared a value with itself and could never fail. An `agent_tokens` row re-pointed at another principal's grant would silently inherit that grant's scope. Fixed two ways: (1) query now selects `g.principal_id` so `mintScope` performs a live check, and (2) composite FK `agent_tokens (workspace_id, grant_id, principal_id) REFERENCES grants (workspace_id, id, principal_id)` plus unique constraint prevents the bad row from being written in the first place. The FK is load-bearing: operator workflow revokes by deleting the grant then inserting a new one, leaving grant_id briefly dangling; the FK ensures the insert re-validates the (grant_id, principal_id) pair.
