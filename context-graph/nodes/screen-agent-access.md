---
id: screen-agent-access
kind: screen
title: Agent Access
status: planned
owner: web
spec: docs/plan/02-milestones.md
depends_on: [svc-mcp, contract-source, comp-sidebar, dec-tenancy]
---

Not designed. The prototype's third nav item is labelled "Agent Access" but routes to the reader —
that is scaffolding, not a spec. The real screen manages MCP connections and per-agent scope.

`risk-tenancy` no longer blocks starting the design (`dec-tenancy`, ADR 0002): per-agent scope is a
`Grant` narrowing by `sourceIds` within a workspace. What is still open for this screen
specifically (ADR 0002's OPEN item 3): whether per-source narrowing is fine-grained enough, or
whether the UI needs a doc-id allow-list instead. Resolve that as part of designing this screen —
do not add fields to `Grant` speculatively before then.
