# Data contracts

Status: **committed.** `risk-tenancy` closed via `docs/adr/0002-tenancy-workspace-scope.md` — a
`Doc` is scoped to a workspace. Shapes below are current with `packages/core/src/index.ts`; that
file is the source of truth if the two ever drift.

## Scope

Residency (where data lives) and capability (what a caller may reach) are modeled separately —
conflating them is what makes tenancy expensive to retrofit. See ADR 0002 for the full rationale.

```ts
type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
type PrincipalId = string & { readonly __brand: "PrincipalId" };

interface Workspace { id: WorkspaceId; name: string; createdAt: string; }        // flat, never nested
interface Membership { userId: PrincipalId; workspaceId: WorkspaceId; joinedAt: string; }

/** An agent is a first-class principal, not a proxy for the user who connected it. */
interface Principal { id: PrincipalId; kind: "user" | "agent"; workspaceId: WorkspaceId; }

/** What one credential may reach. Narrows only — never widens, never crosses a workspace. */
interface Grant {
  id: GrantId;
  workspaceId: WorkspaceId;
  principalId: PrincipalId;
  sourceIds?: SourceId[];   // absent = every Source in the workspace. The ONLY narrowing dimension.
  createdAt: string;
  revokedAt?: string;
}

/** Proof a caller was authenticated. Minted once per request by `mintScope` — see below. Never cached. */
interface Scope { principal: Principal; workspaceId: WorkspaceId; grant: Grant; /* + a brand, not a forgery-proof tag — see below */ }
```

`Scope` is meant to be constructed only by `mintScope` in `packages/core/src/scope-internal.ts` —
but it is a TypeScript brand, the same mechanism as `DocId`, and a bare `as Scope` cast compiles
anywhere with no import to catch. What actually enforces "only `mintScope` constructs a `Scope`" is
a `no-restricted-syntax` ESLint rule in `eslint.config.mjs` that bans casting to `Scope` or
`Visible<T>` outside `scope-internal.ts` and `index.ts` (where `assertVisible`/`assertSourceVisible`
live), checked on every `npm run verify`. The `post-edit` hook additionally flags an import of
`@strata/core/scope-internal` outside `packages/auth` — useful, but it is an advisory guard on one
particular import path, not the actual enforcement mechanism; do not rely on it alone (see ADR 0002
for the full correction — an earlier draft of this file overclaimed it).

Every store read takes a `Scope` with no overload that omits it, and every value that reaches an
MCP payload must first pass `assertVisible`/`assertSourceVisible` (throws one `NotFound` — never a
distinguishable "forbidden", or the error channel becomes an enumeration oracle over doc ids). The
two checks are intentionally redundant — see `02-milestones.md`'s M6 requirement that scope is
re-checked inside every tool, not in middleware.

`sourceIds` is the only permitted narrowing dimension on a `Grant`. `folder` and `tags` on `Doc`
are `Derived<T>` and can carry `model` provenance — narrowing access by either would let a re-sync
driven by ingested content move a doc into or out of an agent's view (R2).

## Doc

```ts
type DocId = string & { readonly __brand: "DocId" };   // Strata's id, opaque, never source-derived

interface Doc {
  id: DocId;
  workspaceId: WorkspaceId;   // the only access-control input on this shape. Immutable — moving a
                              // Doc between workspaces is a re-import, not an update. Never
                              // returned to an MCP caller.

  // Provenance — where this came from
  sourceId: SourceId;
  externalId: string;          // the source's id. Never conflated with `id`.
  contentHash: string;         // (sourceId, externalId, contentHash) is the identity tuple
  sourceUrl?: string;

  // Retrieval — what an agent sees before deciding to read the body
  title: string;
  excerpt: Derived<string>;
  folder: Derived<string>;
  tags: Derived<string[]>;
  updatedAt: string;           // ISO-8601 UTC. Relative time is a render concern, never stored.
  createdAt: string;

  // Body — deliberately separable
  bodyRef: BodyRef;            // NOT the body. See "Body separability" below.
}
```

### Body separability

`Doc` does not contain `body`. Every retrieval path must be able to return metadata without it.

This is a hard requirement, not an optimization. An agent doing `search_docs` over a vault of a
few hundred documents cannot afford to pull bodies to decide relevance — that is the difference
between a usable MCP tool and one that blows the context window on the first call. The Library
grid needs exactly the same subset, so the human case comes free.

