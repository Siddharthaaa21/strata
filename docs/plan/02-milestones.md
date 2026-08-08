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
- [x] **Resolve `risk-injection`** — design closed by ADR 0005 / D12 and implemented in
      `packages/core/src/untrusted.ts` (12 tests). `Untrusted<T>` types every ingested-derived
      string; bodies get a nonce-delimited envelope; search metadata is fenced structurally as JSON
      with one preamble, closing the gap D10 surfaced. Verification (red-team + `strata-verifier`)
      is M6 work — R2 stays open in the register until then.
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

- [x] `svc-storage` decision + implementation. Constraint from ADR 0003 (M5's ingest design,
      built ahead of this milestone per D10): persist must upsert on
      `(workspaceId, sourceId, externalId)` and treat the `DocId` ingestion mints as a proposal,
      not an assertion — a crash mid-persist plus a retry must not double-write. Both properties
      held for the *row* and initially failed for the *pair*: `upsert` wrote `docs` and
      `doc_bodies` as two unwrapped statements, and the returned canonical id was discarded by
      `persistDecisions`. Both fixed 2026-08-02 (single data-modifying CTE; `reconciled` map).
- [x] `svc-search` — **designed** (ADR 0004 / D11): ranking weighted for the agent case,
      provenance-weighted tags, recency as tiebreaker only. Implementation still open below.
- [x] Implement the schema, upsert, and ranked query from ADR 0004 — `packages/storage`, 13 tests
      against real Postgres 18 (PGlite, in-process). Covers: existing-id-wins on re-import, no
      cross-workspace leak, Grant `sourceIds` narrowing (and empty-array = deny-all), authored tags
      outranking model tags, no body in search results, limit clamped, and `NotFound` being
      indistinguishable between out-of-scope and nonexistent.
- [x] Connect a live Postgres server — Supabase (PostgreSQL 17.6, pooler port 6543). `fromPoolLike`
      is verified against it by `npm run db:setup` and by all three screens reading live data.
- [x] Screens wired to real persistence; fixtures retired — all three read the live database via
      `apps/web/src/lib/vault.ts`. Server Components reach the store; only a flat projection with
      no `workspaceId` or `credentialRef` crosses to the client. `server-only` makes an accidental
      client import a build error rather than a leaked connection string.
- [x] `strata-verifier` pass on every query path — ran 2026-08-02. Every SQL statement enumerated
      individually; workspace scoping is a `WHERE` clause everywhere, never a post-filter, and the
      boundary survived three independent attempts to break it. Found and fixed: non-atomic
      `upsert`, `credential_ref` erased by an omitting upsert, discarded canonical `DocId`.
      Found and **left open**: `Grant.sourceIds` is applied by `search`/`list`/`get` but not by
      `findKnown`/`upsert`/`events.recent`. Not exploitable today — nothing mints a narrowed grant —
      but it must be complete before M7 issues the first one. Tracked in R2's open list.

**Done when** the Library search box returns real ranked results. — **Met 2026-08-08, not on
2026-08-02 when this line first said so.**

That earlier "Met" was false, and the way it was false is worth keeping. The criterion names the
**Library search box**; it was marked met on the strength of 13 passing storage tests. There was no
search box. There had never been one — `git log -S` finds no search input in `apps/web` at any
commit until today. `packages/storage` returned real ranked results, which is a different claim
than the one written here, and nobody opened the page to notice.

Now genuinely met: a GET form in the sidebar navigates to `/?q=`, the Server Component runs
`docs.search`, and the results render ranked. Verified by using it, not by a test run — see D17.

Carried out of M4, **partially closed 2026-08-02**: `docs.list` clamps to `MAX_RESULTS` (50), which
is correct as an anti-exfiltration ceiling for an agent and wrong as a page size for a human.

Closed: the Library now reports the true total via `docs.count`, builds its filter pills from
`docs.folders` rather than from the clamped page — a folder whose documents all fell outside the
newest fifty previously had no pill, so the control that would have surfaced them was hidden by the
same truncation that hid them — and states plainly when it is showing a subset.

Still open: pagination itself. The handoff has no design for it, so the screen is honest about the
limit rather than inventing controls. That is a design question, not an implementation one.

