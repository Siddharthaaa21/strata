# ADR 0002 — Workspace-scoped tenancy

**Status:** accepted · **Date:** 2026-07-28 · **Log entry:** D9 · **Closes:** `risk-tenancy` (R1)

## Context

`risk-tenancy` (`docs/plan/04-risk-register.md` R1) blocks M1: is a `Doc` scoped to a user, a
team, or a workspace? The handoff never says. `Vault.dc.html:75-81` shows one user and no
team/workspace switcher; `Vault.dc.html:79` shows "4 agents connected," implying agents are
distinct principals from the user who connected them.

`docs/plan/01-north-star.md:30` states the success criterion directly: "An engineer finds a doc a
teammate generated three weeks ago in one search, having never known it existed." Cross-member
discovery without prior knowledge of the doc's existence is required. `01-north-star.md:23-24`
scopes the product to "a small engineering team... not an enterprise wiki, not a personal notes
app."

Routed to `strata-architect`. Full design returned inline below; this ADR records the decision and
its consequences.

## Decision

A `Doc` is scoped to a **workspace** — a single, flat, non-hierarchical container that owns
documents and sources. People reach it through `Membership`; agents reach it through a
credential-bound `Grant` that can only narrow within one workspace, never widen or cross into
another.

`Doc`, `Source`, and `ImportEvent` each carry exactly one access field: `workspaceId: WorkspaceId`.
That field is never a tool parameter and never appears in an MCP response payload — residency
(where data lives) and capability (what a caller may reach) are modeled as two separate things, on
purpose, because conflating them is what makes tenancy expensive to retrofit later.

Enforcement leans on the type system but is not purely compiler-backed, and this ADR originally
overstated that — corrected here after a `strata-verifier` pass compiled a working bypass. `Scope`
and `Visible<T>` are TypeScript brands: like `DocId`/`SourceId`, a bare `as Scope` or
`as Visible<Doc>` cast compiles anywhere, with no import and nothing for the `post-edit` hook to
catch, because it needs no reference to `scope-internal.ts`. A `Scope` value is *intended* to exist
before any store read (minted once per request from `mintScope` in
`packages/core/src/scope-internal.ts`, never cached across requests) and a domain object is
*intended* to pass `assertVisible`/`assertSourceVisible` before reaching an MCP payload — but the
type system cannot force either by itself.

What actually closes the gap: a `no-restricted-syntax` ESLint rule (`eslint.config.mjs`, part of
`npm run verify`) that bans casting to `Scope` or `Visible<T>` anywhere except
`packages/core/src/index.ts` and `scope-internal.ts` — the only two files that legitimately
construct either (`mintScope`, `assertVisible`, `assertSourceVisible`). That rule is what makes
"skip the check and the codebase won't compile" true. It is a lint rule, not the compiler itself,
so it inherits lint's limits (disableable per-line, doesn't cover dynamically-generated code) —
weaker than the original claim, but real and checked on every `npm run verify`.

## Rationale

- **Cross-member discovery is a stated success criterion, not a preference.** A user-scoped `Doc`
  makes it structurally impossible. This alone eliminates user scope.
- **"Not an enterprise wiki."** A hierarchy (org > team > project) is bought for a non-goal, and it
  turns every scope check into the most expensive kind: a subtree/path check.
- **An agent is a distinct principal from the user who connected it** (`Vault.dc.html:79`, M7's
  per-agent revocation). Caller capability cannot be one field on `Doc` — it has to be a separate
  value (`Grant`) carried by the caller, narrowing over fields `Doc` already has.
- **Tool signatures are a published interface** (`mcp-surface/SKILL.md` rule 1). Keeping
  `workspaceId` out of every tool argument and payload decouples this decision from R3 (the MCP
  surface) — a signature never has to change if the tenancy model is later refined.
- **The error channel must not become an enumeration oracle** (`mcp-surface/SKILL.md` rule 5).
  `assertVisible` throws one `NotFound` for both "does not exist" and "not in your scope."
- **Access rules must not read a `model`-provenance field.** `Grant.sourceIds` is the only
  permitted narrowing dimension; `folder` and `tags` are `Derived<T>` and could be moved by a
  re-sync driven by ingested content (R2) if used for access control.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| User-scoped (`ownerId` on `Doc`) | Directly contradicts the north-star teammate-discovery criterion. |
| Team-scoped (`teamId` on `Doc`) | A team is people, a vault is documents — naming them one thing forces a migration the first day a team wants two vaults, or two teams share one. |
| `org > team > workspace` hierarchy | Bought for "not an enterprise wiki." |
| Per-doc ACLs (`Doc.visibleTo: PrincipalId[]`) | Makes ingestion decide permissions on every write; per-doc sharing is explicitly deferred (`02-milestones.md:124`). |
| Narrowing agent grants by `folder`/`tags` | Both are `Derived<T>` with possible `model` provenance — an injection vector into access control. |
| Middleware-only scope enforcement | The canonical MCP vulnerability is exactly a tool that trusts a middleware it assumes ran. |
| `workspace_id` as an explicit MCP tool parameter | Lets a confused or compromised agent select a tenant, and welds a published signature to a revisable decision. |
| Distinct `Forbidden`/`NotFound` errors | Makes the error channel an enumeration oracle over doc ids. |

## Consequences

- `packages/core` gains `Workspace`, `Membership`, `Principal`, `Grant`, `Scope`, `Visible<T>`, and
  the `workspaceId` field on `Doc`, `Source`, and `ImportEvent`. See
  `packages/core/src/index.ts`.
- `eslint.config.mjs` gains a `no-restricted-syntax` rule enforcing the smart-constructor pattern
  above. Anything that adds a legitimate third construction site for `Scope`/`Visible<T>` must
  extend that rule's file exemption in the same change, not work around it.
- **Migration risk: medium, asymmetric.** If the scope unit changes later, three tables gain/change
  one leading, non-nullable, indexed column — a backfill and index rebuild once real data exists,
  bounded but not free. No MCP tool signature, screen, or the ingestion dedupe key changes, because
  none of them touch `workspaceId` directly.
- **Not absorbed by this design:** a future move from workspace-level to per-doc access would put
  an ACL back on `Doc` and re-touch all four surfaces. Rejected above rather than deferred;
  reopening it needs its own decision-log entry.
- Unblocks the persistence and MCP-surface holds that D8 left standing — `svc-storage` and
  `svc-mcp` design/implementation may proceed once sequenced (M4/M6), rather than waiting on R1.
- `risk-injection` (R2) remains open and continues to block M6 independently — this decision
  narrows what an MCP tool is allowed to leak, it does not address prompt injection in ingested
  content.

## Open questions (routed, not guessed)

1. **Multi-workspace membership and active-workspace selection.** `Membership` allows a user to
   belong to more than one workspace, but the handoff has no switcher UI. Product decision; folds
   into R7 or a new low-severity risk. Does not change `Doc`.
2. **Machine credentials for agents.** R7 (auth provider) now carries a hard requirement: long-lived,
   individually revocable agent credentials distinct from user sessions.
3. **Narrowing granularity for M7.** Whether per-source `Grant.sourceIds` is sufficient for the
   Agent Access screen, or whether a doc-id allow-list is needed. Defer to the M7 design pass.
4. **`Scope` lifetime vs. lookup cost.** Per-request minting is correct (immediate revocation) but
   costs a grant lookup per MCP call. Revisit when `svc-storage` is decided (R6).
