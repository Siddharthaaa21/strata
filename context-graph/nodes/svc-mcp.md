---
id: svc-mcp
kind: service
title: MCP server
status: in-progress
owner: mcp
spec: .claude/skills/mcp-surface/SKILL.md
depends_on: [contract-doc, contract-scope, svc-search, dec-tenancy, risk-injection, dec-untrusted-content, dec-storage-search, guarantee-fencing, dec-auth]
---

All three tools implemented in apps/mcp: search_docs, get_doc, list_sources. Handlers are pure
functions of (scope, store, input) so the security properties are testable without a transport;
server.ts is thin SDK wiring over them and is constructed with its stores and scope injected, which
is what lets an end-to-end test drive a real MCP client against PGlite.

Every tool re-checks scope itself, workspaceId and credentialRef never appear in a payload. `Unauthorized`
is distinguishable from `NotFound` (dec-auth §4: the oracle boundary is the vault, not the caller's
own credential—learning one's credential is bad does not enumerate the vault). NotFound is returned
identically for out-of-scope and nonexistent so the error channel is not an enumeration oracle over
doc ids. list_sources filters rather than asserts - throwing would itself disclose that a hidden source
exists. Bodies are fenced with a nonce envelope, search metadata structurally (dec-untrusted-content);
getDoc now fences title/folder/tags through fenceDoc(). An independent adversarial review (M4 close)
found that getDoc was returning those fields raw with no preamble and no untrustedFields declaration —
a live prompt-injection channel that is now closed. The guarantee-fencing node describes the structural
guard that prevents regression.

Dec-auth increment 1 (DONE): MCP server now authenticates all callers via `STRATA_AGENT_TOKEN` environment
variable. `ServerDeps.scope()` is async and called inside the try block, receiving Scope only after successful
authentication. `ReadonlyDocStore = Pick<DocStore, 'search'|'list'|'get'>` is now real (not planned), enforcing
at the type level that D5's "no mutating tool exists" cannot regress. Workspace is sourced from the verified
agent token, not from env. Still open: the strata-verifier pass that closes R2.
