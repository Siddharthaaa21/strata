# Strata — AI Engineering Workspace

Strata turns scattered AI-generated Markdown (Claude research, Cursor plans, GitHub docs,
prompt recipes) into a searchable, structured engineering knowledge base — usable by humans
through the web app and by AI agents through an MCP server.

## Repo map

| Path | Owns |
| --- | --- |
| `apps/web` | Next.js app. The three handoff screens: Library, Import & Sources, Reader. |
| `apps/mcp` | MCP server. Exposes the vault to agents (`search_docs`, `get_doc`, `list_sources`). |
| `packages/core` | Domain types and contracts (`Doc`, `Source`, `ImportEvent`). The single source of truth for shapes. |
| `packages/ingest` | Connector adapters (Claude, Cursor, GitHub, local Markdown) + the normalizer. |
| `packages/tokens` | Design tokens transcribed from the handoff. Generated CSS + TS exports. |
| `design/handoff` | **Read-only reference.** Original design bundle. Never edit; never import from. |
| `docs/plan` | Milestones, data contracts, risk register, decision log. |
| `docs/adr` | Architecture decision records. |
| `context-graph` | Machine-readable map of the system. See "Context graph" below. |
| `.claude` | Agents, skills, commands, workflows. See `.claude/README.md`. |

## Non-negotiables

1. **`design/handoff/Vault.dc.html` is not source code.** It is a design-tool prototype using a
   templating DSL (`sc-if`, `sc-for`, `{{ }}`). Read it for structure, exact values, and
   interaction logic. Never port its markup or inline styles literally.
2. **Design values come from `packages/tokens`, never from memory and never hardcoded.**
   The handoff specifies exact OKLCH colors and non-round pixel sizes (17.5px, 12.5px,
   `oklch(88% 0.015 95)`). If a value you need is not in the token package, add it there
   first, citing the handoff line it came from.
3. **Types come from `packages/core`.** No screen defines its own `Doc` shape.
4. **The 860px breakpoint is the only breakpoint.** Mobile is `< 860px`. The prototype drives
   this from a JS `width` state; in the app it is a CSS media query (`--bp-mobile`).
5. **Placeholder copy in the handoff is placeholder.** Doc titles, connector names, "312 docs",
   "Priya Shah" — all wire to real data. Do not treat them as requirements.

## Commands

```
npm run dev          # web app on :3000
npm run build        # build all workspaces
npm run typecheck    # tsc --noEmit across workspaces
npm run lint
npm run test
npm run graph        # rebuild context-graph/graph.json from the node files
npm run verify       # typecheck + lint + test + graph — the gate before any commit
```

`npm run verify` is the definition of done for a code change. Run it, do not assume it.

## Context graph

`context-graph/nodes/*.md` is a hand-maintained graph of the system: screens, components, data
contracts, services, decisions, risks, milestones. Each node declares `depends_on` edges to
other node ids.

`depends_on` means **"read this before starting work here,"** not "blocked on this." Blocking
lives in a node's `status:` field (and authoritatively in `docs/plan/04-risk-register.md`'s
**BLOCKING** markers) and does not propagate along edges — `svc-ingest` depending on
`risk-injection` means "read R2 first," even while R2 stays open, because R2 blocks M6
specifically, not ingestion (see ADR 0003 / decision log D10 for a worked example of resolving
this ambiguity instead of guessing).

Use it to decide **what to read before starting work**, instead of grepping blindly:

```
npm run graph -- --subgraph screen-reader --depth 2
```

That prints the node's transitive dependencies and the `spec:` file/line each one points at.
Read those, and you have the full context for the task and nothing else.

When you add a screen, contract, service, or make a decision that constrains future work, add
or update its node in the same change. A stale graph is worse than no graph — `npm run verify`
fails on dangling edges.

## Working conventions

- Before implementing, check `docs/plan/02-milestones.md` for what phase we are in. Do not
  build ahead of the current milestone; the risks in `docs/plan/04-risk-register.md` are
  sequenced deliberately.
- Delegate by task class rather than doing everything in the main loop — see
  `.claude/skills/model-routing/SKILL.md` for the routing table.
- Every non-obvious choice that closes off an alternative goes in `docs/plan/05-decision-log.md`
  or, if it is structural, an ADR in `docs/adr/`.
- Never commit unless asked.