Original note follows. The Library shows at most 50 documents,
reports that count as the vault size, and derives its folder pills from the same 50 — so a folder
whose documents are all older than the 50th disappears from the UI. Needs pagination, which is a
design question the handoff does not answer.

---

## M5 — Ingestion

**Sequencing note (D10):** M5 is listed after M4 because "persist" needs `svc-storage` to exist.
The fetch/normalize/dedupe/`ImportEvent` portion of the local Markdown adapter does not — it's
storage-free by construction (ADR 0003) — so that part is unblocked and in progress ahead of M4,
the same shape of exception D8 made for fixture-driven screens ahead of `risk-tenancy`. What
still waits on M4: actually persisting a normalized doc and retiring the in-memory `PriorIndex`
stand-in for a real one.

- [x] Local Markdown adapter — `packages/ingest`, 20 tests against an injected filesystem port.
      Identity, canonicalization, derivation, dedupe, and `ImportEvent` emission all per ADR 0003.
      Persist is the one stage still missing; it needs `svc-storage` wiring (below). Design
      done: `docs/adr/0003-ingest-identity.md`. Build in progress.
- [x] Normalizer, dedupe, `ImportEvent` emission including failures — designed in ADR 0003
- [x] Wire the adapter to `packages/storage` persist — `persist.ts`, plus a 7-test end-to-end
      suite covering the whole loop: files -> scan -> dedupe -> persist -> ranked search
- [ ] Claude and Cursor adapters
- [ ] GitHub adapter — ships **not connected** by default
- [ ] Fixture-based tests per adapter; no live network in tests — ADR 0003 specifies an injected
      filesystem port for exactly this

**Done when** a real folder of Markdown ingests, dedupes on re-run, and appears in the Library.

---

## M6 — MCP surface

- [x] `search_docs`, `get_doc`, `list_sources` — read-only handlers in `apps/mcp/src/tools.ts`
- [x] `sources` table in `packages/storage`, carrying its own `workspaceId`
- [x] Scope re-checked inside every tool, not in middleware
- [x] Content fenced as data on every response — nonce envelope for bodies, structural JSON for
      search metadata (ADR 0005)
- [x] Tool signatures pinned by a schema test — including that no mutating tool exists (D5)
- [x] Transport wiring (MCP SDK) — `apps/mcp/src/server.ts` plus a stdio entrypoint. Proven by an
      end-to-end test in which a real SDK `Client` drives the real server over a linked in-memory
      transport against real Postgres (PGlite): 8 tests
- [x] Verified against a live database — `npm run mcp:smoke` spawns the real server and drives it
      with a real MCP client over stdio. `.mcp.json` wires it into Claude Code with no secrets.
- [ ] `packages/auth` is a development stub — `localDevScope` is not authentication. Real
      per-connection principals are M7 (R7)
- [x] Red-team pass on injection — 9 hostile documents through the real route (`injection.test.ts`)
- [x] `strata-verifier` pass focused on tenancy leaks and injection — ran 2026-08-02, three
      independent passes, none told what the defenses were. All three returned **do-not-ship**, and
      they were right: `get_doc` was returning `title`/`folder`/`tags` unfenced above the only
      preamble in the response — a live injection channel — plus two normalization gaps (Unicode
      Tag block, `U+2028`) that let a document show one thing to the Library and another to an
      agent. Fixed, each with a regression test confirmed to fail against the old code. Full
      finding list and what the review *cleared* is in R2.
- [ ] Re-verify the fixes independently — this is what now closes R2. The fixes were written by the
      person who read the findings, which is the same authorship problem that produced the original
      defects. Not a formality.

**Done when** a real MCP client can search and read the vault, and the verifier says ship.

Not done: the verifier does not say ship yet. It said do-not-ship, the defects are fixed, and the
re-verification has not run.

---

## M7 — Authentication and the Agent Access screen

Restructured into increments by `docs/adr/0006-authentication.md` (D14), which closed R7. The
sequencing point: the vendor decision is last, so it never blocks the two increments that do not
need it.

**Increment 0 — complete the grant** `done`

- [x] `Grant.sourceIds` gates all nine store methods, reads and writes alike. It gated four. The
      write half resolves ADR 0003 open item 3: read-only narrowing leaves a write-only channel, and
      a principal who can write into a source it cannot read is R2's threat with the roles reversed.
