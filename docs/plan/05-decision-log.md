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

---

## D13 — Fence enforcement is a chokepoint and a test, not a type · 2026-08-02

**Context.** Three independent `strata-verifier` passes ran against the MCP surface, storage, and
ingest. Each was given the target and an adversarial mandate; none was told what the defenses were
or how they were meant to work. All three returned **do-not-ship**. Two of them independently found
the same top defect without seeing each other's work: `get_doc` returned `title`, `folder`, and
`tags` straight from ingested content, with no preamble and no `untrustedFields` declaration, while
the single warning in the response sat *below* them inside the body envelope reading "the content
below". Frontmatter `title:` accepts a multi-line YAML block scalar, so that was unbounded
attacker-controlled prose reaching an agent as the first thing in the payload.

**Decision.** The response-construction chokepoint (`fenceResults`, `fenceDoc`) plus
`apps/mcp/src/fencing.test.ts` is the enforcement. `Untrusted<T>` stays, demoted to documentation.

**Why the type could not have caught this, which is the part worth remembering.** `Untrusted<T>` is
`T & {witness}` and is therefore **assignable to `T`**. A handler that never discharges the marker
compiles cleanly. The `no-restricted-syntax` rule bans *constructing* the witness — it catches
"someone invented untrusted data from nothing" and cannot catch "someone returned untrusted data
without fencing it", which is the failure that actually shipped. The marker additionally does not
survive the storage round trip: `Doc.title` is a plain `string` in `packages/core`, so the store
returns unmarked values no matter what ingest produced. D12 and ADR 0005 section 1 claimed "a type
follows the value into all of them." That claim was wrong, and believing it is why nobody wrote the
test. ADR 0005 now carries the correction inline rather than a quiet edit.

**Why the test is written inside-out.** Not "assert `get_doc` fences its title" — that is another
per-field test, and per-field tests only cover fields somebody thought to name. Instead: plant a
distinct marker in every content-derived input, serialize the real response from a real MCP client,
and demand that *every* occurrence of *any* marker lands either in a field named by
`untrustedFields` or inside the nonce envelope. A future tool returning a new ingested field fails
without anyone remembering to add a case. The old `get_doc` test asserted on `content` alone and
passed for the wrong reason — it proved the body was fenced and was silent about four sibling keys.

**Method note, and the actual reusable lesson.** The red-team suite that missed all of this was
thorough and adversarial; its author simply could not step outside their own model of the threat. It
tested the hiding techniques it knew (RLO, zero-width) and stopped at the edge of that list, missing
the Unicode Tag block. It never considered `U+2028`, which requires knowing a `JSON.stringify`
serialization detail rather than a Unicode one — a different domain from the rest of the defense.
Independent review is not a rubber stamp on this codebase; it is where the defects were. Every fix
here was written by the person who read the findings, which reproduces the same authorship problem
one level up, so R2 does not close until the fixes are themselves independently re-verified.

**Reversible?** The test is additive. The `fenceDoc` payload adds two keys to `get_doc` output
(`notice`, `untrustedFields`) ahead of the existing ones — an additive wire change, and the output
shape was never pinned. Removing it would reopen the hole, so treat it as one-way.

---

## D14 — Enumerate the property, not the attacks · 2026-08-02

**Context.** D13's fixes were re-reviewed the same day by two further independent passes. Both
returned do-not-ship. Two of the four fixes did not do what D13, ADR 0005, the risk register, the
commit message, and the context graph all claimed. Specifics are in R2; the pattern is the point.

**What went wrong, in one line each.** The fencing guard was written against the two tools that
existed, so a reviewer added a third and the suite passed 5/5. The excerpt cap was applied to the
field named "excerpt", so `title`, `folder`, and `tags` stayed unbounded and produced a 3.2 MB
`search_docs` response. The stripped-character set was extended with the carrier round one found,
so round two used the carrier 129 codepoints above it.

**Decision.** Where a defense enumerates, it must enumerate the *property* or the *live surface*,
never the instances known at authoring time.

- Stripped characters: the rule is "nothing default-ignorable survives ingest", not a list of
  carriers. A carrier is added only when the property already covered it and the range was wrong.
- Fencing: the guard calls `tools/list` and derives arguments from each tool's own `inputSchema`.
  It tests the surface the server advertises, not the surface the test author remembered.
- Bounds: every metadata channel that crosses the wire is capped, not the one that sounds like it
  carries prose.

**Why this is a decision and not just a bug fix.** All three round-one fixes were locally correct.
Each closed the exact defect reported. They failed because a defect report is a *sample* of a class,
and treating it as the class is how a security fix becomes a security theatre. The generalization
step is not optional polish — it is the fix.

**The method finding, which is the expensive one.** Round one's claims were asserted in five places
and tested in none. "A future tool that forgets will fail here" was written into a commit message,
an ADR, the risk register, this log, and a graph node without anyone adding a future tool to check.
A claim about what a test *would* catch is itself testable, and now is: the leaking-tool experiment
is run before the claim is made, not after a reviewer disproves it. Documentation asserting a
property the code does not have is worse than silence, because it stops the next reader looking.

**Reversible?** The property framing is additive and cheap to keep. Reverting the enumeration in the
fencing guard would silently restore a guard that only appears to generalize, which is the worst of
the three states — treat it as one-way.

---

## D14 — Buy the login, build the agent tokens, and finish the grant first · 2026-08-02

**Context.** R7 was the last thing keeping Strata on localhost. `packages/auth` exported
`localDevScope`, a labelled stub: anything able to start the process got the configured workspace.

**Decision.** `docs/adr/0006-authentication.md`. Human sessions bought (Supabase Auth), agent tokens
built (`stra_at_<tokenId>_<secret>`, SHA-256 stored, one indexed lookup per call, no cache).
Authorization never moves to the provider and the provider's subject id is never a `PrincipalId`.
Delivered in four increments; increment 0 has landed.

**Why buy one half and build the other.** They are different problems. Password reset, session
fixation, MFA, and account recovery are a month of work and still probably wrong, and nothing about
Strata's login is special. But no provider offers long-lived, individually revocable machine
credentials whose authorization dimension is `Grant.sourceIds` over *our* `Source` rows — adopting
their API-key model means writing a mapping layer from their scope vocabulary to ours and then
owning both. The thing we build is smaller than the mapping it replaces.

**The honest bit, recorded because the alternative is a comfortable lie.** A stdio token buys **no
containment**. The MCP server reads `DATABASE_URL` itself — by design, so no client config holds a
secret — which means anyone who can launch the subprocess can reach Postgres directly and bypass
`Scope` entirely. The token buys attribution, per-agent narrowing, and revocation. That is all of
M7 and it is worth building, but it is not confidentiality, and a design doc claiming otherwise
would stop the next reader from looking. Containment arrives with remote transport, where the server
holds the credential and the client does not.

**No cache, and the rule that outlives the decision.** Verification is a lookup per call. The
general rule: **the maximum legitimate cache TTL equals the revocation latency the Agent Access
screen promises the user.** The button says access ends immediately, so the TTL is zero. If a later
version says "within 30 seconds", 30 seconds becomes purchasable. The UI copy is the contract; a
cache added without changing that copy is a lie in the product, not a performance tweak.

**`Grant.sourceIds` gates writes, not just reads** — resolving ADR 0003 open item 3 rather than
routing it onward again. Read-only narrowing leaves a write-only channel: a principal scoped to
source A could upsert into source B, injecting a document it cannot itself read but that every other
member reads and the MCP server serves to every other agent. That is R2's threat with the roles
reversed — R2 asks what ingested content can do to a reader, this asks who is allowed to be the
ingester. Rejected alongside it: a `capabilities: ('read'|'write')[]` axis on `Grant`, because there
is one write caller and one read-only caller class. The hazard that creates is closed structurally
(`ReadonlyDocStore`) with an explicit trigger recorded as R11, rather than by discipline.

