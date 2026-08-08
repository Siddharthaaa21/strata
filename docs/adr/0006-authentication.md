# ADR 0006 — Authentication: agent tokens, human sessions, and completing the grant

**Status:** accepted, increment 0 implemented · **Date:** 2026-08-02
**Closes:** R7 · **Resolves:** ADR 0002 open items 2, 3, 4; ADR 0003 open item 3
**Builds on:** ADR 0002 — do not relitigate tenancy here

---

## Context

ADR 0002 settled residency versus capability. It did not settle identity, and the consequence is
already stated in three places in the repo: anything able to start the process gets the configured
workspace. `Scope` witnesses that a scope check *ran*; today what it witnesses is
`process.env.STRATA_WORKSPACE_ID`. Tenancy answers "which rows" and nothing answers "who is asking".

Three facts from this repo constrain the design more than any general reasoning about auth does.

**1. The MCP server holds `DATABASE_URL` itself.** `apps/mcp/src/index.ts` loads the repo `.env`
deliberately, so that no client config contains a secret. Anyone who can launch that subprocess can
read that file and connect to Postgres directly, bypassing `Scope`, `scopeFilter`, and every tool in
`apps/mcp`. This single fact determines what a local credential can and cannot buy, and most of §1
is downstream of it.

**2. The `Grant.sourceIds` gap was larger than first reported.** An independent review named three
store methods. Reading every method, it was five: `docs.upsert`, `docs.findKnown`, `sources.upsert`,
`events.append`, `events.recent` all derived only `workspaceId` from `scopeFilter` and dropped
`sourceIds`. Enforced correctly: `docs.search`, `docs.list`, `docs.get`, `sources.list`.

**3. The database is Postgres, hosted on Supabase.** The identity-provider question is therefore not
a greenfield vendor survey.

---

## Decision

**(A)** `Grant.sourceIds` gates **every** store method that takes a `Scope`, reads and writes alike,
with the write semantic "may write rows keyed to a source in the grant". Completeness is held by a
test that enumerates the live store surface, not a list of method names.

**(B)** An **agent principal** is created by a workspace member through the Agent Access screen. It
is bound to one workspace, one creating user, and at most one *active* `Grant`. It is revoked, never
deleted.

**(C)** Callers present an opaque bearer token, `stra_at_<tokenId>_<secret>`, verified by a single
indexed lookup per request. SHA-256 of the secret is stored; the secret is not.

**(D)** `packages/auth` gains `createAuthenticator(store)` exposing `scopeFromAgentToken` and
`scopeFromSession`. `mintScope` stays the only construction site, still called only from
`packages/auth`. **No Scope caching and no verification cache in M7.**

**(E)** Human sessions are **bought** (Supabase Auth). Agent tokens are **built**. Authorization —
`Grant`, `Membership`, `Scope` — is never delegated to the provider.

`localDevScope` is deleted. Local development uses a real, pre-seeded credential through the real
verification path, not a second code path.

---

## 1. What authenticates an MCP connection

The MCP authorization specification scopes OAuth 2.1 to HTTP transports and directs stdio
implementations to take credentials from the environment. So an environment token is the sanctioned
shape, not a shortcut.

**But be honest about what it buys.** Over stdio a token buys *no confidentiality against a local
attacker*, because of fact (1): anyone who can launch the server can read `.env` and reach Postgres
directly. Presenting the token as containment would be strictly worse than today's honest label — it
would stop the next reader looking. That is the same overclaiming D13 was written about.

What it genuinely buys, and what justifies building it:

- **Attribution.** The handoff shows "4 agents connected". Today Claude Code and Cursor launching
  the same binary are one anonymous caller. With per-agent tokens they are distinct `PrincipalId`s.
- **Narrowing.** Per-agent `Grant.sourceIds` is M7's entire point, and a grant needs something to
  attach to.
- **Revocation.** "Disconnect this agent" is meaningless against an unauthenticated process.
- **One code path.** The function written for stdio is the one a remote transport uses unchanged.

`STRATA_AGENT_TOKEN` in the MCP client's environment. The server refuses to start without it, for
the same reason `STRATA_WORKSPACE_ID` has no default: a server that silently picks a principal
silently serves the wrong one.

### What changes when remote transport arrives

