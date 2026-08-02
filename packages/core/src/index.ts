/**
 * Strata domain contracts.
 *
 * Tenancy (`risk-tenancy`, R1) is closed — see `docs/adr/0002-tenancy-workspace-scope.md`. A `Doc`
 * is scoped to a workspace; residency (`workspaceId` on the data) and capability (`Grant` carried
 * by the caller) are modeled separately. `risk-injection` (R2) remains open and still blocks M6 —
 * this file closes what an MCP tool is allowed to leak, not prompt-injection handling.
 */

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** Strata's own id. Opaque. Never derived from a source id. */
export type DocId = Brand<string, 'DocId'>;
export type SourceId = Brand<string, 'SourceId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type PrincipalId = Brand<string, 'PrincipalId'>;
export type GrantId = Brand<string, 'GrantId'>;

/** The tenancy boundary. Flat: no parents, no children, no nesting. Ever. See ADR 0002. */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
}

/** People to workspaces. Flat: every member sees every Doc in the workspace. No roles in v1. */
export interface Membership {
  readonly userId: PrincipalId;
  readonly workspaceId: WorkspaceId;
  /** ISO-8601 UTC. */
  readonly joinedAt: string;
}

export type PrincipalKind = 'user' | 'agent';

/** A caller. An agent is a first-class principal, not a proxy for the user who connected it. */
export interface Principal {
  readonly id: PrincipalId;
  readonly kind: PrincipalKind;
  /** Bound at mint time. A credential reaches exactly one workspace, for its whole life. */
  readonly workspaceId: WorkspaceId;
}

/**
 * What one credential may reach inside its workspace. Narrows only; can never widen.
 *
 * `sourceIds` is the only permitted narrowing dimension, and it is deliberate: `folder` and `tags`
 * on `Doc` are `Derived<T>` and can carry `model` provenance, so narrowing access by either would
 * let a re-sync driven by ingested content move a Doc into or out of an agent's view (R2).
 */
export interface Grant {
  readonly id: GrantId;
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  /**
   * Absent = every Source in the workspace. Present (including `[]`, which means deny-all — not
   * "everything") = only these. Set only when a Grant is issued, e.g. the M7 Agent Access flow —
   * never derived from ingested or model-provenance content. That's the property this narrowing
   * dimension has and `folder`/`tags` do not.
   */
  readonly sourceIds?: readonly SourceId[];
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  /** ISO-8601 UTC. Presence means the grant no longer authorizes anything. */
  readonly revokedAt?: string;
}

declare const scopeWitness: unique symbol;

/**
 * Proof that a caller was authenticated and their grant resolved.
 *
 * Unlike `Brand` (a compile-time-only tag with no runtime meaning), this is a witness of *work
 * done* — a real scope check ran. That means the type system alone cannot stop `{ ... } as Scope`
 * the way it stops passing a plain `string` where a `DocId` is expected: an `as` cast compiles
 * anywhere. The actual enforcement is a `no-restricted-syntax` ESLint rule (part of `npm run
 * verify`) that bans casting to `Scope` or `Visible<T>` outside this file and `scope-internal.ts`
 * — those two are the only legitimate construction sites (`mintScope`, `assertVisible`,
 * `assertSourceVisible`). Treat that rule as load-bearing, not decorative.
 *
 * Mint per request, from `mintScope` in `./scope-internal` only. Never cache across requests or
 * hold on a long-lived server object: a cached `Scope` is a `Grant` revocation that silently does
 * not take effect. (`mintScope` checks `revokedAt` only at mint time — there is no expiry on
 * `Scope` itself yet; see ADR 0002 OPEN item 4.)
 */
export interface Scope {
  readonly [scopeWitness]: true;
  readonly principal: Principal;
  readonly workspaceId: WorkspaceId;
  readonly grant: Grant;
}

/** The store filter derived from a `Scope`. Never hand-written by a caller. */
export function scopeFilter(
  scope: Scope,
): { readonly workspaceId: WorkspaceId; readonly sourceIds?: readonly SourceId[] } {
  const { sourceIds } = scope.grant;
  return sourceIds === undefined ? { workspaceId: scope.workspaceId } : { workspaceId: scope.workspaceId, sourceIds };
}

declare const visibleWitness: unique symbol;

/** A domain object that has passed a scope re-check. MCP projections accept only this. */
export type Visible<T> = T & { readonly [visibleWitness]: true };

function inGrant(scope: Scope, sourceId: SourceId): boolean {
  return scope.grant.sourceIds === undefined || scope.grant.sourceIds.includes(sourceId);
}

/** Re-checks a row against a `Scope`. Does not throw — callers decide what "not visible" means. */
export function isVisible(
  scope: Scope,
  row: Pick<Doc, 'workspaceId' | 'sourceId'>,
): boolean {
  return row.workspaceId === scope.workspaceId && inGrant(scope, row.sourceId);
}

/** Throws `NotFound` — never a distinguishable "forbidden". Out-of-scope and nonexistent must be indistinguishable to a caller (see `.claude/skills/mcp-surface/SKILL.md` rule 5). */
export function assertVisible(scope: Scope, doc: Doc): Visible<Doc> {
  if (!isVisible(scope, doc)) throw new Error('NotFound');
  return doc as Visible<Doc>;
}