**Increment 0 first, and why it is not merely tidying.** Issuing a narrowed grant before completing
enforcement would have been security theatre: five of nine store methods ignored `sourceIds`. The
register said three of six — a number relayed from a reviewer without checking, and wrong in a way
that understated it. Increment 0 needs no vendor, no tables, no signature change and no UI, and the
system is measurably safer with it alone.

**Method, following D13.** The completeness claim is held by a test that reflects over the live
store surface and fails loudly on any method with no declared narrowing behavior — not by a list of
five method names, which would be correct today and silent about the method added next quarter. The
claim that it catches a later method was verified before being written into this entry, the ADR, or
the graph: an unregistered store method was added and the suite went red naming it.

**Reversible?** The design is. The `sourceIds`-gates-writes half is **not** — reverting it reopens
the write channel. `ServerDeps.scope(): Promise<Scope>` and an async `vault()` are also one-way in
practice, since reverting means giving up the per-call lookup and with it revocation.

---

## D15 — Query the Unicode database; a list is never a property · 2026-08-02

**Context.** Three independent review rounds hit one definition in `packages/core/src/untrusted.ts`,
and each round beat the previous round's fix. Round 1 added the Unicode Tag block after an
instruction was smuggled through it. Round 2 sent the identical payload through variation selectors,
129 codepoints above where round 1 had stopped. Round 3 found **3,737 surviving default-ignorable
codepoints**, including `U+E0080..U+E00FF` — a contiguous block encoding all of printable ASCII,
sitting in the gap between the two ranges rounds 1 and 2 had each stopped at.

**Decision.** `\p{Default_Ignorable_Code_Point}` and `\p{Bidi_Control}`, queried from the engine's
own Unicode character database, plus explicitly-justified extras that no property covers (C0/C1
controls; `U+2028`/`U+2029` for a structural JSON reason; `U+FFF9..FFFB`). ~4,174 codepoints instead
of 26, and a future Unicode revision is covered when the runtime updates rather than when someone
remembers to edit a list.

**Why this took three rounds, which is the part worth keeping.** Every fix was a list pretending to
be a property, and the giveaway was visible in the code the whole time:

- Round 2's fix carried the comment "ENUMERATE THE PROPERTY, NOT THE ATTACKS" above a hand-written
  array of 25 ranges.
- Round 2's *test* was named `'nothing default-ignorable survives ingest — the property, not a
  carrier list'` and its body was a 26-element array of hand-picked codepoints. It was a carrier
  list wearing the property's name, and it passed while 3,737 carriers got through.
- The ranges were assembled by reading character *names* rather than querying the property, which is
  why `U+FFF9..FFFB` (not default-ignorable) was included while `U+FFF0..FFF8` (which is) was missed.

**The general rule this produces:** *if a test can be satisfied by an enumeration, it is not testing
the property it claims to test.* The sweep now iterates all 1.1M codepoints and asserts every one
carrying the property is stripped — 14ms, which is cheap for the one assertion in this repo that has
been wrong three times running. Applied to the fencing guard in the same change: it now inspects
every payload channel a tool result can use rather than the first one.

**A second, separate lesson from the same round.** The `MarkdownBody` ReDoS fix was wrong twice
over: a per-call cap is not a document bound (a chunked payload walked past it at 25.8 seconds), and
its comment asserted the code "runs in the reader's browser" when it is an async Server Component,
so a hang blocks the Node event loop for *every* concurrent request. Getting the threat model
backwards is what made an inadequate fix look adequate to its author. The tokenizer has been
extracted to a `.ts` file, because Node strips types but does not transform JSX — the defect
survived in part because it lived in a file `node --test` could not load. **Code that the test
runner cannot reach will eventually be wrong.**

**Reversible?** The property query is strictly broader than any list it replaces, so reverting
re-opens carriers. The known cost is accepted and documented: `U+FE0F` and `U+200D` are
default-ignorable, so an emoji may render in text style and a ZWJ sequence may split. A character
that is invisible by definition cannot be let through on the grounds that it is usually benign.

**Known limit, recorded rather than implied.** The module's stated threat — "rendered text matches
read text" — is strictly broader than the property it implements. Homoglyphs, ideographic space,
combining overlays, and strong-RTL script with no bidi *control* all survive and all can make the
Library and an agent disagree. None is default-ignorable and stripping them would be wrong; you
cannot strip Hebrew. Normalization is not the mitigation for those. The fence and the label are.

---

## D16 — Round five: the membership layer, and what "flaky" was hiding · 2026-08-08

**Context.** Five independent adversarial review rounds, each finding real defects in the previous
round's fixes. Round five was pointed at the membership and session code — the least-reviewed thing
in the repo, written fast to unblock increment 2, and the layer that goes live the moment a provider
is wired. Nothing found was exploitable on the day it was found: `vault()` still used
`localDevScope` and no production path called `scopeFromSession`. All of it would have gone live
together.

**What was wrong, and the shape they share.** Every one is a check that *appears* to run and does
not.

| Defect | Why it looked fine |
| --- | --- |
| `resolveSession` had no `workspace_id` predicate and no `ORDER BY`, then took `rows[0]` | Correct with one workspace, which is all any test had |
| `user_identities` was written on first sign-in and never read | The write is visible in the code and in the schema; only the *read* was missing, so a second provider subject inherited the first person's account by email alone |
| `email_verified === false` rejected, absent accepted | Reads as a verification check. Supabase puts the flag in `user_metadata`, so on the chosen provider it never fired once |
| `removeMember` filtered agents by `created_by IN (...)` | `NULL IN (...)` is never true, and `agent:create` never set `created_by` — so it revoked nothing, while the CLI printed that it had |
| `addMember` re-granted with `source_ids = NULL` | NULL means *every source*; re-inviting a narrowed member silently widened them |
| The search fallback ranked against `strict_q` | Every fallback row scored 0 — by definition, since they are the rows that did not match the strict query — so it ordered by recency, the opposite of its comment |

**The decision.** `resolveSession` and `scopeFromSession` now take the workspace as a parameter
rather than discovering it; identity is `(provider, subject)` and an invitation is single-use;
`email_verified` requires an explicit `true` in either location, with an opt-out named
`allowUnverifiedEmail` so that turning it on reads as badly as it deserves; `agent:create` requires
`--by <member email>`; and `removeMember` returns counts so the CLI reports what happened instead of
asserting what should have.

**The lesson worth keeping, which is not in the table.** Two of the fixes were verified by mutation
— reintroduce the bug, confirm the test goes red — and *both new tests failed that check on the
first attempt*:

- The `addMember` narrowing test never reached the line it was testing. `removeMember` revokes the
  membership, the principal and its tokens but **not grants**, so the narrowed grant stayed active,
  `addMember`'s `NOT EXISTS` guard skipped the insert, and the assertion passed without executing
  the changed code. The comment in `addMember` claiming removal leaves the grant revoked was also
  simply false.
- The existing "the fallback ranks documents matching more terms first" test passed *with the bug
  present*, because both fixtures shared an `updatedAt` and the expected order was reachable through
  the recency tiebreaker. It now makes recency actively disagree with relevance.

**And one defect found only because a test looked flaky.** The first narrowing fix ordered candidate
grants by `created_at DESC LIMIT 1`. Grants are stamped from two clocks — this package writes a JS
timestamp, an operator writing SQL writes `now()` — so two can tie inside one millisecond, and a tie
with no tiebreaker resolves to whatever the planner returns. That is a coin flip between inheriting
a narrowing and inheriting NULL, which is the whole vault. It presented as a test that passed alone
and failed in a full run. **A test that passes in isolation and fails in a suite is reporting a
race, not flakiness; the ordering is now total (`revoked_at DESC, created_at DESC, id DESC`).**

**Reversible?** The signature changes are compile-time breaks, so reverting is loud. The identity
binding is the one deliberate behaviour change with a user-visible edge: a member who legitimately
signs in through a *second* provider with the same address is now refused rather than silently
merged. That is the correct default — the alternative is the classic pre-hijack — but it is a
support question the day someone hits it, and it is recorded here so the answer is not re-derived.

