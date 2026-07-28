---
id: svc-mcp
kind: service
title: MCP server
status: planned
owner: mcp
spec: .claude/skills/mcp-surface/SKILL.md
depends_on: [contract-doc, svc-search, dec-tenancy, risk-injection]
---

The product's differentiator and its largest security surface, in that order. Read-only to start:
search_docs, get_doc, list_sources. Every tool re-checks scope itself via `Scope` and
`assertVisible`/`assertSourceVisible` (`dec-tenancy`, ADR 0002) — `scope` is an explicit handler
argument, never a tool-schema field. Tool signatures are a published interface — a rename breaks
agent workflows silently. Still blocked on `risk-injection`, which this decision narrows but does
not close.
