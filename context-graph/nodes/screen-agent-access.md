---
id: screen-agent-access
kind: screen
title: Agent Access
status: planned
owner: web
spec: docs/plan/02-milestones.md
depends_on: [svc-mcp, contract-source, comp-sidebar, dec-tenancy, contract-scope, dec-auth]
---

Not designed. The prototype's third nav item is labelled "Agent Access" but routes to the reader —
that is scaffolding, not a spec. The real screen manages MCP connections and per-agent scope,
access log, and revocation.

Member management ships as a CLI (`npm run member -- <list|add|remove> [email]`), not a screen, because
increment 3 has no design (ADR 0006 §6b). The audience is a small team sharing one workspace; the operator
workflow is more important than a UI invented under deadline.

`dec-tenancy` (R1) no longer blocks design: per-agent scope is a `Grant` narrowing by `sourceIds`
within a workspace. `dec-auth` (R7) resolves the design-blocking question (ADR 0002 OPEN item 3):
per-source narrowing is confirmed sufficient for M7 — doc-id allow-lists are rejected (invalid on
each ingest run, unbounded, no operable UI). The constraint that closes design is the revocation
promise: the Agent Access screen's copy sets the maximum legitimate Scope cache TTL (if it says
immediate, the TTL is zero). Designed as part of dec-auth increment 3, not before.

The access log this screen needs now exists as a data source (`AccessLog.recent`, guarantee-access-log), so increment 3 no longer has to design the table and the screen together. The screen itself still has no handoff design.