---

## D17 — The Library shipped for five milestones without search · 2026-08-08

**What happened.** `design/handoff/README.md:15` states the Library's purpose: "Browse/**search**
all ingested docs across sources and folders." `Vault.dc.html:52` draws the field. The application
had no search box from M2 until today — `git log -S` confirms no search input existed in `apps/web`
at any commit in between. Search itself was built in M4, tested against real Postgres, and reachable
only by agents over MCP. No human could use it.

**The chain, in four steps, none careless on its own:**

1. **M2 omitted it, correctly.** No storage existed yet; nothing backed a search field. Deferring
   was the right call.
2. **The deferral was recorded somewhere nothing is read again** — a note inside an
   already-checked milestone bullet (`02-milestones.md:61`) and a `DEVIATIONS` code comment. Not a
   risk, not a carried-out item, not a task.
3. **M4's completion criterion was marked Met when it was not.** The line read "Done when the
   Library search box returns real ranked results." It was closed on 13 passing storage tests. The
   criterion names a UI element; the evidence was a test suite. Nobody rendered the page.
4. **The fidelity audit ran and was clean** — correctly. Its brief is to compare the implementation
   to the handoff *value-by-value*. An element that does not exist has no values to disagree about,
   so the audit was structurally incapable of finding the largest defect on the screen.

**The decision, three parts:**

- A `Done when` that names something user-visible is closed by **exercising it** — a screenshot of
  the described behaviour — never by a green test suite. The browser tooling existed the whole time.
- The fidelity auditor now runs a **presence pass before its value pass**, and reports
  `PRESENT: n of m` even when clean. "Fidelity audit clean" is the sentence that missed this;
  "PRESENT: 12 of 12" is the sentence that would not have.
- **A deferral creates a tracked item.** If it is worth writing down, it is worth putting where
  something reads it. Waived omissions now live in `guarantee-handoff-completeness`, with a reason
  each, and anything absent that is not in that table is a finding.

**The general lesson, and the reason this entry is long.** *Verification went where the tooling was,
not where the risk was.* Authentication got five independent adversarial review rounds and turned up
a real privilege escalation; there are 232 tests; every SQL statement was enumerated for tenancy
leaks. All of that is checkable without a human looking at anything, so all of it got checked,
repeatedly. The one question that required someone to open a browser — **is this the product?** —
had no mechanism at all, so it went unasked for six milestones while every later milestone built on
"Library: done."

Rigour is not uniform just because it is intense. It pools where it is cheap.

**Reversible?** The presence pass costs one enumeration per screen audit. The alternative is
trusting a value diff to notice absence, which it demonstrably does not.

## D18 — The env var the server could read and the browser could not · 2026-08-09

**Context.** The root `.env` is the single source of truth for the CLIs, the MCP server and the web
app. `apps/web/src/lib/vault.ts` made that work by reading the file into `process.env` on first use.
That is a *runtime* fix, and it is complete for everything that runs on the server.

`NEXT_PUBLIC_*` does not run on the server. Next substitutes it into the client bundle **while the
bundle is being built**, from `.env*` files it loads out of the directory it was started in —
`apps/web`, which has none. So both public Supabase settings were present for every Server
Component and absent from the one file that runs in a browser.

**What that looked like.** Everything worked. `/` and `/import` redirected to `/login` correctly,
`/login` rendered correctly, `/auth/dev-login` correctly 404'd with the local issuer off, the JWKS
endpoint returned the project's ES256 key, membership and grants were in place. The failure was one
click deep: `supabaseBrowser()` threw `NEXT_PUBLIC_SUPABASE_URL … are not set`, the button stuck on
"Sending…", and no request ever left the page.

This is D17's lesson arriving a second time, one day later, in a new disguise. The runtime workaround
did not merely fail to cover the build-time case — **it concealed it**, by making every observable
server behaviour correct. A missing variable that broke everything would have been found in seconds.

**The decision.** `next.config.ts` calls `clientEnv()` from `apps/web/src/lib/root-env.ts`, which
reads the root `.env` at config time and returns values for Next's `env`.

- **An allowlist of literal names, never a predicate over the file's keys.** `env` inlines what it
  is given into a public artifact, and the same file holds `DATABASE_URL` and `STRATA_CLI_TOKEN`.
  Even `startsWith('NEXT_PUBLIC_')` is unsafe: it ships a mislabelled
  `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` to every browser and looks deliberate in the diff. Adding
  a name is an act with a reviewer; matching a pattern is a decision nobody makes again. Tested
  against a fixture of secret-shaped names, not by asserting the list equals itself.
- **Process first, file second.** On a platform the values come from the environment and there is no
  file; file-first would let a stale local value beat the configured one wherever both exist.
- **Absent stays absent.** A missing name is omitted, not defaulted to `''`, so it presents as
  "not configured" and not as a signature failure.

**Rejected: symlinking `apps/web/.env` to the root file.** One command, no code. It is invisible in
a diff, does not survive a clone, and aims a file of secrets at a directory the framework serves
from. A dozen lines that say what they do beat a filesystem trick nobody can see.

**How it was caught, and the part worth keeping.** By submitting the sign-in form with a
deliberately malformed address (`probe@`) before spending a real one. Supabase rejects the format
without sending mail, so the probe distinguishes "env missing" from "env present" for free — which
matters on the free tier, where the built-in mailer allows **two emails per hour**. The general
move: when the confirming action is rate-limited, find the input that exercises the same path and
fails early.

**Reversible?** Yes, and cheaply — but note that the check that would have caught this is not a unit
test. It is loading the page and pressing the button.

## D19 — The sign-in that failed in four milliseconds · 2026-08-09

**Context.** First real magic link, first real sign-in. The link was clicked; the browser landed
back on `/login` with no message. The only trace anywhere:

```
GET /auth/callback?code=9d5e961e-… 307 in 4ms (application-code: 3ms)
GET /login 200
```

**Four milliseconds is the whole diagnosis.** A PKCE code exchange is a network round trip to the
provider — two hundred milliseconds at best. This failed locally, before a packet left the machine,
which narrows it to one thing: the `code_verifier` cookie was not in the request. `signInWithOtp`
stores that verifier in the browser that asks for the link; the browser that OPENS the link has to
be the same one, and a mail client's in-app browser is not. Confirmed by reproducing it with a
fabricated code — Supabase's own text is *"PKCE code verifier not found in storage… initiated in a
different browser or device."*

**The defect was not the cookie. It was that the codebase already knew and did not say.**
`exchangeCodeForSession` returns a fully descriptive error and the route discarded it:

```ts
const { error } = await supabase.auth.exchangeCodeForSession(code);
if (error) return NextResponse.redirect(new URL('/login', url.origin));
```

That line was written for a good reason — the wire must not distinguish authentication outcomes
(ADR 0006 §5) — and it over-applied it. **A protocol failure is not an authorization answer.**
"Your link could not complete an exchange" reveals nothing about who is a member; it is not the
membership oracle the rule exists to prevent. Collapsing it to silence bought no security and cost
the entire diagnosis, for the user *and* for us.

**The decision.**

- The callback **logs the provider's reason**, including whether a `-code-verifier` cookie was
  present — the single fact that separates the common cause from every other one. Server-side only,
  the same split `AuthError.kind` and `NotSignedIn.reason` already use.
- It redirects with a coarse `?reason=` describing the LINK: `browser`, `expired`, `link`.
  Membership stays silent, permanently, and there is no reason code for it.
- It handles the provider's own error redirect (`error_code=otp_expired`), which arrives with no
  `code` at all and was previously indistinguishable from an empty visit.
- `/login` became a Server Component around the form so the message resolves during render.
  Reading `window.location` in an effect and calling `setState` is a cascading render the lint rule
  rejects; `useSearchParams` in a prerendered client component needs a Suspense boundary. Resolving
  on the server avoids both, and keeps the wording next to the argument for it.