| | stdio (ships first) | HTTP (later) |
| --- | --- | --- |
| Token source | `process.env.STRATA_AGENT_TOKEN` | `Authorization: Bearer` |
| What it protects | attribution + narrowing only | **also containment** — the server holds `DATABASE_URL`, the client does not |
| Transport needs | none | TLS, rate limiting, `Origin` validation, no token pass-through |
| Spec posture | env credentials, per spec | OAuth 2.1 + RFC 9728 + RFC 8707 |
| `scopeFromAgentToken(presented)` | unchanged | unchanged |

The signature not changing is the design goal. Our bearer token is a pre-shared credential and is
**not** MCP-spec-compliant remote authorization; when remote ships, OAuth becomes the thing that
*mints* a token and `scopeFromAgentToken` still takes an opaque string.

---

## 2. What a principal is

`Principal` stays minimal — it is embedded in `Scope` and fetched on every request, so every field
added is paid per call, and `displayName` is not an input to an access decision. `PrincipalKind`
widens to `'user' | 'agent' | 'service'` now: the ingest CLI needs a principal and is not an LLM
agent, and if it authenticates as `agent` it appears in the Agent Access screen's connected list.
Widening a closed union with no `switch` sites costs nothing today and costs a row migration after
the screen ships.

Enumeration for the screen is a separate read model (`AgentSummary`, `AgentTokenSummary`), never
carried in `Scope`. `displayName` is user-supplied and therefore rendered in the web app only —
never returned by an MCP tool, never interpolated into a tool description.

**At most one active `Grant` per principal**, enforced by a partial unique index. Not tidiness:
`Scope` holds a single `Grant`, so multiple active grants would need a union at mint time, and union
is the one operation that turns "narrows only, never widens" into its opposite. Re-scoping is always
revoke-then-issue, which also makes the access log show exactly when scope changed.

**Many tokens per principal**, so rotation has an overlap window instead of a gap where the agent is
broken.

Revocation has three levels — token, grant, principal — all checked at mint. Revocation never
deletes: the row must survive so the access log stays attributable.

---

## 3. Credential format and storage

```
stra_at_<tokenId>_<secret>
        │         └── 32 random bytes, base64url. Never stored. Shown once.
        └── 8 random bytes, hex. Stored in cleartext. Primary key.
```

The prefix is fixed and greppable so secret scanners catch one pasted into the repo. The `tokenId`
component makes verification a **primary-key lookup** rather than a scan-and-compare over every
stored hash — O(1) against O(n) on every MCP call.

Stored: `sha256(secret)`, compared with `timingSafeEqual`.

**Not bcrypt or argon2, deliberately.** Slow hashing defends low-entropy human-chosen secrets against
offline dictionary attack. This is 256 bits of CSPRNG output; there is no dictionary, and a 100 ms
KDF on every `search_docs` call buys latency and nothing else. Recorded because it is the reflexive
review comment that is wrong here.

**Expiry defaults to none for agent tokens.** A token that expires mid-workflow breaks a background
agent with no interactive path to renew. The property actually wanted — stale credentials get
noticed — is served by a visible `last_used_at` plus one-click revoke. The dev session token is the
exception at 30 days, precisely because it lives in a dotfile.

### `Source.credentialRef` is not this, and must never become this

| | `Source.credentialRef` | `AgentToken` |
| --- | --- | --- |
| Direction | **outbound** — Strata authenticating *to* GitHub | **inbound** — a caller authenticating *to* Strata |
| Value | a reference, never a secret | `tokenId` is public; the secret is never stored |
| Leaked | that one third-party account | that agent's read scope on this workspace |

They share a word and nothing else. No `credentialRef` on `Principal` or `AgentToken`; no
`tokenHash` on `Source`; separate tables; and **no tool or screen ever lists both in one view**. The
trap this paragraph exists to prevent is a future "Credentials" settings page or a
`list_credentials` tool that unions the two, at which point the distinction is gone permanently.

`grants.source_ids` is `text[]` where **NULL means all sources and `'{}'` means deny-all**. These
are not the same thing, and a `COALESCE(source_ids, '{}')` silently inverts deny-all into allow-all.

---

## 4. Where verification happens

`packages/auth` stays the only place a `Scope` is minted. It gains an `AuthStore` port that it
*declares* and `packages/storage` implements, so `packages/auth` never imports `pg` — no cycle, and
auth is testable without a database.

