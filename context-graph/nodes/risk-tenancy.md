---
id: risk-tenancy
kind: risk
title: Tenancy and access scoping unresolved
status: done
owner: product
spec: docs/plan/04-risk-register.md
depends_on: []
---

Resolved by dec-tenancy (D9, ADR 0002). A Doc is scoped to a workspace, not a user or team.
Workspaces are flat; access is controlled through Scope and Grant. The separation of residency
and capability enables compile-time enforcement. See ADR 0002 for full design and consequences.