- Some provider failures arrive in the URL **fragment**, which no server ever sees. The client
  rewrites those as the query form — a navigation, not a second copy of the state.

**The pattern, since this is the third entry about it.** D17: a criterion marked met without anyone
opening the page. D18: a variable the server could read and the browser could not. Now: an error the
code held in its hand and dropped. Each time the machinery was correct and the *observability of a
human-facing path* was the thing missing. Errors that reach a person are a feature with a spec, not
exhaust.

**Reversible?** The logging, trivially. The `?reason=` vocabulary is public copy — adding a code that
distinguishes members from non-members would undo ADR 0006 §5, so the three that exist are the three
there should be.

## D20 — A document's life after its file moves · 2026-08-09

**Context.** ADR 0003 chose the file path as identity and wrote the cost down honestly: *"a file
rename is currently a delete-plus-create — the old `DocId` (and anything later attached to it) is
lost."* Routed to R5, and left there for two milestones.

Reading it again with real data in the vault, "named property, not an oversight" is doing a lot of
work. The behaviour was **data corruption on an ordinary action**. Reorganise a folder, re-ingest,
and every `import_events` row, access-log entry, and agent reference pointing at the moved documents
is orphaned while the documents themselves appear twice. Deleting a file did nothing at all, so the
vault only ever grew. The Import screen was already showing the symptom — the same titles listed
twice — and it read as a display quirk.

**The reframing that unlocked it.** The original rejection table treats this as a binary: path
identity breaks on a move, content-hash identity breaks on an edit, pick your poison. It is not
binary. **Identity stays the path; the content hash becomes evidence used at exactly one moment —
deciding what a disappearance means.** An edit is still an update, because the path did not move. A
disappearance is now a question with three possible answers rather than one assumed one.

**The decision, and the three places it is deliberately timid:**

- **A move keeps the `DocId`** — matched when exactly one vanished document and exactly one arriving
  file share a content hash. Then the ordinary write runs, because `folder`, `tags`, and the search
  vector are all derived *from the path*. That second half is not a detail: I shipped the relocate
  without it and a test caught a document moved from `Architecture/` to `Design/` still filed under
  `Architecture` — offering a Library filter pill for a directory that no longer existed. Identical
  bytes do not mean nothing changed.
- **Ambiguity is left alone.** Two files with the same hash is ordinary — empty files, copied
  templates, generated stubs. A wrong match rewrites one document's identity to another's path
  silently, which is strictly worse than the bug being fixed. Where it cannot tell, it does what it
  did before.
- **Deletion is proposed always and performed only on `--prune`.** `externalId` is relative to the
  scanned root, so ingesting a subfolder produces a run where nearly every stored document is
  legitimately unseen. On by default, one narrower-than-usual command empties the vault and prints
  success. So the missing list prints on every run — a dry run nobody opts into — and the flag is
  what acts.

**Tombstone, not `DELETE`.** `import_events.doc_id` and `access_log.doc_ids` point at these rows,
and an audit trail that loses entries when the thing they describe is removed has lost them exactly
when someone needs to ask what happened. A mis-scoped prune is then recoverable by clearing one
column. And a returning file reclaims its original id.

That last case is the one that breaks a naive implementation, and it is worth naming because nothing
about it looks like an edge: restore a pruned file unchanged, and its content hash still matches, so
the ordinary comparison says `unchanged`, nothing is written, and the row stays tombstoned while the
run reports the file as present. A tombstoned prior therefore forces `changed`.

**Verification.** Nine tests against real Postgres via PGlite, and the five load-bearing guards were
each mutation-tested — removing the tombstone-forces-rewrite rule, letting prune delete renamed
documents, allowing an ambiguous match, dropping `deleted_at` from the search filter, and skipping
the re-derive after a relocate all turn the suite red. Then proven live end to end: move a file, and
the id survives with its folder re-derived; delete one, and it is reported but untouched until
`--prune`; restore it, and the same id comes back.

**Reversible?** The column and the flag, easily. The *rule* is the commitment: a content hash now
carries identity weight at one moment in the pipeline, and anything that weakens the
exactly-one-to-exactly-one condition trades a stated limit for silent wrong matches.

## D21 — The screen that shows credentials, and what it is not allowed to show · 2026-08-09

**Context.** M7's closing condition is "a user can see and revoke what each connected agent can
reach." Every part of that has worked from a terminal since increment 1. The screen has no handoff
design — `design/handoff/` covers Library, Import and Reader only — which is why it sat unbuilt
while everything behind it was finished and proven.

**The design decision is that there isn't one.** It borrows `screen-import`'s layout: single column,
same max width, header → list → section label. Two screens invented in the same week should not also
invent two layouts, and these are siblings in the information architecture — both are about
connections rather than documents. Built from existing tokens only, like `/login`, so designing it
properly later means replacing one CSS module.

**Two rules did the actual work.**

**1. No credential material reaches the browser.** `last4` and nothing else — not the hash, not the
token id, not the presented string. Deciding whether a credential should keep existing needs a name,
a reach, and a last-used, none of which authenticate anything. Enforced at the store rather than in
the view: `listAgents` never selects `token_hash`, so a future component cannot render what was
never fetched. A management UI able to display a secret is a way to leak one over a shoulder.

**2. Reach is three cases and they stay distinct.** `sourceIds` NULL reaches every source, `[]`
reaches none, a list reaches those. The `?? []` that looks like defensive coding renders the most
powerful credential in the workspace as the most harmless one — a screen telling an operator not to
bother revoking the thing they most need to revoke. Mutation-tested: introducing that exact `??`
turns the suite red.

**Revocation, and the three things that make it trustworthy rather than reassuring.**

- **One statement, not two.** `SqlDriver` is a bare `query` and a `pg.Pool` can route two calls to
  two connections, so there is no transaction holding a principal update and a token update
  together. A failure between them leaves a revoked agent whose tokens still authenticate — exactly
  the state this screen exists to make impossible.
- **The token sweep is not gated on the principal update.** Revoking an already-revoked agent still
  sweeps any surviving token. The repair path matters more than the tidy report, and an operator
  clicking Revoke a second time is precisely someone trying to repair one.
- **It reports what the database did.** D16's lesson, moved into the UI: an optimistic "revoked"
  makes the operator stop looking while the credential is still live.

**A POST through a server action, never a link.** A GET that revokes is revoked by a link
prefetcher, a crawler, or a browser restoring tabs. `principalId` arrives from a browser and is a
*selector, never an authorization* — scope is re-derived from the session cookie and the query is
filtered by the workspace that comes back, so a crafted id from another workspace matches no row.
The action lives in its own `'use server'` module because that directive publishes every export in
its file.

**Revoked agents stay on screen, greyed.** Deleting the row answers "did that actually work?" by
removing the evidence, which is the one question this screen has to answer well.

**Closed by exercising it.** The `Done when` names something user-visible, so per D17 it was closed
by minting a throwaway agent, pressing Revoke in the browser, and confirming in the database that
the principal and its token were both revoked — not by a green suite.

**Reversible?** The layout, entirely. The two rules are not: relaxing either is how a management
screen becomes a disclosure.

## D22 — Three connectors, three different mechanisms, one costume · 2026-08-09

**Context.** R5 has carried one open question since M5 was designed: *are Claude and Cursor exports
accessible at all without scraping?* The register said "verify before committing to adapter scope —
the answer may be GitHub only." Nobody verified, and M5's remaining scope sat as three
interchangeable checkboxes: "Claude and Cursor adapters", "GitHub adapter".

Verified now, and the checkboxes were the wrong shape. The handoff draws four identical rows with a
`Connect` link. Behind them are **three incompatible mechanisms**, and the row that looks the same
as the others is the one that cannot exist.

| | What exists | What that makes it |
| --- | --- | --- |
| GitHub | Documented, versioned, authenticated REST API | A connector |
| Claude | Settings → Privacy → Export data. Emailed link, expires in 24h, interactive sign-in required, **no API** | A file drop |
| Cursor | Nothing official. SQLite key-value blobs in the user's app-support directory | A reverse-engineered read |

