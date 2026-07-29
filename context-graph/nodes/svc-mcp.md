---
id: svc-mcp
kind: service
title: MCP server
status: in-progress
owner: mcp
spec: .claude/skills/mcp-surface/SKILL.md
depends_on: [contract-doc, contract-scope, svc-search, dec-tenancy, risk-injection, dec-untrusted-content, dec-storage-search]
---

Read-only surface: search_docs and get_doc are implemented in apps/mcp/src/tools.ts as pure
handlers, testable without a transport. Every tool re-checks scope itself rather than trusting a
caller or middleware, workspaceId never appears in a payload, and both NotFound and out-of-scope
collapse to one indistinguishable error so the error channel is not an enumeration oracle.

Bodies are fenced with a nonce envelope and search metadata structurally as JSON (dec-untrusted-content).
Still open: list_sources needs a sources table that svc-storage does not have yet; transport wiring
and a red-team pass wait on a live database.
