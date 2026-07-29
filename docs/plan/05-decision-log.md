# Decision log

Append-only. One entry per decision that closes off an alternative. Structural decisions also get
an ADR in `docs/adr/`; this log is the index and the place for smaller calls that do not warrant
one.

Reopening a decision is allowed and requires a new entry saying what changed — never edit an old
one in place.

---

### D1 — Next.js + TypeScript for the web app
**2026-07-28** · scaffold · ADR: `docs/adr/0001-frontend-stack.md`

The handoff is framework-agnostic and explicitly says to use the target codebase's patterns; there
was no target codebase. Next.js chosen because the repo needs a server runtime regardless (ingest
workers, MCP host, OAuth callbacks), and the App Router gives routing for three screens without
another dependency.

Rejected: Vite + React (would need a separate backend service immediately); Vue/Svelte (no
advantage here, smaller ecosystem for MCP tooling); static SPA (cannot host ingestion).

**Reversible?** Moderately. Components are portable; routing and data fetching are not.

---

### D2 — npm workspaces monorepo
**2026-07-28** · scaffold

Web app, MCP server, and ingest workers share `packages/core` types. Publishing those to a
registry to share them across repos, pre-product, would be absurd. npm workspaces over pnpm/turbo
because npm 11 handles this natively and adding a package manager is a real onboarding cost for
zero current benefit.

**Reversible?** Yes, cheaply.

---

### D3 — Design tokens are a package, and raw `oklch()` is blocked by a hook
**2026-07-28** · scaffold

The handoff specifies near-identical colors that do different jobs (`oklch(88/89/91% 0.015 95)`).
Drift between them is invisible in review. A hook that blocks raw `oklch()` outside
`packages/tokens` turns a taste question into a mechanical one.

Rejected: convention alone (does not survive contact with a deadline); a linter rule (same effect,
but another dependency and a slower loop than a hook that fires on write).

**Reversible?** Yes — delete the hook. But see R9: the mitigation degrades the moment exceptions
are added.

---

### D4 — Contracts before screens
**2026-07-28** · planning

The three screens are the best-specified work in the repo and the most tempting starting point.
Sequenced after contracts anyway, because every screen consumes `Doc` and `Doc` blocks on tenancy
(R1). Building screens first means building them twice.

**Reversible?** Yes, but reversing it costs the rework it was ordered to avoid.

---

### D5 — MCP surface ships read-only
**2026-07-28** · planning · supersedes nothing

`search_docs`, `get_doc`, `list_sources`. No mutation tools until tenancy (R1) and the injection
fencing strategy (R2) are both closed. A corpus of model-generated text served to models, with
write access, before scoping is settled, is the failure mode worth engineering against.

**Reversible?** Yes — additive. Adding tools later is safe; removing them is not.

---

### D6 — GitHub connector ships disconnected by default
**2026-07-28** · product · inherited from the handoff

Stated in `design/handoff/README.md:25` as an explicit team decision. Recorded here so it is not
"fixed" later by someone who reads it as an oversight.

**Reversible?** Yes, but it is a product decision, not an engineering one.

---

### D7 — Lint deferred out of the initial scaffold
**2026-07-28** · scaffold

`npm run verify` is typecheck + tests + graph integrity at M0. Lint config was not shipped in the
scaffold because there was no source to lint and untested config is worse than none. Tracked as an
M0 checklist item.

**Reversible?** Trivially — it is a gap, not a choice against linting.

---

### D8 — Reopens D4: fixture-driven M2/M3 screens unblocked ahead of `risk-tenancy` closing
**2026-07-28** · planning · reopens D4

D4 sequenced all screen work after contracts because `Doc` blocks on tenancy (R1) and building
screens against a shape that later gains a field means rebuilding them. That reasoning holds for
anything that touches a real query or a real stored `Doc`. It does not hold for fixture-driven UI:
`packages/core` already resolves the ambiguity by omitting the tenancy field structurally rather
than guessing it (see the `TODO(risk-tenancy)` comment in `packages/core/src/index.ts`), and a
fixtures module has no query or storage layer for a tenancy field to be missing from. There is
nothing about `screen-library`, `screen-reader`, or `screen-import` rendering from
`packages/*/fixtures` that a later tenancy field would invalidate — the components consume `Doc`
metadata that is stable either way.

What stays blocked: `svc-storage`, `svc-mcp`, and anything that answers a scoped query against
real data. Those still wait on R1 closing per D4/D5.

Rejected: closing R1 first and delaying screens further — the tenancy ADR is a product decision
(scope unit: user vs. team vs. workspace) with no engineering blocker forcing it now, and holding
three well-specified, low-risk screens hostage to an unrelated product decision was costing more
than it was buying.

**Reversible?** Yes — screens built against fixtures don't need touching when R1 closes; only the
data-fetching layer that replaces fixtures does.

---

### D9 — Closes R1: `Doc` is workspace-scoped
**2026-07-28** · architecture · ADR: `docs/adr/0002-tenancy-workspace-scope.md` · closes `risk-tenancy`