/**
 * Same contract as `assertVisible`, for a single `Source` lookup.
 *
 * Do not use this to build `list_sources`: asserting per row turns one out-of-grant source into a
 * `NotFound` for the whole call. A list should filter with `isVisible` instead and silently drop
 * rows that fail it — see `.claude/skills/mcp-surface/SKILL.md`.
 */
export function assertSourceVisible(scope: Scope, source: Source): Visible<Source> {
  if (source.workspaceId !== scope.workspaceId || !inGrant(scope, source.id)) {
    throw new Error('NotFound');
  }
  return source as Visible<Source>;
}

/** How a field's value came to be. The re-sync safety property depends on this. */
export type Provenance = 'source' | 'heuristic' | 'model' | 'user';

/**
 * A value that was inferred rather than authored.
 *
 * Two invariants depend on carrying provenance rather than a bare value:
 *   1. A re-sync must never overwrite a `user` value with a `model` one.
 *   2. An agent must be able to tell a curated tag from a guessed one — they warrant different
 *      confidence, and flattening to a plain string throws that away permanently.
 */
export interface Derived<T> {
  readonly value: T;
  readonly provenance: Provenance;
  /** ISO-8601 UTC. */
  readonly derivedAt: string;
}

export type SourceKind = 'claude' | 'cursor' | 'github' | 'markdown';

export interface Source {
  readonly id: SourceId;
  /**
   * Tenancy. `Source` is returned by `list_sources` independently of any `Doc`; without this
   * field that tool either joins through docs or leaks every connected account workspace-wide.
   * Excluded from every MCP payload — see the next field's comment for what "excluded" means in
   * practice. See ADR 0002.
   */
  readonly workspaceId: WorkspaceId;
  readonly kind: SourceKind;
  readonly name: string;
  readonly description: string;
  readonly status: 'connected' | 'disconnected' | 'error';
  /** ISO-8601 UTC. */
  readonly lastSyncAt?: string;
  /**
   * A reference to a credential, never the credential.
   *
   * The full `Source` (this field included) is serialized to the browser as-is — that's fine,
   * `credentialRef` is a reference, not a secret. The MCP surface is different: `list_sources`
   * does not return `Source` directly, it returns a hand-written `SourcePayload` allow-list
   * (`.claude/skills/mcp-surface/SKILL.md` rule 6) that omits `workspaceId` by construction. This
   * field is not currently on that exclusion list; keep it that way only if a future MCP client
   * genuinely needs it; default to leaving it off too since "effectively public" is exactly the
   * property `Grant` narrowing is supposed to prevent.
   */
  readonly credentialRef?: string;
}

/** Opaque handle to a document body. Resolved only by `get_doc`. See "body separability" below. */
export type BodyRef = Brand<string, 'BodyRef'>;

/**
 * The central domain shape.
 *
 * `body` is deliberately absent. Every retrieval path must be able to return metadata without it:
 * an agent doing `search_docs` cannot afford to pull bodies to judge relevance, and that
 * constraint is the difference between a usable MCP tool and one that exhausts the context window
 * on its first call. The Library grid needs exactly the same subset, so the human case is free.
 */
export interface Doc {
  readonly id: DocId;

  /**
   * Tenancy. The only access-control input on this shape. Immutable: moving a Doc between
   * workspaces is a re-import, not an update. Never returned to an MCP caller. See ADR 0002.
   */
  readonly workspaceId: WorkspaceId;

  // Provenance
  readonly sourceId: SourceId;
  /** The source's own id. Never conflated with `id`. */
  readonly externalId: string;
  /** Third element of the identity tuple: (sourceId, externalId, contentHash). */
  readonly contentHash: string;
  readonly sourceUrl?: string;

  // Retrieval surface — what an agent sees before deciding to read the body
  readonly title: string;
  readonly excerpt: Derived<string>;
  readonly folder: Derived<string>;
  readonly tags: Derived<readonly string[]>;
  /** ISO-8601 UTC. Relative time ("6m ago") is a render concern and never persists. */
  readonly updatedAt: string;
  readonly createdAt: string;

  readonly bodyRef: BodyRef;
}

/** One record per ingestion attempt — including failures. */
export interface ImportEvent {
  readonly id: string;
  /** Tenancy. Lets the Import screen query without a join, even though it is human-only today. */
  readonly workspaceId: WorkspaceId;
  readonly sourceId: SourceId;
  /** Absent when the import failed before a Doc existed. */
  readonly docId?: DocId;
  /** `skipped-duplicate` is a normal outcome — idempotent re-import is the design, not a fault. */
  readonly status: 'imported' | 'updated' | 'skipped-duplicate' | 'failed';
  /** `message` is sanitized. It must never echo raw ingested content back into a log or a UI. */
  readonly error?: { readonly code: string; readonly message: string };
  readonly occurredAt: string;
}

/** The identity tuple that makes ingestion idempotent. */
export interface DocIdentity {
  readonly sourceId: SourceId;
  readonly externalId: string;
  readonly contentHash: string;
}

export function docIdentityKey(identity: DocIdentity): string {
  return `${identity.sourceId}\u0000${identity.externalId}\u0000${identity.contentHash}`;
}

/**
 * Fixture data for fixture-driven UI (D8). Re-exported from the package entry so screens never
 * import `./fixtures` directly by relative path -- `@strata/core` is the only import surface.
 */
export * from "./untrusted.ts";
export * from "./fixtures.ts";
