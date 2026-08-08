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

**There is now exactly one way in per caller kind, and `localDevScope` is deleted** (M7 increment 2).
It minted a `Scope` from an environment variable — no credential, no verification, no revocation —
and was honestly labelled "not authentication" for its whole life. The labelling is precisely why it
had to be removed rather than kept: at a call site, a function that FABRICATES authority is
indistinguishable from one that CHECKS it, since both return a `Scope`. Which one a given line called
was a fact about that line, invisible to the type system and to a reviewer skimming. Every caller had
to be trusted rather than verified, and the one that eventually shipped would have looked like all
the others. Deleting it turns that class of mistake into a compile error.

Callers today: people via `scopeFromSession` ([[screen-login]]), agents and the local CLIs via
`scopeFromAgentToken` (`scripts/lib/cli-scope.mjs`, [[svc-mcp]]).

One documented exception: `scripts/db-setup.mjs` calls `mintScope` directly. It runs before any
principal exists — it is the statement that creates the schema — so it cannot present a credential.
It writes and deletes its own probe rows and touches nothing else.
