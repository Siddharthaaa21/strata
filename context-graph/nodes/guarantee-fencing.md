---
id: guarantee-fencing
kind: decision
title: Structural fencing guarantee for untrusted content
status: done
owner: core
spec: apps/mcp/src/fencing.test.ts:1
depends_on: [dec-untrusted-content]
---

Every ingested-derived field in an MCP response must either be declared in `untrustedFields` or confined to the nonce-delimited body envelope. The fencing.test.ts suite plants a marker in every content-derived input, drives every tool through a real MCP client, and asserts every marker occurrence lands in a declared untrusted field or inside the envelope. It fails for any future tool that returns a new ingested field without declaring it, preventing regressions like the getDoc metadata channel that independent review found.