**Claude has no connector-shaped surface, and that is not a gap to work around.** Export is manual,
the delivery is an email link that expires in twenty-four hours, and downloading it requires an
interactive signed-in browser session. There is no OAuth, no pagination, no incremental sync — the
four things `SourceAdapter` was designed around. Building it as a "connector" would mean building a
credential store, a refresh loop, and a sync schedule around a thing a human does by hand once. It
is an **import**: the user drops the export, we ingest it.

That is a better fit than it sounds. Conversation `uuid` is a genuinely stable identity — strictly
better than the Markdown adapter's path identity, which is what D20 spent today repairing.

**Cursor is not being built, and the reason is a date.** Cursor **3.0, April 2026**, shipped a
breaking one-way database migration: per-workspace indexes became a global one,
`composer.composerData` became `composer.composerHeaders`, and messages moved out of a
`conversationMap` field into individual `bubbleId:` entries. The format is undocumented, it carries
no compatibility promise, and **it has already broken once within the last four months**.

*Rejected: best-effort with a version check that fails loudly.* It sounds responsible and it is
worse than nothing here. The failure does not arrive when we ship — it arrives on a Cursor update
the user did not know was significant, in a product whose entire proposition is that their knowledge
is findable. The moment it matters most is the moment it breaks, and they will reasonably blame
Strata. A connector we cannot keep working is a promise we cannot keep.

*Rejected: reading it anyway because tools exist that do.* Third-party tools reverse-engineer this
successfully. They are also single-purpose, break openly, and have no obligation to a user's vault.
We would be inheriting their maintenance burden and their breakage while carrying a durability
promise they never made.

**Consequences.**

- M5's scope is **Claude as an import, GitHub as the only true connector, Cursor not at all**.
- `SourceAdapter`'s fetch/pagination shape is right for GitHub and wrong for Claude. Claude does not
  need it, so it does not get one — an adapter interface bent to accommodate a mechanism it does not
  describe is how the abstraction stops meaning anything.
- **The Import screen has to stop lying.** Four identical `Connect` rows advertise one mechanism for
  three, and one of the three will never exist. This is the same class of defect as the Agent Access
  nav item that 404'd: a control that describes a capability the system does not have.

**Reversible?** The Claude and GitHub decisions, easily. Cursor is reversible the day Cursor
publishes a supported export — which is the condition to revisit on, not elapsed time.

## D23 — The audit trail was erasing its own attribution · 2026-08-09

