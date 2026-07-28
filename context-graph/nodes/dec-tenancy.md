---
id: dec-tenancy
kind: decision
title: Workspace-scoped tenancy
status: done
owner: core
spec: docs/adr/0002-tenancy-workspace-scope.md
depends_on: [risk-tenancy]
---

Closes R1: a Doc is scoped to a workspace, not a user or team. Workspaces are flat and non-hierarchical. Tenancy is modeled as residency (workspaceId on the data) separate from capability (Grant on the caller). Scope and Visible<T> are brands, not compiler-enforced witnesses on their own — the actual backstop is a no-restricted-syntax ESLint rule banning casts to either outside mintScope/assertVisible/assertSourceVisible (see ADR 0002's Enforcement section, corrected after a strata-verifier pass found the original claim forgeable). Introduced Workspace, Membership, Principal, Grant, and Scope to packages/core.
