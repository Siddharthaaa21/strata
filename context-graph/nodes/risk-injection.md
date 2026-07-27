---
id: risk-injection
kind: risk
title: Prompt injection via ingested content
status: blocked
owner: product
spec: docs/plan/04-risk-register.md
depends_on: []
---

Strata's entire corpus is model-generated prose, served back to models over MCP. Ingested content
is untrusted input that will be read as text by an agent. Mitigation strategy must be settled
before any mutating MCP tool exists.
