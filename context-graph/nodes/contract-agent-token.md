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
