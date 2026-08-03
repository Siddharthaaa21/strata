---
id: guarantee-fencing
kind: decision
title: Structural fencing guarantee for untrusted content
status: done
owner: core
spec: apps/mcp/src/fencing.test.ts:1
depends_on: [dec-untrusted-content]
---

Every ingested-derived field in an MCP response must either be declared in `untrustedFields` or confined to the nonce-delimited body envelope.

`fencing.test.ts` plants a distinct marker in every content-derived input, then **enumerates `tools/list`** and derives each call's arguments from that tool's own `inputSchema` — so it exercises the surface the server actually advertises, not a list the test author remembered. Every marker occurrence must land in a declared untrusted field or inside the envelope.

Round-three review found the guard inspecting only the first `content` entry via `content[0]`, never examining `structuredContent`, silently skipping non-JSON payloads, and whitelisting ANY `content` key whether fenced or not. Four different tool shapes walked past it. The fix now examines all content entries, `structuredContent`, raw strings when not JSON, and counts `content` as safe only inside a matched nonce envelope. A marker is also planted in the FILE PATH — the one channel that had never carried a marker before. The four pre-existing bypasses are closed.

The enumeration is the load-bearing part, verified by injecting a leaking tool: the suite now fails naming the exact field. See D14 — a claim about what a test would catch is itself testable.

A response carrying no ingested content (today, `list_sources`) satisfies the invariant trivially and is not required to declare anything. Open gap, recorded not papered over: if a connector ever writes a remote-supplied source name, `list_sources` becomes a content channel with no fence and no marker planted here to catch it.
