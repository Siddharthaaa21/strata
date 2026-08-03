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

**Increments 0-1 (DONE):** Increment 0: Grant.sourceIds now gates all nine store methods, held complete
by `grant-completeness.test.ts`. Increment 1: Agent tokens on stdio, MCP server authenticated, bootstrap scripts,
auth tables and AuthStore implementation.

**Stdio tokens caveat:** Over stdio, a token buys attribution, narrowing (per-agent Grant.sourceIds), and revocation,
but NOT confidentiality—anyone who can launch the server can read `.env` and reach Postgres directly. When remote
HTTP transport arrives, token confidentiality is protected by TLS + rate limiting, but the signature of `scopeFromAgentToken`
does not change.

**Increments 2-3 open:** human sessions with Supabase Auth, Agent Access screen + access log.
