---
id: svc-mcp
kind: service
title: MCP server
status: planned
owner: mcp
spec: .claude/skills/mcp-surface/SKILL.md
depends_on: [contract-doc, svc-search, risk-tenancy, risk-injection]
---

The product's differentiator and its largest security surface, in that order. Read-only to start:
search_docs, get_doc, list_sources. Every tool re-checks scope itself. Tool signatures are a
published interface — a rename breaks agent workflows silently.
