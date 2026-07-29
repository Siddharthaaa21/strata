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

- [x] `comp-sidebar` — desktop rail + mobile overlay, one 860px breakpoint via media query.
      Search field, folders list, and user-profile footer deliberately out of scope for this
      pass (not backed by a `packages/core` type yet) — see `Sidebar.tsx`'s DEVIATIONS note.
- [x] `comp-doc-card`
- [x] `screen-library` against a fixtures module (no backend yet)
- [x] `/fidelity-check` clean on both components — ran via `strata-fidelity-auditor`; found and
      fixed four raw-literal token-discipline violations (`--motion-card-hover`,
      `--motion-card-transition`, `--letter-spacing-tight`, `--space-subtitle-gap` were missing
      from `packages/tokens`, so four values fell back to hardcoded CSS literals). Two handoff-
      internal disagreements noted, not bugs: doc-card border (README 88% vs HTML 89%, HTML wins
      per R10) and active-pill/nav text (README says "white", HTML uses off-white
      `oklch(99% 0.005 90)`) — code correctly follows the HTML in both cases.

**Done when** the Library renders from fixtures and the fidelity audit finds nothing.

---

## M3 — Reader and Import

- [x] `screen-reader` — including the mobile stack and the body-size increase (18.5px/1.85 on
      mobile vs 17.5px/1.75 on desktop; the body grows while the title shrinks 34px → 26px)
- [x] `comp-connector-row`, `screen-import` — connectors as visual endpoints, honestly labelled.
      Two handoff-internal disagreements resolved per R10 (HTML wins): connector row padding is
      the exact `16px 18px` from `Vault.dc.html:123`, not README's "16-18px" range; and the
      handoff has no "+ Add source" control anywhere in `Vault.dc.html` despite the README
      implying one, so none was built.
- [x] `/fidelity-check` clean across all three screens — value-by-value spot check against the
      handoff: connector row padding/tile/radii, reader rail 280px + border side flip, content
      660px, import column 840px, and the recent-imports divider correctly on `border-hairline`
      (91%) rather than the card's 89%. No raw `oklch()` anywhere in `apps/web`.

**Done when** all three handoff screens are pixel-close against fixtures. — **Met.**

Open, carried out of M3 rather than closed inside it: failed `ImportEvent`s are excluded from the
Recent Imports list (the list has no status indicator by design, so a failed row reads as a
success). ADR 0003 argues failures must not be silent. Recording and rendering are different
things and this settles only the latter for this one list; **where a failed import surfaces to the
user is unresolved** and belongs with the Import screen's real-data pass in M4.

---

## M4 — Storage, search, and real data

- [ ] `svc-storage` decision + implementation. Constraint from ADR 0003 (M5's ingest design,
      built ahead of this milestone per D10): persist must upsert on
      `(workspaceId, sourceId, externalId)` and treat the `DocId` ingestion mints as a proposal,
      not an assertion — a crash mid-persist plus a retry must not double-write.
- [x] `svc-search` — **designed** (ADR 0004 / D11): ranking weighted for the agent case,
      provenance-weighted tags, recency as tiebreaker only. Implementation still open below.
- [x] Implement the schema, upsert, and ranked query from ADR 0004 — `packages/storage`, 13 tests
      against real Postgres 18 (PGlite, in-process). Covers: existing-id-wins on re-import, no
      cross-workspace leak, Grant `sourceIds` narrowing (and empty-array = deny-all), authored tags
      outranking model tags, no body in search results, limit clamped, and `NotFound` being
      indistinguishable between out-of-scope and nonexistent.
- [ ] Connect a live Postgres server — `fromPoolLike` adapter exists but is unverified against one;
      there is no Postgres in the dev environment yet
- [ ] Screens wired to real persistence; fixtures retired
- [ ] `strata-verifier` pass on every query path

**Done when** the Library search box returns real ranked results.

---

## M5 — Ingestion

**Sequencing note (D10):** M5 is listed after M4 because "persist" needs `svc-storage` to exist.
The fetch/normalize/dedupe/`ImportEvent` portion of the local Markdown adapter does not — it's
storage-free by construction (ADR 0003) — so that part is unblocked and in progress ahead of M4,
the same shape of exception D8 made for fixture-driven screens ahead of `risk-tenancy`. What
still waits on M4: actually persisting a normalized doc and retiring the in-memory `PriorIndex`
stand-in for a real one.

- [ ] Local Markdown adapter first — no OAuth, exercises the whole pipeline end to end. Design
      done: `docs/adr/0003-ingest-identity.md`. Build in progress.
- [ ] Normalizer, dedupe, `ImportEvent` emission including failures — designed in ADR 0003
- [ ] Claude and Cursor adapters
- [ ] GitHub adapter — ships **not connected** by default
- [ ] Fixture-based tests per adapter; no live network in tests — ADR 0003 specifies an injected
      filesystem port for exactly this

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
