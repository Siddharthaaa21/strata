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

The enumeration is the load-bearing part, and it is the second version of this file. The first hardcoded `search_docs` and `get_doc`; a reviewer added a third tool returning raw body, title, folder and tags and the suite passed 5/5. The generalization claim is now verified rather than asserted: adding a leaking tool makes the suite fail naming the exact field. See D14 — a claim about what a test would catch is itself testable.

A response carrying no ingested content (today, `list_sources`) satisfies the invariant trivially and is not required to declare anything. Open gap, recorded not papered over: if a connector ever writes a remote-supplied source name, `list_sources` becomes a content channel with no fence and no marker planted here to catch it.