- [x] `requireSourceInGrant` / `isSourceInGrant` in `packages/core`; denial is always a bare
      `NotFound`, never a distinguishable `Forbidden`.
- [x] `grant-completeness.test.ts` — enumerates the live store surface and fails on any method with
      no declared narrowing behavior, so a method added later cannot quietly skip the grant.
      Verified by adding an unregistered method and confirming the suite went red.

**Increment 1 — agent tokens on stdio** `done`

- [x] `principals`, `grants`, `agent_tokens` tables; `stra_at_<tokenId>_<secret>` format. A partial
      unique index enforces at most one *active* grant per principal in the database rather than by
      application discipline. `source_ids` NULL means all sources, `'{}'` means deny-all.
- [x] `createAuthenticator` in `packages/auth`; `AuthStore` port declared there and implemented by
      `packages/storage`, so auth never imports `pg`. One joined lookup per call, no cache.
- [x] MCP server requires `STRATA_AGENT_TOKEN`; `STRATA_WORKSPACE_ID` removed from it — the
      workspace comes from the token, and two sources of truth can disagree.
- [x] `ReadonlyDocStore` — D5's "no mutating tool exists" is now true at the type level rather than
      by the absence of a line of code (see R11 for the trigger to revisit).
- [x] `npm run agent:create` mints an agent, its grant, and its first token atomically. The token
      prints once and the script never writes it to a file.
- [x] Proven live: `npm run mcp:smoke` mints an ephemeral agent, drives the real server over stdio,
      then revokes mid-connection and asserts the next call returns `Unauthorized`. Revocation is
      immediate with no restart — which is the property the Agent Access screen will promise.
- [ ] CLI scripts (`ingest`, `search`) still use `localDevScope`; they move to `STRATA_CLI_TOKEN`
      with increment 2, when that function is deleted.

**Increment 2 — human sessions** `in progress`

Audience decided 2026-08-04: a few teammates, one shared workspace (ADR 0006 section 6b).

- [x] `memberships` and `user_identities` tables; email allowlist as the invite
- [x] `scopeFromSession` gated on membership — an authenticated stranger is still a stranger
- [x] `removeMember` revokes the person, the agents they created, and those agents tokens
- [x] `npm run member -- <list|add|remove>` for operating the allowlist without SQL
- [x] **Round-five fixes (D16)**, landed before the provider rather than after. `resolveSession`
      and `scopeFromSession` take a `workspaceId`; `(provider, subject)` binds an invitation to one
      credential; `email_verified` requires an explicit true in either location it can appear;
      `agent:create` requires `--by <member email>` so removal can actually reach the agent, and
      `removeMember` returns counts so the CLI stops claiming a revocation it did not perform.
      Two of the new tests failed mutation on the first attempt and were rewritten — see D16.
- [x] `vault()` is async and mints its `Scope` from the caller's session — cookie, verified JWS,
      membership. Magic-link login, PKCE callback, POST-only sign-out. No unauthenticated fallback:
      an unconfigured provider throws rather than quietly serving an open mode.
- [ ] Supabase Auth **proven against a live project** — the only piece needing credentials, and the
      one thing that could not be tested without them
- [ ] `localDevScope` deleted. Unreachable from the web app now, but `scripts/ingest.mjs` and
      `scripts/search.mjs` still call it, so the function still exists. They move to
      `STRATA_CLI_TOKEN` and then it goes.

**Increment 3 — the screen**

- [ ] Design it — no handoff exists for this screen
- [ ] Per-agent scoping UI, connection management, access log (same table as ADR 0005 §5's
      unimplemented response logging — design once, not twice)

**Done when** a user can see and revoke what each connected agent can reach.

Until increment 1 lands, **there is still no authentication**, and that is the honest status
regardless of increment 0 being green.

---

## Deliberately unscheduled

These are real and unplanned. Listing them here stops them from being mistaken for oversights.

- "Ask agent about this" — a feature, not a button. Needs its own design pass.
- Mutating MCP tools — blocked on M6 shipping safely first.
- Multi-user collaboration, sharing, permissions beyond basic tenancy.
- Anything not Markdown.
