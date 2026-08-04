---
id: contract-scope
kind: contract
title: Scope, Grant, and the access-control primitives
status: done
owner: core
spec: packages/core/src/index.ts
depends_on: [dec-tenancy, contract-agent-token]
---

The enforcement primitives that implement `dec-tenancy`: `Workspace`, `Membership`, `Principal`,
`Grant` (capability, narrows only, `sourceIds` the sole narrowing dimension for both reads and
writes), `Scope` (proof of an authenticated, resolved grant — minted only by `mintScope` in
`packages/core/src/scope-internal.ts`), `scopeFilter`, `isVisible`, `assertVisible`, `assertSourceVisible`,
and `Visible<T>`.

`Scope`/`Visible<T>` are brands, not runtime-checked witnesses — a bare cast compiles. The actual
enforcement is a `no-restricted-syntax` ESLint rule (`eslint.config.mjs`) restricting construction
to `index.ts` and `scope-internal.ts`, checked on every `npm run verify`. Scope is minted from verified
credentials via `scopeFromAgentToken` (agent token) or `scopeFromSession` (human session); no caching
and no verification cache, so every call verifies freshly (the token may be revoked, the person may be
removed from membership, mid-request). Anything that reads a store or builds an MCP payload depends on
this node, not just on `contract-doc`.
