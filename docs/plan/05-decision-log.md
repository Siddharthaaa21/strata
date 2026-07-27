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
