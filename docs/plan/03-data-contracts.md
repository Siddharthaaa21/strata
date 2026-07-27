# Data contracts

Status: **proposed, not committed.** These shapes are blocked on `risk-tenancy` (see
`04-risk-register.md`). They are written down so that work can be discussed against something
concrete — not so it can be built on. The `?????` markers are real unknowns, not placeholders to
fill in with a plausible guess.

Committed shapes live in `packages/core/src/index.ts`. Until M1 closes, that file exports these as
`@experimental`.

## Doc

```ts
type DocId = string & { readonly __brand: "DocId" };   // Strata's id, opaque, never source-derived

interface Doc {
  id: DocId;
  // ?????  tenancy — one of: ownerId | teamId | workspaceId. Blocks on risk-tenancy.
  //        This is the field that makes retrofitting expensive; do not guess it.

  // Provenance — where this came from
  sourceId: SourceId;
  externalId: string;          // the source's id. Never conflated with `id`.
  contentHash: string;         // (sourceId, externalId, contentHash) is the identity tuple
  sourceUrl?: string;

  // Retrieval — what an agent sees before deciding to read the body
  title: string;
  excerpt: string;             // derived; see Derived<T>
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

## Open

- **Tenancy field.** Blocks everything. `risk-tenancy`.
- **Ranking inputs.** Does `Doc` need denormalized signals for search, or does the index own that?
  Blocks on `svc-search`.
- **Versioning.** When a source re-syncs changed content: new `Doc`, or a revision on the existing
  one? Affects whether `contentHash` is identity or metadata.
- **Body storage.** What `BodyRef` actually points at. Blocks on `svc-storage`.