`scopeFromAgentToken(presented)`: parse → one indexed `lookupToken` → `timingSafeEqual` → revocation
and expiry checks → `mintScope`. A hash mismatch returns the same failure as an unknown `tokenId`;
distinguishing them confirms that a `tokenId` is valid.

`ServerDeps.scope()` becomes async and **the call moves inside the try block**. All failure kinds
collapse to one wire message, `Unauthorized`.

**`Unauthorized` is distinguishable from `NotFound`, and that is a deliberate exception to
mcp-surface rule 5.** Rule 5 exists so the error channel is not an enumeration oracle *over doc ids*.
A caller learning their own credential is bad enumerates nothing — they already hold it — and
collapsing it into `NotFound` would make a revoked agent look like an empty vault, which is an
unresolvable support problem. The oracle boundary is facts about the vault, not facts about the
caller's own credential.

**`STRATA_WORKSPACE_ID` disappears from the MCP server**: the workspace comes from the token, and
two sources of truth can disagree.

### No cache, and the reason is the UI copy

ADR 0002 open item 4 asked whether per-request minting is affordable. Resolved: yes, one indexed
lookup against a database the call is about to query anyway.

The rule that outlives this decision: **the maximum legitimate cache TTL equals the revocation
latency the Agent Access screen promises.** If the button says access ends immediately, the TTL is
zero. A cache added without changing that copy is a lie in the product, not a performance tweak.

---

## 5. Buy or build

**Human sessions — buy.** Sign-in, email verification, password reset, session fixation, MFA,
recovery. Every one is a well-understood way to lose a month and still be wrong.

**Agent tokens — build.** No provider offers long-lived, individually revocable machine credentials
whose authorization dimension is `Grant.sourceIds` over *our* `Source` rows. Provider API keys are
organization-level with the provider's own scope vocabulary; adopting one means writing a mapping
layer and owning both. What we build is roughly 150 lines plus two tables — smaller than the mapping.

**Recommendation: Supabase Auth**, on a fact rather than a feature comparison — the Postgres this
project runs on is already Supabase. Session JWTs verify against JWKS with no network round trip per
render; no new vendor. Ranked alternatives if that changes: WorkOS AuthKit, then Clerk, then Auth0.

**Accepted tradeoff:** sign-in gains a third-party availability dependency, and users' email
addresses live in someone else's database. What we refuse alongside it is authorization lock-in.

**Two rules make the provider swappable, and they are the entire point of buying:**

1. **The provider's subject id is never a `PrincipalId`.** It is a row in `user_identities`.
   Swapping providers rewrites one table instead of every foreign key and every access-log row.
2. **The provider never holds authorization.** No provider roles, orgs, or metadata is consulted by
   an access decision. It answers exactly one question: is this person who they claim to be. The
   migration trap in every one of these products is that their org model is *convenient*, and once
   membership lives there the provider is unswappable at any price.

---

## 6. The `Grant.sourceIds` gap — resolved both directions · **IMPLEMENTED**

**`sourceIds` gates reads and writes. It is not a read-only concept.**

1. **Read-only narrowing creates a write-only channel.** A principal narrowed to source A that can
   still `upsert` into source B injects a document it cannot itself read — which every other member
   of the workspace reads and the MCP server serves to every other agent. That is a data-poisoning
   primitive, and it is R2's threat with the roles reversed: R2 asks what ingested content can do to
   a reader; this asks who is allowed to be the ingester.
2. **`findKnown` was an oracle.** It returned `{docId, contentHash}` for a doc outside the grant —
   existence disclosure *and* content confirmation: hash a candidate file, ask, learn whether that
   exact content sits in a source you cannot read.
3. **`events.recent` enumerated the vault**, returning `sourceId` and `docId` for every source in
   the workspace to a principal explicitly narrowed away from them.

| Method | Out-of-grant behavior |
| --- | --- |
| `docs.findKnown` | returns `undefined` — indistinguishable from not-known |
| `docs.upsert` | throws `NotFound` |
| `sources.upsert` | throws `NotFound` |
| `events.append` | throws `NotFound`; checked for the whole batch before any write |
| `events.recent` | filtered in the `WHERE` clause, never post-filtered |

Deny-all means deny-all in every one, writes included.

