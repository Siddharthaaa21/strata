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

Normalization strips bidi and zero-width characters at ingest. That protects the human reviewer, not
the model: bidi controls let the Library render one thing while the agent reads another. R2 does not
fully close here - the risk register also requires a strata-verifier pass over the real MCP tools.