`get_doc(id)` is the only path that materializes a body.

## Derived values

The most important distinction in this schema.

```ts
type Provenance = "source" | "heuristic" | "model" | "user";

interface Derived<T> {
  value: T;
  provenance: Provenance;
  derivedAt: string;
}
```

`excerpt`, `folder`, and `tags` are inferred. Two things depend on knowing how:

1. **A re-sync must never clobber a `user` value with a `model` one.** Without provenance this bug
   is invisible until someone loses their filing.
2. **An agent must be able to distinguish a human-curated tag from a guessed one.** Those warrant
   different confidence, and flattening them to plain strings throws that away permanently.

## Source

```ts
type SourceId = string & { readonly __brand: "SourceId" };

interface Source {
  id: SourceId;
  workspaceId: WorkspaceId;   // independent of Doc — list_sources returns Source directly, and
                              // without this it either joins through docs or leaks every
                              // connected account workspace-wide. Never returned to an MCP caller.
  kind: "claude" | "cursor" | "github" | "markdown";
  name: string;
  description: string;
  status: "connected" | "disconnected" | "error";
  lastSyncAt?: string;
  // credentialRef only — never the credential. A Source is serialized to the browser AND to
  // MCP callers; anything on it is effectively public to both.
  credentialRef?: string;
}
```

Per-source display tints live in `packages/tokens`, keyed by `kind`. They are presentation and do
not belong on the domain object.

GitHub defaults to `disconnected`. Product decision, recorded in `05-decision-log.md`.

## ImportEvent

```ts
interface ImportEvent {
  id: string;
  workspaceId: WorkspaceId;    // lets the Import screen query without a join, human-only today
  sourceId: SourceId;
  docId?: DocId;               // absent when the import failed before a Doc existed
  status: "imported" | "updated" | "skipped-duplicate" | "failed";
  error?: { code: string; message: string };  // message is sanitized — never echoes raw content
  occurredAt: string;
}
```

Failures are recorded, not just successes. The Recent Imports list in the handoff shows only
successes, which is a UI choice; recording only successes would be a data-loss choice that makes
partial-sync bugs undetectable.

`skipped-duplicate` is a normal outcome, not an error — idempotent re-import is the design.

## Rules

1. Ids are opaque and branded. `doc.id` is Strata's; `externalId` is the source's. Conflating them
   turns "reconnect a source" into a migration.
2. Timestamps are ISO-8601 UTC strings at rest. Relative time renders.
3. Identity is `(sourceId, externalId, contentHash)`.
4. `exactOptionalPropertyTypes` is on. Optional means genuinely absent — use an explicit status for
   "not computed yet" rather than `undefined`.
5. No `any` crosses a package boundary. Parse untrusted input at the edge; pass typed values inward.
6. Changing a shape here: run `npm run graph -- --impact contract-doc`, route to
   `strata-architect`, update every consumer **including MCP tool schemas** in the same change.
7. Every top-level persisted entity carries `workspaceId` as its first non-id field. A table
   without one is a bug findable by grep.
8. `workspaceId` is never an MCP tool argument and never appears in an MCP response payload.
   Payload types in `apps/mcp` are hand-written allow-lists, never a spread of the domain type.

## Open

- **Multi-workspace membership.** `Membership` allows a user to belong to more than one workspace;
  the handoff has no switcher UI for choosing the active one. Product decision — folds into R7.
- **Machine credentials.** R7 (auth provider) now carries a hard requirement: long-lived,
  individually revocable agent credentials distinct from user sessions.
- **Grant narrowing granularity for M7.** Whether per-source is sufficient for the Agent Access
  screen, or a doc-id allow-list is needed. Defer to the M7 design pass.
- **`Scope` lifetime vs. lookup cost.** Per-request minting is correct but costs a grant lookup per
  MCP call. Revisit with `svc-storage` (R6).
- **Ranking inputs.** Does `Doc` need denormalized signals for search, or does the index own that?
  Blocks on `svc-search`.
- **Versioning.** When a source re-syncs changed content: new `Doc`, or a revision on the existing
  one? Affects whether `contentHash` is identity or metadata.
- **Body storage.** What `BodyRef` actually points at. Blocks on `svc-storage`.