**Kept complete by enumeration, not by a list.** `packages/storage/src/grant-completeness.test.ts`
reflects over each store, and **fails loudly on any method with no entry in its argument table** —
so adding a store method without deciding how it treats a narrowed grant is a red suite, not a quiet
hole. Per D13, the claim was verified before being written here: a deliberately-unregistered store
method was added and the suite went red naming it.

### What `Grant` means for an ingest job — ADR 0003 open item 3, resolved

An ingest run authenticates as a `kind:'service'` principal whose grant names the sources it imports
into. `sourceIds` is the set of sources a principal may read from *and* write to — one dimension,
both directions. ADR 0003's "deliberate, honest under-approximation" is now the actual rule.

**No `capabilities: ('read'|'write')[]` axis on `Grant`.** One write caller, one read caller class.
The hazard — a mutating MCP tool later making agent tokens writable — is closed structurally
instead: `apps/mcp` will depend on `ReadonlyDocStore = Pick<DocStore,'search'|'list'|'get'>`, making
D5's "no mutating tool exists" true at the type level rather than by absence of a line of code.
**The trigger for adding a capability axis is the first proposal to widen `ReadonlyDocStore`**, and
that trigger belongs in the risk register so it fires on someone else's watch.

### Per-source is enough for M7 — ADR 0002 open item 3

A doc-id allow-list is rejected: every ingest run invalidates it, it grows unboundedly per agent, and
"pick 40 of 312 documents" is not a control anyone operates twice. `folder`/`tags` narrowing stays
rejected for ADR 0002's original reason — both are `Derived<T>` with possible `model` provenance.

---

## 6b. Membership — decided 2026-08-04, shipping to a few teammates

The audience is a small team sharing ONE workspace, which resolves the shape of §2 rather than
adding to it. No workspace switcher (ADR 0002 open item 1 stays open and unneeded), no roles
(`Membership` stays flat per ADR 0002), no per-document permissions (deferred by ADR 0002 and
still deferred).

**The allowlist IS the invite.** `memberships` is keyed on lower-cased email; `principal_id` is
filled on first successful sign-in. Rejected: invite tokens with an accept flow. They add a token
to expire, a pending state that can be abandoned, and an email to deliver — for a team of a few
people who are already talking to each other. The allowlist fails in the safe direction: an
address nobody added cannot sign in at all, so a provider that will happily authenticate any
Google account cannot manufacture an orphan workspace member.

**The email selects the invitation; `(provider, subject)` decides who may claim it.** Added in the
round-five fixes (D16), because `user_identities` was being written on first sign-in and never read
— which made resolution run on email alone, so a *different* provider subject presenting the same
address inherited the first person's principal, grant and history. The address is precisely the part
an attacker chooses. An invitation is now single-use: the first credential to claim it is bound to
it, and a second is refused.

The deliberate cost: someone who legitimately signs in through a **second** provider with the same
address is refused rather than merged. That is the right default — merging on email is the classic
pre-hijack — but it is a real support question, so it is written down rather than rediscovered.

**Resolution is scoped to a workspace the caller names.** `resolveSession` and `scopeFromSession`
take a `workspaceId` parameter. They previously selected on email across every workspace with no
`ORDER BY` and took the first row, so a person in two workspaces landed in an arbitrary one that
could change between identical requests, and a revoked row sorting first locked out a member who
was active elsewhere. The workspace is the caller's context; it is never something a token gets to
choose.

**`removeMember` revokes the person, every agent RECORDED as created by them, and those agents'
tokens**, in one statement. Revoking only the person left their agents alive — a departing teammate
loses the web app and keeps an MCP token that reads the whole vault. That is the half of "remove
this person" that actually matters, and the half that is invisible, since nothing in the UI shows
an orphaned agent. A test asserting the opposite passed for a while precisely because it checked
the session and never the token.

"Recorded as" is load-bearing and was not true for the whole of increment 1: the sweep matches on
`created_by`, `NULL IN (...)` is never true in SQL, and `agent:create` never set the column — so it
revoked no agent at all, while the CLI printed that it had. `agent:create` now requires
`--by <member email>`, and `removeMember` returns counts so the CLI states what happened instead of
asserting what should have. **A tool that reports a revocation it did not perform is worse than one
that does not offer revocation**, because the operator stops looking.