Routed to `strata-architect`. A `Doc` is scoped to a workspace — flat, non-hierarchical. Residency
(`workspaceId` on `Doc`/`Source`/`ImportEvent`) is modeled separately from capability (`Grant`,
carried by the caller): the north-star requirement that a teammate can find a doc they never knew
existed rules out user scope outright, and "not an enterprise wiki" rules out a team/org hierarchy.
An agent is a distinct principal from the user who connected it (per M7), so per-agent scope is a
`Grant` that narrows within a workspace, not a second field on `Doc`.

Enforcement leans on the type system but is not purely compiler-backed: `Scope`/`Visible<T>` are
brands, and a bare `as Scope` cast compiles with no import for a `post-edit` hook to catch — a
`strata-verifier` pass caught this after the fact and compiled a working bypass. The real backstop
added in the same fix: a `no-restricted-syntax` ESLint rule (`eslint.config.mjs`) that bans casting
to `Scope`/`Visible<T>` outside `mintScope` (`packages/core/src/scope-internal.ts`) and
`assertVisible`/`assertSourceVisible` (`packages/core/src/index.ts`), checked on every `npm run
verify`. Every value reaching an MCP payload must pass `assertVisible`/`assertSourceVisible` first,
redundantly with the store-level filter, per M6's "scope re-checked inside every tool" requirement
— see ADR 0002 for the full correction.

Rejected: per-doc ACLs (pushes permission decisions into ingestion, and per-doc sharing is
explicitly deferred); narrowing agent grants by `folder`/`tags` (both are `Derived<T>` and can
carry `model` provenance — an injection vector into access control, R2); `workspace_id` as an
explicit MCP tool argument (welds a published tool signature to a revisable decision).

Left open, routed rather than guessed: whether a user can belong to more than one workspace (folds
into R7); that R7 now needs machine credentials distinct from user sessions; whether per-source
`Grant` narrowing is enough for M7's Agent Access screen; `Scope` lifetime vs. per-request lookup
cost (revisit with R6/`svc-storage`).

Unblocks the `svc-storage`/`svc-mcp` holds D8 left standing — those wait on milestone sequencing
now, not on this risk.

**Reversible?** Moderately. See ADR 0002's Migration risk section — a later change to the scope
unit touches three tables' leading indexed column, but no MCP tool signature, screen, or the
ingestion dedupe key, because none of those touch `workspaceId` directly.

---

### D10 — Reopens M5-after-M4 sequencing: local Markdown ingest logic unblocked ahead of `svc-storage`
**2026-07-29** · planning · reopens the M4-then-M5 ordering in `02-milestones.md` · ADR: `docs/adr/0003-ingest-identity.md`

Same shape of exception as D8: the milestone doc sequences M5 (ingestion) after M4 (storage), and
`svc-ingest`'s "persist" stage genuinely cannot be built before `svc-storage` exists. That reasoning
holds for persistence. It does not hold for the local Markdown adapter's fetch → normalize → dedupe
→ `ImportEvent` logic, which `strata-architect` (routed for the identity/normalization design — see
ADR 0003) scoped deliberately to stop one field short of a real `Doc`: it produces a `PendingDoc`
(everything `Doc` has except `id`/`bodyRef`) and complete `ImportEvent` records, tested entirely
against in-memory fixtures with an injected filesystem port — no live disk, no network, no
`svc-storage` dependency of any kind.

The architect flagged this sequencing question explicitly rather than silently building ahead
(`OPEN` item 6 in its design), and asked the dispatching agent to confirm the exception and record
it here, matching D8's precedent. Confirmed: build the storage-free portion now.

Why this doesn't quietly reintroduce `risk-injection` (R2) into M5, which is still open and still
blocks M6 only: the design commits to three invariants for the M5 scope — no `Derived<T>` value
this adapter produces ever carries `provenance: 'model'` (no LLM call anywhere in the path);
ingested text (frontmatter, body) never selects a code path, only a value; and ingested text never
reaches `ImportEvent.error.message` (a caught parser error's own `.message` can itself embed
source text — e.g. `js-yaml` — and must be discarded in favor of a fixed template keyed on error
code, never interpolated raw). `context-graph/nodes/svc-ingest.md`'s `depends_on: [..., risk-injection]`
edge stays — it means "read R2 before touching this code," not "blocked on R2," which is a real
ambiguity in how this repo's graph edges are documented; see the one-line clarification added to
`CLAUDE.md`'s Context graph section in this same change.

One real gap this surfaced rather than closed: R2's mitigation list is written about ingested
*content*; `search_docs` returns `title`/`excerpt`/`tags`, all derived from that same untrusted
content under this design. "Fence the returned content as data" does not obviously cover a
document titled as an instruction. Recorded as a sub-item under R2 in the risk register — for the
eventual injection ADR to resolve, not this one.

