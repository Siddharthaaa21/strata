# ADR 0001 — Frontend stack

**Status:** accepted · **Date:** 2026-07-28 · **Log entry:** D1

## Context

`design/handoff/README.md:7` says to recreate the designs "in the target codebase's existing
environment ... using its established component patterns and libraries. If no frontend framework
exists yet, choose the most appropriate one."

There was no target codebase — the bundle was a README and an HTML prototype.

The choice is constrained by more than the three screens. This repo also needs to host ingestion
workers, OAuth callbacks for four connectors, and an MCP server. A purely client-side choice
defers a backend decision that is due almost immediately.

## Decision

**Next.js (App Router) + TypeScript**, with design tokens as CSS custom properties generated from
`packages/tokens`.

Structured as an npm workspaces monorepo: `apps/web`, `apps/mcp`, `packages/{core,ingest,tokens}`.

## Rationale

- **A server runtime is required regardless.** OAuth callbacks, scheduled syncs, and the MCP host
  all need one. Choosing a client-only stack means choosing a second stack within weeks.
- **Routing for three screens, free.** The prototype fakes routing with a `screen` state value.
  Real routes come with the framework.
- **The handoff is component-shaped.** Sidebar, doc card, connector row, pill filter. It maps to
  components in any modern framework, so ecosystem fit for the *rest* of the system is the
  deciding factor — and that favors the one with the server.
- **Tokens as CSS custom properties, not a styling framework.** The handoff specifies exact,
  non-round values. Arbitrary-value utility classes for `17.5px` and `oklch(89% 0.015 95)` are
  strictly worse than named tokens, and a token package is consumable by any future surface.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Vite + React SPA | Needs a separate backend service immediately, splitting the repo and the deploy story for no gain. |
| Vue / Svelte | No disadvantage for this UI. Smaller ecosystem for MCP and agent tooling, which is where the hard work is. |
| Static site + external API | Ingestion and OAuth cannot live in a static host. |
| Tailwind as the token layer | Workable, but the handoff's non-round values become arbitrary-value classes everywhere, and the tokens stop being consumable outside the web app. |
| Porting `Vault.dc.html` directly | It is a design-tool DSL (`sc-if`, `sc-for`, `DCLogic`), not portable markup. Not an option, though it looks like one. |

## Consequences

- Components stay portable; routing and data fetching do not. Reversing this is moderate, not
  cheap.
- `packages/tokens` becomes the enforcement point for design fidelity, backed by the `post-edit`
  hook that blocks raw `oklch()` elsewhere (D3).
- The 860px breakpoint becomes a CSS media query, not the prototype's JS width measurement —
  explicitly sanctioned by `design/handoff/README.md:38`.
- No styling framework is a standing decision. Adding one later needs a new ADR.