**`addMember` restores, without widening.** Remove-then-re-add round-trips: membership, principal,
and a grant that INHERITS the narrowing of the one they last held. It previously minted the
replacement with `source_ids = NULL`, which means every source — so re-inviting someone deliberately
restricted to one source handed them the whole vault, through an action that reads as purely
administrative, with nothing afterwards to show it (`listMembers` reports membership, not scope).
Their old agent TOKENS stay revoked, deliberately: a revoked credential should need a deliberate
re-issue.

**`removeMember` does not revoke grants**, only the membership, the principal and its tokens. The
principal being revoked is what stops authentication, so the grant is inert; it is left in place as
the record of what that person could reach, which is also what `addMember` reads to restore them.

**What every member can do, stated plainly because flat membership is a real choice:** read every
document in the workspace, and create agent tokens with full workspace scope. There is no admin
or viewer distinction and no per-document ACL. For a handful of people who already trust each
other that is the right trade; it is the wrong one the moment the team is large enough that
"everyone" is not a list you can name.

**What no member can do:** add documents. Ingest is a local CLI (M5), so the vault updates when
whoever runs it runs it.

**Operated by `npm run member -- <list|add|remove> [email]`.** No UI — the Agent Access screen is
increment 3 and has no design. A CLI that does the right thing beats a screen invented under a
deadline.

---

## 7. Migration, and whether `npm run dev` gets worse

All six `localDevScope` call sites change and the function is deleted. `scripts/db-setup.mjs` is
worth naming: it calls `mintScope` directly from a `.mjs` file, outside the ESLint rule's `**/*.ts`
glob and outside the hook's `packages/auth` allowance. It is the last construction site outside
`packages/auth`, and removing it is an improvement independent of everything else here.

**`npm run dev` does not require a login.** `npm run db:setup` is extended to bootstrap: workspace,
owner principal, membership, unnarrowed grant, and two credentials written to `.env`. In development
with no session cookie, `vault()` falls back to `STRATA_DEV_SESSION_TOKEN` **through the same
`scopeFromAgentToken`** — same parse, same hash compare, same revocation and expiry checks, same
`mintScope`. It is a real credential a revocation kills, not a bypass.

**This is the most important property of the migration: dev convenience must never be a second code
path, because a second code path is what gets shipped by accident.** That is exactly how
`localDevScope` became load-bearing.

Guards: `packages/auth` throws at module init if `NODE_ENV === 'production'` and the dev fallback is
set; the dev token expires in 30 days. **Honest cost:** a long-lived credential in a dotfile. Weighed
against requiring a login for `npm run dev` — which makes the fast path painful and therefore
guarantees someone reintroduces a bypass — and given `.env` already holds `DATABASE_URL`, which is
strictly more powerful, this is the better trade.

### Increments

| | | Status |
| --- | --- | --- |
| **0** | Complete `Grant.sourceIds` enforcement + the enumerating test | **done** |
| **1** | Agent tokens on stdio: tables, `scopeFromAgentToken`, `STRATA_AGENT_TOKEN`, bootstrap | open |
| **2** | Human sessions: provider, `user_identities`, `vault()` async, delete `localDevScope` | open |
| **3** | Agent Access screen + access log | open |

Increment 0 is the prerequisite that makes the rest mean anything: issuing a narrowed grant before
it would have been security theatre, because five of nine store methods ignored the narrowing. It
lands alone, with no new tables, no provider, no signature change and no UI, and the system is
measurably safer than before it.

Sequencing the vendor decision last is what keeps it from blocking increments 0 and 1.

---

## Rejected