Rejected: waiting for M4 to close before starting any M5 work (the same cost D8 rejected — holding
well-scoped, low-risk work hostage to an unrelated milestone's sequencing); resolving R2's
metadata-channel gap as part of this design (out of scope — this is an ingest design, not the
injection-fencing ADR).

**Reversible?** Yes, with one real cost named up front, not hidden: `externalId` is the
NFC-normalized relative file path, so a file rename is currently a delete-plus-create, not an
update, and the old `DocId` (and anything attached to it later) is lost. That is a property of
path-based identity, not an oversight, and is tracked as an open item in ADR 0003 rather than
deferred silently. The storage-free scope itself needs no rework when `svc-storage` lands — only
the `persist` stage (not yet built) plugs in underneath it.

---
### D11 — Postgres as the only datastore; native full-text retrieval, semantic search deferred
**2026-07-29** · architecture · closes R4 and R6 · ADR: `docs/adr/0004-storage-and-search.md`

R6 required storage and search to be decided in one pass. Postgres with native `tsvector` ranking,
no separate search service. `docs` (hot metadata, indexed) splits from `doc_bodies` (cold) because
`contract-doc` requires metadata-only retrieval — a requirement, not an optimization.

Ranking is weighted for the agent case per R4: title (A) > tags with `user`/`source` provenance (B)
> excerpt and folder (C) > `model`-provenance tags and body (D). Provenance-weighted tags are the
substantive part — `Derived<T>` carries provenance for re-sync safety, and ranking is the second
thing that buys. Recency is a tiebreaker only, because `updatedAt` derives from mtime (ADR 0003)
and is therefore writer-influenced.

Scope is applied inside the ranking query, never after it. Rank-then-filter is both a tenancy leak
and a ranking bug: the top-N is drawn from the whole corpus before scoping, which starves small
workspaces.

Upsert honors ADR 0003's constraint exactly — `ON CONFLICT (workspace_id, source_id, external_id)`,
with the existing id winning so the ingest-minted `DocId` stays a proposal and a retry after a
mid-persist crash converges instead of double-writing.

Rejected: a dedicated search engine (a second system and a sync path that can silently drift —
exactly what R6 names); SQLite + FTS5 (good, but tenancy plus concurrent ingest plus a hosted MCP
server all want a real server, and migrating later rewrites every query); pgvector now (puts an
embedding call in the ingest path, pulling R2 forward into M5 and adding per-doc model cost before
anyone has asked for semantic recall — seam designed, decision deferred).

Process note: decided in the main loop rather than routed to `strata-architect`, because subagents
were not in use for this session. Worth re-running through the architect before implementation
starts if a second opinion is wanted on the ranking weights.

**Reversible?** The store and the ranking weights, yes — pgvector is additive, reweighting is a
reindex. The `(workspace_id, source_id, external_id)` uniqueness constraint is not, but that is
inherited from ADR 0003 rather than chosen here.

---
### D12 — Untrusted content is a type, fenced per channel
**2026-07-29** · architecture · closes R2's design half · ADR: `docs/adr/0005-untrusted-content.md`

Every string derived from ingested content is `Untrusted<T>`, discharged only by `fence()` or
`forDisplay()`. Typed rather than checked at the MCP boundary because the boundary moves: a
summarizer, related-docs, or "Ask agent about this" would each silently bypass a boundary check,
and nothing would fail to compile. Same witness pattern as `Visible<T>`, same `as` bypass, same
`no-restricted-syntax` backstop — verified by planting a cast and confirming the rule fires.

Fencing depends on the channel. Bodies get a nonce-delimited envelope; the nonce is random per
response, never derived from content, and stripped from the content before wrapping, so a document
cannot close its own fence. Search metadata is fenced *structurally* — JSON string values under
labelled keys, with one preamble per response — which closes the gap D10 surfaced: a document
*titled* as an instruction was not covered by "fence the returned content as data". Per-field
warnings were rejected: cost scales with result count and repetition teaches a model to skip them.

Ingest normalization strips bidi overrides, zero-width characters, and C0/C1 controls. This is not
injection prevention and is not claimed to be — it stops an injection being *invisible* to the human
reviewing the Library, since bidi controls reorder rendered text without changing the bytes a model
reads.

Rejected: LLM-based injection classification (a model call per doc, itself injectable, and pulls a
model dependency into ingest that D10 kept out); stripping suspicious phrasing at ingest (unbounded
and lossy — "ignore previous instructions" is legitimate content in a document *about* injection,
which this corpus will contain); a fixed delimiter (content can close it early).

Honest limit, recorded rather than glossed: this reduces likelihood and blast radius, it does not
eliminate injection. Any design that serves text to a model is injectable in principle, and nothing
here has yet been tested against a real attempt. R2 stays open in the register until a red-team pass
and a `strata-verifier` sign-off in M6.

**Reversible?** Yes at the type level — additive, no stored data or schema change, no MCP signature
change (the tools do not exist yet). The standing cost is deliberate friction: every future consumer
of `Doc` must discharge `Untrusted<T>` explicitly.
