---
id: svc-search
kind: service
title: Search and retrieval
status: planned
owner: core
spec: docs/plan/04-risk-register.md
depends_on: [contract-doc, svc-storage, dec-storage-search]
---

Powers both the Library filter row and the MCP search_docs tool. Those are different problems —
humans scan and refine, agents get one shot at a ranked list. Design for the agent case; the UI
case is the easy subset.