| Alternative | Why not |
| --- | --- |
| No credential for stdio ("the client is trusted") | Fine for confidentiality; gives no attribution, no narrowing, no revocation — which is all of M7. |
| A stdio credential framed as containment | False. The process reads `DATABASE_URL` and can bypass every check. Claiming otherwise is D13's failure. |
| Signed tokens (JWT), no DB lookup | Removes immediate revocation, the one property the screen sells. Revocation lists are a lookup with extra steps. |
| bcrypt/argon2 on the secret | KDFs defend low-entropy human secrets. 256 CSPRNG bits have no dictionary; buys latency per call. |
| Store the token itself | A backup, log, replica, or support session becomes a working credential for every agent. |
| No `tokenId` prefix | Verification degrades to scanning every stored hash. |
| One `Grant` per token | Rotation would silently change scope, and makes the unit of narrowing the credential rather than the agent. |
| Multiple active grants, unioned at mint | Union is the one operation that turns "narrows only" into its opposite. |
| `capabilities: ('read'\|'write')[]` now | One write caller, one read caller class. `ReadonlyDocStore` closes the hazard structurally. |
| `sourceIds` stays read-only | Creates a write-only injection channel into sources the writer cannot read. |
| Doc-id allow-list per agent | Invalidated by every ingest run; unbounded; no operable UI. |
| Build the human login | Password reset, session fixation, MFA, recovery. A month minimum, still probably wrong. |
| Buy the agent tokens | No provider's scope model is `Grant.sourceIds` over our `Source` rows; the mapping exceeds what it replaces. |
| Provider owns membership/roles | Makes the provider unswappable — the exact lock-in that buying identity is meant to avoid. |
| Provider `sub` as `PrincipalId` | A provider change rewrites every foreign key and access-log row instead of one table. |
| Keep `localDevScope` as a dev branch | A second unverified code path is what gets shipped by accident. |
| Require login for `npm run dev` | Makes the fast path painful, guaranteeing someone reintroduces a bypass. |
| Collapse `Unauthorized` into `NotFound` | Makes a revoked agent indistinguishable from an empty vault. The oracle boundary is the vault, not the caller's own credential. |
| Cache verification for N seconds | Max legitimate TTL is the revocation latency the UI promises. It promises immediate. |
| Bind a token to device/IP/client name | None is verifiable over stdio. Binding to an unverifiable claim manufactures confidence. |
| Delete a principal on revoke | Orphans the access log; an unresolvable id in an audit trail is worse than none. |

---

## Migration risk

**Medium.** `ServerDeps.scope(): Promise<Scope>` and `vault(): Promise<Vault>` are one-way once
written — reverting to sync means giving up the per-call lookup, i.e. giving up revocation.

**No MCP tool signature changes.** ADR 0002's decision to keep `workspaceId` off tool arguments pays
out here exactly as predicted: authentication is added to the product without touching a published
signature.

Token format is effectively permanent once real agents connect — a change means reissuing every
token, a user-visible reconnection of every agent. Provider choice costs one table to change,
*provided* the two rules in §5 hold; violate either and that cost goes to high permanently.

`sourceIds` gating writes is the most likely to be revisited. Revisiting it *toward* a capability
axis is additive. Revisiting it *back* toward read-only is not — that reopens the write channel.

---

## Open — routed, not guessed

1. **Access log: storage, schema, retention, who reads it.** The Agent Access screen needs one, and
   ADR 0005 §5's response logging is still unimplemented. Same table; design once, not twice.
   *Resolver: one design pass before increment 3.*
2. **Multi-workspace membership and workspace selection** (ADR 0002 open item 1). This design
   supports it — a session names a workspace and `scopeFromSession` validates the `Membership` — but
   there is no switcher UI and no product decision. *Resolver: product, with the M7 screen design.*
3. **Remote transport rate limiting, brute-force response, OAuth 2.1 conformance.** Unnecessary for
   stdio, mandatory for HTTP. *Resolver: a follow-on ADR when remote transport is scheduled — it
   must not be inferred from this one.*
4. **What a Server Component does when the provider is unavailable.** Cached JWKS means reads
   survive an outage; new sign-ins do not. *Resolver: increment 2.*
5. **Whether the ingest CLI may create its own source.** Under §6 a narrowed service principal
   cannot create a new source, only write to one in its grant, so first-run bootstrap needs an
   unnarrowed CLI token or an explicit create step. §7 takes the first; whether that is right when a
   second team member runs ingest is unresolved. *Resolver: increment 1.*

---

## Deliberately not decided

- **The Agent Access screen's layout, copy, and interaction.** This is the backend half. The one
  coupling is stated as a constraint, not a design: the revoke button's copy sets the maximum
  legitimate cache TTL (§4).
- **Roles within a workspace.** `Membership` stays flat per ADR 0002; every member can create agents.
- **Sharing, per-doc ACLs, invitations.** Deferred by ADR 0002.
- **Encrypting `credentialRef`'s target.** Connector credential storage belongs to R5. §3 draws the
  boundary; it does not solve the outbound side.
- **"Ask agent about this" (R8) — whose credentials that call runs under.** This ADR gives it a
  vocabulary; it does not decide it.
