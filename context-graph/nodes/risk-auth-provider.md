---
id: risk-auth-provider
kind: risk
title: Authentication and identity provider unchosen
status: done
owner: product
spec: docs/plan/04-risk-register.md
depends_on: []
---

Downstream of R1 (tenancy). Cheap once tenancy is decided, but cannot be decided before it—
starting here would be doing the easy half of a hard decision. Resolved by dec-auth (D14, ADR 0006).

**Design closed:** Human sessions are bought from Supabase Auth (the Postgres this runs on already).
Agent tokens are built in-house—no provider's scope model is `Grant.sourceIds` over our `Source` rows.
Authorization never moves to the provider; the provider's subject id is never a `PrincipalId`—both
rules exist so a provider swap costs one table instead of every foreign key.

**Increment 0 (DONE):** Grant.sourceIds now gates all nine store methods, held complete by
`grant-completeness.test.ts`.

**Increments 1-3 open:** agent tokens on stdio, human sessions, Agent Access screen + access log.
