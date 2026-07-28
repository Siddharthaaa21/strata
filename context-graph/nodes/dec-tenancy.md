---
id: dec-tenancy
kind: decision
title: Workspace-scoped tenancy
status: done
owner: core
spec: docs/adr/0002-tenancy-workspace-scope.md
depends_on: [risk-tenancy]
---

Closes R1: a Doc is scoped to a workspace, not a user or team. Workspaces are flat and non-hierarchical. Tenancy is modeled as residency (workspaceId on the data) separate from capability (Grant on the caller). Enforced at compile time with Scope and Visible<T> types. Introduced Workspace, Membership, Principal, Grant, and Scope to packages/core.