**Context.** The access log has been collected since M6 and read by nobody — ADR 0005 §5 specified
it as the compensating control for fencing being incomplete ("an injection that succeeds is
discovered here or not at all"), and M7 increment 3 finally rendered it. Building the view surfaced
two defects that only a reader could have found.

**1. The most important rows were unreachable by the only reader.** `AccessLog.recent` filters on
`workspace_id`, and a call that fails to authenticate *has no workspace* — the column is null
exactly there. So the rows the schema comment calls "the point" — *a stream of failed
authentications is what a credential being probed looks like* — could not be returned by the method
written to surface them. Collected faithfully, queryable by nobody.

Closed by `unattributedFailures(since)`, and deliberately as a **count, not a list**. Those entries
have no workspace, so there is no honest answer to whose they are; attributing them to whichever
workspace happens to be looking would invent one, and in a multi-workspace deployment would show
one tenant a signal generated by another. A count says *something is knocking* without claiming to
know on whose door.

**2. `mcp:smoke` was deleting the principals it logged against.** Its cleanup removed the throwaway
agent entirely, with a comment explaining why: otherwise repeated runs accumulate dead agents in the
Agent Access list. A real concern, and the wrong fix — it broke an invariant this codebase already
states, in `removeMember`'s own documentation: **never delete, the access log has to stay
attributable.**

The consequence was invisible until something read the log. Every call the smoke test ever made was
recorded against a principal id the cleanup then removed, so the Recent activity view opened on a
column of `unknown` actors. **An audit trail losing attribution retroactively is the one thing it
must never do**, and this was doing it on every run — silently, in the script whose whole job is
proving the system behaves.

Now it revokes and keeps the row. What accumulates is a dated, revoked entry per run, in the section
of the screen that exists to show exactly that. Honest history reads better than a clean list that
quietly erased it.

**Rejected: denormalising the actor's name onto each log row.** It is the textbook audit design and
it would survive deletion. It was rejected because the name is not on the authentication path —
`AuthLookup` carries id, kind, workspace and grant, not a display name — so capturing it would mean
either a second query per MCP call, against ADR 0006 §4's one-lookup-no-cache discipline, or
widening the most heavily reviewed type in the repo for a display nicety. Read-time resolution plus
"don't delete principals" achieves the same outcome without touching the front door.

**The pattern, third time this week.** D17: the Library shipped without search because nobody opened
the page. D22's Claude hash: the adapter was right in isolation and the loop was wrong, found by
running the CLI twice. Here: a table filled correctly for a whole milestone with a reader that could
not see its most important rows. **Writing is not the same as being read, and neither is tested by
the code that writes.**

**Reversible?** Yes. The invariant is not: any hard delete of a principal silently rewrites history
in a view built for incident response.

## D24 — The Import screen's buttons finally do the thing they name · 2026-08-10

**Context.** `Import` (Claude) and `Upload` (Local Markdown) had been inert since M3. The handoff
marks them as visual endpoints (README:75-76) and that was read as a requirement rather than as the
placeholder CLAUDE.md non-negotiable 5 says it is. Meanwhile both importers worked perfectly from a
terminal for the whole of M5 and M7.

**Decision.** Wire them, through **the CLI's own path** — same adapters, same `runIngest`, same
`persistIngest`, same `Scope` minted from the caller's session. `apps/web/src/app/import/actions.ts`
holds nothing but the two Server Actions, because `'use server'` publishes every export in a file as
a remotely callable endpoint. GitHub keeps a disabled `Connect`, honestly, because no adapter exists
behind it.

**Rejected: a web-only ingest route.** A second way to write into the vault is a second thing to
review, and the one nobody reviews is the one that ships a bug. Uploads go through `scanMarkdown`
itself over an in-memory filesystem port, so identity, canonicalization, frontmatter rules, the
failure taxonomy and the NUL check all apply because it is literally the same code.

**Uploads can never prune, and there is no parameter to make them.** The CLI keeps `--prune` because
an operator typed a sentence naming a whole source. A browser upload is the worst place to infer
deletion: the user picked one file, or dragged one folder of a larger vault, so almost every stored
document is legitimately absent. Missing counts are reported and never acted on.

**It got worse before it got better.** D22 relabelled Claude's control from `Connect` to `Import`.
That described the mechanism accurately and thereby made a dead control read as *more* actionable —
a fidelity improvement that degraded the product. Naming a thing honestly is not the same as
providing it.

**Reversible?** Yes, and cheaply — the controls are additive and the backend predates them.

## D25 — A session that ends after an hour is not a session · 2026-08-10

**Context.** Supabase access tokens live ~1 hour. Nothing renewed them. `claimsFromCookies` verifies
locally and returns `undefined` past `exp`, which every screen turns into a redirect to `/login`.
The only client that can self-refresh is imported by the login form alone, so it never ran anywhere
a signed-in person goes.

On the free provider plan — two emails per hour, rolling — the remedy for an expired session was a
resource we did not have. The app was shippable to teammates only in the sense that they could sign
in once.

**Decision.** `apps/web/src/proxy.ts` renews the credential when it is within five minutes of
expiry, decided by decoding `exp` locally (`lib/token-expiry.ts`). Ordinary navigation costs one
base64 decode and no network call.

**What it is explicitly not.** Not an authorization check: it reads no membership, mints no `Scope`,
and *discards* the `getUser()` result, because trusting it is how a middleware quietly becomes the
access-control decision (ADR 0006 §5). Not a cache: ADR 0006 §4 stands, and a member revoked one
second ago is refused on the very next request despite a just-renewed token. Renewal and permission
are different questions; only the second is cached-never.

**Rejected: `getUser()` on every request**, the pattern the provider's own docs show. It puts a
network hop on every page render and contradicts `session.ts`'s central claim that verification is
local. The skew check gets the same result for ~1/60th of the calls.

**`/auth/callback` is excluded from the matcher.** It runs its own code exchange and writes its own
cookies; two writers on one response race, and the loser's cookies are what the browser keeps —
breaking sign-in in the name of preserving it.

**Why this took four rounds to find.** An expired session and a broken one are indistinguishable
from a browser: both are a bounce to `/login`. Three real causes were found and fixed first (the
build-time `NEXT_PUBLIC_*` gap, the local issuer's early return, a spent identity binding), and each
fix was followed by a test that had, by then, sat idle long enough to expire. Every retry looked
like the previous bug not being fixed.

This is D17/D22/D23's property in its temporal form: **writing is not the same as being read, and
neither is tested by the code that writes.** The session was written correctly and read correctly.
Nothing tested what it was an hour later, because the whole suite runs in under a second.

**Reversible?** Yes — deleting the middleware restores the previous behaviour exactly.

## D26 — The sign-in diagnostic was contradicting the provider, one line apart · 2026-08-10

**Context.** A returning magic link failed and the log said, consecutively:

```
code exchange failed: PKCE code verifier not found in storage ... (code_verifier cookie present)
```

Both halves were produced by us. The provider said the verifier was missing; our own check said it
was there.

**Cause.** `@supabase/ssr` 0.12 keeps the PKCE verifier in **per-flow slots** —
`<storageKey>-flow-<flowId>-code-verifier` — alongside a fixed `<storageKey>-code-verifier` and an
index `<storageKey>-flows-code-verifier`. Requesting a new link writes a new slot and evicts older
ones. Our check was `name.includes('-code-verifier')`, which matches all three, so it answered
"present" whenever *any* flow was pending, including the one that had just displaced the link being
clicked.

**Decision.** Match only the slot pattern, and classify **three** states instead of two:

| Slots | Provider said | Reason | What the person is told |
| --- | --- | --- | --- |
| 0 | anything | `browser` | Open it in the browser you asked from |
| >0 | verifier not found | `stale` | **Open the newest email** — a new request cancels older ones |
| >0 | anything else | `link` | Request a new one |

**The middle row is the point.** It was previously collapsed into `link`, whose copy says "request a
new one" — which is precisely what *caused* the failure, and on a plan capped at two emails an hour
that advice spends the person's last one. The fix is not merely a better message: the working link
was already in their inbox, and we were telling them to invalidate it.

**Also added: `token_hash` support on the callback.** It needs no verifier, so it completes in a mail
app's in-app browser, on a different device, and from an older email — the entire class of failures
above. It is only produced if the email template sends `{{ .TokenHash }}`, so handling both forms
lets that be changed later without a code change and costs a project that never changes it nothing.

**Rejected: dropping PKCE for the implicit flow.** It returns tokens in the URL fragment, which a
server never receives, and this app decides everything server-side.

**Reversible?** Yes; both changes are additive.

## D26 — Local development stops asking you to sign in · 2026-08-10

**Context.** Three days were lost to sign-in bugs (see `06-auth-debug-log.md`). Even after all six
causes closed, testing the app still began with pasting `/auth/dev-login?email=…` — login wearing a
hat, and one more thing to get wrong while the real flow was still blocked on a dashboard change.

**Decision.** With `STRATA_DEV_AUTH=1` **and** `STRATA_DEV_EMAIL` set, `/login` redirects to the
local issuer instead of rendering the form. `npm run dev:inside` sets both. Opening the app signs
you in.

**This weakens no guard, and that is the whole point of where it lives.** `localIssuerAllowed()` is
untouched — an explicit opt-in plus three independent proofs the process is not deployed — and
`/auth/dev-login` re-checks it and 404s otherwise. The address must still be on the workspace
allowlist to see one document. All that changed is who types the URL. Verified: on the production
build `/login` still renders the form, and `localIssuerAllowed()` is false under `NODE_ENV=production`.

**Rejected: minting the session in `proxy.ts`.** It is the shortest path and it would have made the
proxy able to CREATE authority — directly against the property D25 just established, that the proxy
decides nothing. A dev convenience is not worth blurring the one boundary that was hardest to get
right.

**The loop guard is load-bearing.** The redirect fires only when no local cookie exists. Once one
does, arriving at `/login` means the session was refused for a real reason — not on the allowlist,
membership revoked — and redirecting again would loop forever while hiding the message that explains
it.

**Reversible?** Yes. Unset `STRATA_DEV_EMAIL` and the form returns.

## D27 — Re-scoping an agent without destroying it · 2026-08-10

**Context.** The Agent Access screen had exactly one lever: Revoke. Narrowing an over-scoped agent
meant destroying it, minting a replacement, and redeploying whatever held the token — enough friction
that the realistic outcome is the over-scoped agent simply stays.

**Decision.** `rescopeAgent` replaces the grant and moves the agent's live tokens onto it, in ONE
statement. Grants are replaced rather than edited, so history survives: "what could this agent reach
last Tuesday" is a question an incident review asks, and an in-place `UPDATE source_ids` destroys the
answer.

**Why one statement is not optional.** `grants_one_active` is a partial unique index, so re-scoping
is revoke-then-insert; between those two writes every live token points at a **revoked** grant, and a
token whose grant is revoked authenticates and then fails `mintScope` with `AuthError('revoked')`.
Split across two calls, `pg.Pool` may route them to different connections — the reason this codebase
uses data-modifying CTEs rather than BEGIN/COMMIT at all — so the window is not merely short. A crash
between them leaves it open indefinitely, silently disabling an agent the UI has just reported as
successfully re-scoped.

**Mutation testing corrected the design's own explanation, and that is the entry worth keeping.** The
first version of this comment claimed both `EXISTS` guards enforced CTE ordering. Only one does:

- `replaced -> inserted` **is** ordering. Removing it fails seven tests — the old grant must leave the
  partial index before the new row enters it.
- `inserted -> moved` is **not**. Foreign keys are checked by AFTER triggers at statement end, so the
  new grant exists whatever order the CTEs ran in. Removing this guard broke **nothing**, which is
  exactly how a confident, wrong explanation survives review. Its real job is refusing to repoint live
  tokens at a grant that was never inserted *because the re-scope was refused* — reachable only when a
  principal is revoked while its tokens are not, a state `revokeAgent` never produces but an operator
  can. The test that kills it now exists.

**Rejected: a checkbox list.** `undefined` reaches every source, `[]` reaches none. A UI where
unticking the last box silently means "everything" would be the most dangerous control in the app, so
the mode is an explicit three-way choice and the checkboxes live inside one of its branches. Ticking
nothing under "only the sources I pick" is refused by name rather than quietly submitted as deny-all.

**Refusals are silent and return zero**, never throw: a revoked principal, and any principal of kind
`user`. Re-scoping a revoked agent would mint a fresh ACTIVE grant onto a dead principal — a
live-looking credential on something an operator believes they already shut off.

**Reversible?** Yes. The old grant rows are kept, so any previous scope can be restored by setting it
again.

## D28 — The Library could only ever show fifty documents · 2026-08-10

**Context.** `docs.list` is clamped to `MAX_RESULTS` (50). The Library reported the true total and
said plainly that it was showing a subset, which is honest — and still meant every document past the
newest fifty was **unreachable from the main screen**. The vault stood at 47 with upload buttons
newly shipped (D24). "Honest about hiding your data" is not a feature.

**Decision.** `docs.list` takes an `offset`; the Library takes `?page=`. The ceiling is unchanged —
no single call returns more than 50 rows, which is the anti-exfiltration property an agent is held
to. Paging asks for a *different* fifty, not a bigger page.

**The tiebreak is the load-bearing part.** Ordering was `updated_at DESC` with no unique final key.
This vault has 47 documents across **30 distinct timestamps** — seventeen share one with a
neighbour, four sit on a single timestamp — so Postgres was free to return tied rows in any order
between two queries. Stable enough to look correct on one page; under OFFSET it shows a document on
page one *and* page two while another is never shown at all. `ORDER BY updated_at DESC, id DESC` in
`list`, and `rank DESC, updated_at DESC, id DESC` in `search`. Held by a test that pages through 60
documents sharing one timestamp and asserts the union is exactly 60.

**Folder pills moved to the server, and that was not optional.** They were `docs.filter(...)` over
the array already on screen, so a pill meant "documents in this folder *among the newest fifty*" — a
folder whose documents all sat beyond that rendered an empty grid under its own pill. Paging turns
that from a large-vault edge case into the ordinary one. `docs.list` and `docs.count` had both taken
a `folder` option the whole time. The pills are now links carrying `?folder=`, and the round trip is
the cost of the answer being correct.

**A test caught a bug in the guard written to prevent bugs.** `Math.max(0, Math.floor(offset))` looks
like it clamps everything. It does not clamp `NaN` — `Math.max(0, NaN)` is `NaN`, which reaches
Postgres as the literal string `"NaN"` and 500s the page. `?page=abc` was enough. Now
`Number.isFinite` decides, and every hostile value renders a real page.

**Rejected: "Load more" accumulating into one long list.** It would mean either returning more than
`MAX_RESULTS` from one call, breaking the ceiling for the sake of a scroll, or holding merged state
in the client. Prev/Next keeps every call bounded and every URL shareable.

**Rejected: numbered pages.** The handoff has no pagination design at all. Prev/Next plus "51–100 of
120" is the smallest thing that makes the vault reachable; page numbers under a card grid is a design
decision, and inventing one under deadline is how drift starts (R9).

**Verified by using it**, not by the suite: 53 documents, page 1 returned 50 and page 2 returned 3,
with **zero overlap** and a union covering the whole vault. The probe rows were removed afterwards.

**Reversible?** Yes. `offset` defaults to 0 and `?page=` defaults to 1, so the previous behaviour is
what you get by not passing them.

## D29 — The GitHub adapter, and why it is ninety percent not GitHub code · 2026-08-10

**Context.** GitHub was the last of the four connector rows with nothing behind it, and the only one
of the four with a real API. "Indexes READMEs, ADRs, and PR descriptions" had been on screen since
M3 describing a capability that did not exist.

**Decision: the GitHub-specific code is FETCHING, and nothing else.** Once a file's text is in hand
it is Markdown, and Markdown already has an adapter. Identity, frontmatter, title/excerpt/folder/tag
derivation, `normalizeIngested`'s fencing, the NUL check and the whole failure taxonomy are
`scanMarkdown`'s, reached through the same in-memory port a browser upload uses. `github.ts` has no
`deriveTitle` of its own — if it did, the abstraction would be wrong, which is exactly what
`packages/ingest/src/index.ts` has always said.

**Network behind a port.** Every interesting case here is a failure — a truncated tree, a rate
limit, a moved default branch, a binary file wearing a `.md` extension — and none is reachable from
a test that has to hit api.github.com. 21 tests, all of them against a fake port except the four
that exercise the HTTP layer through an injected `fetch`.

**One Source per repository**, `src-github-<owner>-<repo>`. Not a shared `src-github`: `externalId`
is the path *within* a repo and `README.md` exists in almost all of them, so two repositories on one
source would silently overwrite each other. The consequence is that the Import screen had to render
sources beyond its three fixed slots — a gap `screen-import` predicted in the abstract and which now
had a real cause, so it closed with it.

**Timestamps are the repository's `pushed_at`, for every file.** Per-file commit dates are accurate
and cost **one API request each**; on the unauthenticated ceiling of 60 requests an hour a 40-file
repo would die halfway. A coarse date beats a partial import. The consequence — every file from one
repo shares a timestamp — is why D28's `id` tiebreak does real work rather than decorative work.

**`--prune` is refused on an incomplete scan.** Pruning means "stored but absent is gone", which is
only true if the listing was complete. A truncated tree or a `--max-files` cutoff produces a partial
listing *identical in shape* to a complete one, so honouring `--prune` there would tombstone every
document that merely fell outside the ceiling. The user asked to remove deleted files, not the ones
we did not look at.

**403 is both "forbidden" and "rate limited"** on this API, told apart only by
`x-ratelimit-remaining`. Reporting a rate limit as an auth failure sends someone off to regenerate a
token that was working perfectly, so they are distinguished and each carries its own fix.

**No token is a first-class path.** Public repositories work with nothing configured, at 60
requests/hour. `GITHUB_TOKEN` raises it to 5,000 and unlocks private repos. The token is sent as a
bearer header and never placed in a URL, held by a test that asserts it appears nowhere in the
request path — query strings reach access logs, proxies and referrers.

**Verified by using it**, not only by the suite: `octocat/Spoon-Knife` from the CLI (1 new, then
`unchanged 1` on a second run — idempotent), `facebook/react` reporting **1996 found, 12 imported,
incomplete: true**, and `octocat/git-consortium` indexed **from the website**, reporting "2 new".

**Still not built:** PR descriptions and Issues, which the row's copy also promises. Markdown files
are the whole of it today.

**Reversible?** Yes. Nothing else depends on it, and each repository is an independent Source.

## D26 amendment — the loop guard tested the wrong thing · 2026-08-10

D26's auto sign-in skipped the redirect when a local cookie was **present**. The local issuer's
signing key is generated per process and never persisted, so **every dev server restart invalidates
every local cookie** — presence then meant "you already have a session" about a cookie nothing could
verify, stranding you on the sign-in form the branch exists to skip, with no way out but clearing
cookies by hand. Restarts are constant; this fired on all of them.

It now verifies the cookie instead. The guard's purpose survives: a cookie that verifies and still
lands on `/login` was refused for a real reason, and redirecting again would loop while hiding the
message that explains it. Found by opening the page after a restart — not by any test.


## D30 — The Markdown hash did not cover everything the document derives from · 2026-08-10

**Context.** `scanMarkdown` hashed the file's bytes: `contentHash(raw)`. But `folder` falls back to
the scan ROOT's basename for a file at the top level, and the root name is not in the file. So the
same README ingested from a differently-named directory produced an identical hash, the pipeline
decided `unchanged`, nothing was written, and the vault kept the old folder forever — while the run
reported success.

**This is D22's bug, in the adapter D22 cited as having got it right.** `claude.ts` says in a comment
that "the Markdown adapter has always had this right". It did not. Same bug, same shape, same
adapter family, and the comment asserting otherwise is now corrected in place.

**Found by using it, not by testing it.** A real README — the one the user had gone looking for —
landed in the vault filed under `readme-stage`, the name of a temporary staging directory, and would
have stayed there permanently. 34 markdown tests passed throughout. That makes four instances of the
same property (D17, D22, D23, D25): **writing is not the same as being read, and neither is tested
by the code that writes.**

**Decision — arrived at on the second attempt.** The content hash stays **content identity**:
`contentHash(raw)`, covering the file's bytes only. Derived-field drift is a separate question,
answered separately: `findKnown` now returns the stored `folder`, and the pipeline treats a mismatch
as `changed`.

**The first attempt folded `folder` into the hash, and that was wrong.** It broke three lifecycle
tests immediately. Rename detection (D20) works by matching identical hashes across different paths,
so a hash that moves when the folder moves makes every cross-folder move look like a brand-new
document and defeats the mechanism entirely. The failing tests caught a regression that the
accompanying decision-log entry had already talked itself into calling "the honest trade" — the
write-up was more confident than the code deserved, and the suite was right.

Splitting the two concerns keeps both properties: the hash survives a move, and a stale folder is
still corrected on the next ingest.

**One-time cost: none.** Because the hash is unchanged from what shipped, existing documents do not
rehash. The only documents rewritten are those whose stored folder genuinely disagrees with the
current scan — observed live as `changed 1, unchanged 4`.

**Verified live**, not only by the suite: re-ingesting one file from a renamed root reports
`changed 1` where it previously reported `unchanged`, and re-running from the original root reports
`unchanged 4` for the files that did not move.

## D31 — The local ingest walked other people's documentation · 2026-08-10

**Context.** `createNodeFileSystemPort` had no ignore rules. Pointing it at a project root — the
obvious thing to do, and what the CLI's usage line invites — walked **1,233** Markdown files in this
repository, of which **77** are the project's own. The other 1,156 were vendored package READMEs and
changelogs.

The practical effect was worse than noise: because running it at the root was unusable, nobody ever
did, so this repository's own READMEs were never indexed. **The product did not contain its own
documentation**, which is exactly the search that sent the user asking where a file was.

**Decision.** `IGNORED_DIRECTORIES` — `node_modules`, `.git`, `.next`, `.turbo`, `.cache`, `dist`,
`build`, `coverage`, `.venv`, `__pycache__` — matched on the directory NAME at any depth, because a
nested `packages/x/node_modules` is the normal shape of a workspace install, not an edge case.
Injectable, so the default is a decision rather than an assumption baked into the walker.

**Rejected: skipping dot-directories.** It is the shorter rule and it would have silently dropped
`.claude/`, which holds this project's own documentation and is precisely the file somebody went
looking for. A rule that hides the thing you are searching for is worse than no rule.

**Skipped silently, unlike a symlink.** A symlink is reported because someone who placed one there
expects its target imported. Nobody expects `node_modules` in their knowledge base, and reporting
1,156 skips would bury the failures that matter.

**Reversible?** Yes — pass `[]` and the previous behaviour returns, which a test asserts.


## D32 — Committing Markdown ingests it, and two bugs that only a repo-root scan could reveal · 2026-08-10

**Context.** The vault was a snapshot, not a mirror. A document written after the last manual ingest
simply did not exist as far as the Library was concerned — which is exactly how this repository's own
READMEs went missing for weeks, and how a user ended up asking where a file was rather than searching
for it.

**Decision.** A `post-commit` git hook re-ingests the repository's Markdown. Four properties, each one
a way this could otherwise become the tool everybody disables:

1. **post-commit, never pre-commit.** Ingest is a side effect of committing, not a condition of it.
   A pre-commit hook that needs a database blocks a commit on a plane.
2. **Never exits non-zero.** The commit has already succeeded; a failure here must not print an error
   over work that went fine.
3. **Runs detached**, logging to `.git/strata-ingest.log`. Nobody waits seconds for a commit.
4. **Does nothing when no Markdown changed**, which is most commits.

**No `--prune`, deliberately.** A commit is not evidence that a document should be deleted — you may
have committed on a branch that simply does not contain it. Removal stays explicit, at a terminal.

**The source of truth is `scripts/hooks/`, not `.git/hooks/`**, which git does not track: a hook that
lives only there exists on exactly one machine. `npm run hooks:install` copies it into place and
**refuses to overwrite a hook it did not write** — silently replacing somebody's commit-signing hook
is how a tool becomes untrustworthy the first time it costs them work.

### The reconcile, which had to happen once

Existing documents carried sub-root paths (`adr/0001-…`) from ingests pointed at `docs/` and
`context-graph/nodes/`; the hook scans the repository ROOT. Without reconciling, every document would
have duplicated at a new path.

It did not, and the reason is a feature working as designed: **`renamed 34`**. Rename detection (D20)
matched the old paths to the new ones by content hash and kept the original `DocId`s — which is
precisely the property the first attempt at D30 would have destroyed by folding `folder` into the
hash. 38 new, 34 renamed, 5 changed, 13 tombstoned. No duplicates, no lost identity.

### Bug found by running it: 147 failures per commit

The root scan reported **147 `unsupported-type` failures** — one per `.ts`, `.json`, `.css` file in
the repository. Harmless while the ingest was pointed at a folder of Markdown; absurd once it could
be pointed at a repository root, where every commit would have written 147 bogus failure events into
the audit trail and onto the Import screen, burying the failures that mean something.

**A file whose extension was never a candidate is now skipped silently.** It is not a document that
failed to import; it was never a document. Same judgement D31 makes about `node_modules` versus a
symlink.

**But a NEAR-MISS still reports.** `.mdx`, `.txt`, `.rst`, `.org`, `.adoc`, `.textile` are things
somebody reasonably expects to import, and silence there would read as "seen and quietly discarded".
The test asserts both halves: a `.ts` must not appear in failures, and both near-misses must.

Result: 147 failures to **0**, and a second run reports `unchanged 77` — idempotent.

**Verified by running the installed hook**, not by reasoning about it: against a commit touching no
Markdown it exits 0 and writes nothing; against one that does, it logs a timestamped entry and
ingests 77 files with 0 failures.

**Reversible?** `npm run hooks:install -- --uninstall`, or `STRATA_INGEST_HOOK=0 git commit` for one.


## D33 — A fixing pass over what already existed · 2026-08-10

No new features. Five defects, all in shipped code, four of them found by opening a page rather than
by running the suite — which stayed green through every one of them.

**1. The Reader clipped code blocks.** `.code` had no `overflow-x`, so any line wider than the 660px
reading column was cut off at the edge with no indication and no way to reach it. An ASCII diagram
lost its right-hand half; a directory tree lost the description beside every entry. The document
looked fine and was unreadable, which is the worst combination. Now `overflow-x: auto` with
`min-width: 0` — the flex child needs both or it pushes the whole column wide instead of scrolling.
`white-space: pre` rather than wrapping, because wrapping a diagram destroys the alignment carrying
its meaning.

**2. A control that did the wrong thing.** `ConnectorRow` chose its control from `kind` alone, so the
`src-claude-code` source — recovered transcripts, `kind: 'claude'` — rendered Claude's `Import`
button. That opens a Claude-EXPORT file picker and writes to `src-claude`: clicking it would have
imported a `conversations.json` into a different source than the row you clicked. Indexed GitHub
repositories had a milder version, their `Connect` starting a NEW repo rather than re-syncing that
one.

Rows are now either SLOTS (start an import) or RECORDS (state what exists, offer nothing).
Re-syncing an existing source is a CLI operation, and pretending otherwise on this screen is how a
control ends up doing something other than what its row says.

**3. Failed imports finally reach the user.** Open since M3. Failures were excluded from Recent
Imports for a correct reason — that list has no status indicator by design (README:24), so a failed
row reads as a success — and that correct reason was mistaken for a reason to show them nowhere. A
file that failed to import was simply absent, with nothing anywhere to say why, while ADR 0003 states
that recording failures exists precisely so a user can find out.

They now have their own section above Recent imports: file path, sanitized per-code reason, absent
entirely when there is nothing to report. Urgent rather than merely open since D24 — a person can now
cause a failure from the browser, and the browser was the one place that could not tell them.

**4. Recent imports silently dropped rows.** Titles were resolved from `docs.list(limit: 50)`, so an
event about anything outside the newest fifty matched nothing and the row vanished. The list quietly
stopped being a record of what happened and became a record of what is currently near the top. It now
falls back to the event's `externalId`, which is always present for a per-file event and identifies
the same thing.

**5. The source description rewrote itself on every run.** `ingest.mjs` set it to
`Markdown ingested from ${basename(target)}` — the folder just scanned. One Markdown source is fed
from several folders over its life, so after a one-off ingest of a scratch directory the Import
screen read "Markdown ingested from badfiles", describing the whole source by the last thing that
touched it.

**The pattern, again.** Five defects, 351 passing tests throughout. Four were visible the moment
someone looked at the screen. This is D17/D22/D23/D25/D30's property for the sixth time — **writing
is not the same as being read** — and the practical conclusion is not "write more tests" but "open
the page", which is now how each of these was found.
