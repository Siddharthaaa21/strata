---
id: dec-stack
kind: decision
title: Frontend stack
status: done
owner: web
spec: docs/adr/0001-frontend-stack.md
depends_on: []
---

Next.js App Router + TypeScript, tokens as CSS custom properties. Chosen because the handoff is
component-shaped and framework-agnostic, and the repo needs a server runtime anyway for ingestion
and the MCP host. Read the ADR before adding a styling dependency.
