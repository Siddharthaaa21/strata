---
id: contract-doc
kind: contract
title: Doc
status: planned
owner: core
spec: docs/plan/03-data-contracts.md
depends_on: [risk-tenancy]
---

The central domain shape. Every field must serve retrieval (can an agent judge relevance from
metadata alone?) or provenance (where did this come from, was it derived or authored?). Body must
be fetchable separately from metadata — that requirement is what makes agent retrieval cheap.
