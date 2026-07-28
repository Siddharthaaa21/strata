# Milestones

Sequenced by **risk retired per unit of work**, not by what is easiest to start. The three screens
are the best-specified work in the repo, which is an argument for building them once the shapes
underneath them are settled — not first.

Run `/next-task` to get the next item with its context loaded.

---

## M0 — Foundation `in progress`

Make the loop trustworthy before anything depends on it.

- [x] Repo structure, workspaces, TypeScript config
- [x] `.claude` setup: agents, skills, commands, workflows, hooks
- [x] Context graph + integrity check wired into `npm run verify`
- [x] `packages/tokens` — every handoff value transcribed, each with a citation
- [x] `apps/web` Next.js app boots, renders tokens, no screens yet
- [x] Lint config (deliberately deferred from initial scaffold — nothing to lint yet)
- [x] CI running `npm run verify` on push

**Done when** `npm run verify` is green, meaningful, and runs on every push.

---

## M1 — Contracts and blocking risks `next`

The two open risks below determine the `Doc` shape. Everything downstream is speculative until
they are closed.

- [x] **Resolve `risk-tenancy`** — user / team / workspace scoping. Routed to `strata-architect`;
      closed by `docs/adr/0002-tenancy-workspace-scope.md` (decision log D9). Workspace-scoped,
      residency separated from capability.
- [ ] **Resolve `risk-injection`** — the fencing strategy for ingested content served over MCP.
- [x] `packages/core` — `Doc`, `Source`, `ImportEvent` committed, with provenance tracking and
      `workspaceId` per ADR 0002
- [x] ADR for `risk-tenancy` (0002) — `risk-injection` still needs its own ADR when it closes
- [x] Context-graph nodes for the tenancy contracts moved to `done`; `--impact dec-tenancy`
      verified accurate (13 downstream nodes, all expected: screens/components consuming `Doc`,
      plus `svc-storage`/`svc-mcp`/`svc-search`/`svc-ingest`)

**Done when** `packages/core` is stable enough that a change to it would be a versioned event.

**Scope of the M2/M3 hold (revised twice — D8, then D9 closing `risk-tenancy`):** `packages/core`
now carries `workspaceId` on `Doc`, `Source`, and `ImportEvent` for real, not deferred. D8's
distinction (fixture-driven UI was already safe; persistence and the MCP surface were the hold)
still applies, but the reason for the hold has changed: `svc-storage` and `svc-mcp` are no longer
waiting on `risk-tenancy` — they are waiting on milestone sequencing (M4/M6 have not started).
`risk-injection` remains a separate, still-open block on M6 specifically; it does not block M4.

---

## M2 — Shell and Library

- [ ] `comp-sidebar` — desktop rail + mobile overlay, one 860px breakpoint via media query
- [ ] `comp-doc-card`
- [ ] `screen-library` against a fixtures module (no backend yet)
- [ ] `/fidelity-check` clean on both components

**Done when** the Library renders from fixtures and the fidelity audit finds nothing.

---

## M3 — Reader and Import

- [ ] `screen-reader` — including the mobile stack and the body-size increase
- [ ] `comp-connector-row`, `screen-import` — connectors as visual endpoints, honestly labelled
- [ ] `/fidelity-check` clean across all three screens

**Done when** all three handoff screens are pixel-close against fixtures.

---

## M4 — Storage, search, and real data

- [ ] `svc-storage` decision + implementation
- [ ] `svc-search` — ranking designed for the agent case first, UI filtering as its subset
- [ ] Screens wired to real persistence; fixtures retired
- [ ] `strata-verifier` pass on every query path

**Done when** the Library search box returns real ranked results.

---

## M5 — Ingestion

- [ ] Local Markdown adapter first — no OAuth, exercises the whole pipeline end to end
- [ ] Normalizer, dedupe, `ImportEvent` emission including failures
- [ ] Claude and Cursor adapters
- [ ] GitHub adapter — ships **not connected** by default
- [ ] Fixture-based tests per adapter; no live network in tests

**Done when** a real folder of Markdown ingests, dedupes on re-run, and appears in the Library.

---

## M6 — MCP surface

- [ ] `search_docs`, `get_doc`, `list_sources` — read-only
- [ ] Scope re-checked inside every tool, not in middleware
- [ ] Content fenced as data on every response
- [ ] `strata-verifier` pass focused on tenancy leaks and injection
- [ ] Tool signatures pinned by a schema test

**Done when** a real MCP client can search and read the vault, and the verifier says ship.

---

## M7 — Agent Access screen

- [ ] Design it — no handoff exists for this screen
- [ ] Per-agent scoping UI, connection management, access log

**Done when** a user can see and revoke what each connected agent can reach.

---

## Deliberately unscheduled

These are real and unplanned. Listing them here stops them from being mistaken for oversights.

- "Ask agent about this" — a feature, not a button. Needs its own design pass.
- Mutating MCP tools — blocked on M6 shipping safely first.
- Multi-user collaboration, sharing, permissions beyond basic tenancy.
- Anything not Markdown.
