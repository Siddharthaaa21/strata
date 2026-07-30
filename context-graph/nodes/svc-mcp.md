---
id: svc-mcp
kind: service
title: MCP server
status: in-progress
owner: mcp
spec: .claude/skills/mcp-surface/SKILL.md
depends_on: [contract-doc, contract-scope, svc-search, dec-tenancy, risk-injection, dec-untrusted-content, dec-storage-search]
---

All three tools implemented in apps/mcp: search_docs, get_doc, list_sources. Handlers are pure
functions of (scope, store, input) so the security properties are testable without a transport;
server.ts is thin SDK wiring over them and is constructed with its stores and scope injected, which
is what lets an end-to-end test drive a real MCP client against PGlite.

Every tool re-checks scope itself, workspaceId and credentialRef never appear in a payload, and
NotFound is returned identically for out-of-scope and nonexistent so the error channel is not an
enumeration oracle. list_sources filters rather than asserts - throwing would itself disclose that
a hidden source exists. Bodies are fenced with a nonce envelope, search metadata structurally
(dec-untrusted-content). Still open: the strata-verifier pass that closes R2.
