---
id: dec-untrusted-content
kind: decision
title: Untrusted content typing, normalization, and fencing
status: done
owner: core
spec: docs/adr/0005-untrusted-content.md
depends_on: [risk-injection, contract-doc, svc-ingest]
---

Closes R2's design half. Every string derived from ingested content is Untrusted<T>, discharged only
by fence/forDisplay - the same witness pattern as Visible<T>, with the same limitation and the same
no-restricted-syntax backstop.

Fencing depends on the channel: bodies get a nonce-delimited envelope whose nonce is random per
response and stripped from the content, so content cannot forge its own closing delimiter. Search
metadata is fenced structurally as JSON with one preamble per response, which closes the gap D10
surfaced - a document titled as an instruction.

Normalization now queries the Unicode database instead of enumerating a hand-written list. Three review rounds found the same mistake: `packages/core/src/untrusted.ts` defines stripping via `\p{Default_Ignorable_Code_Point}\p{Bidi_Control}` plus explicitly-justified ranges (C0/C1 controls, U+2028/2029 for JSON fencing structural reason, U+FFF9-FFFB for interlinear annotation). Covers ~4,174 codepoints vs the previous 26-entry list. Round one added the Tag block; round two added variation selectors; round three found 3,737 survivors including U+E0080-E00FF—a contiguous printable-ASCII block sitting in the gap between where rounds one and two had each stopped. The lesson encoded: query the database, do not enumerate. A future Unicode revision is covered when the runtime updates, with no edit. Protects the human reviewer, not the model: bidi controls let the Library render one thing while the agent reads another. R2 does not fully close here - the risk register also requires a strata-verifier pass over the real MCP tools.
