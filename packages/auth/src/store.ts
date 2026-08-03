/**
 * The storage port `packages/auth` declares and `packages/storage` implements.
 *
 * Declared here, not imported from `@strata/storage`, and the direction matters: `packages/auth`
 * must never depend on `pg` or on a schema. Inverting it this way means the authenticator is
 * testable against a plain object, and the one package permitted to mint a `Scope` stays small
 * enough to read in full.
 */

import type { Grant, PrincipalId, PrincipalKind, SourceId, WorkspaceId } from '@strata/core';

/**
 * Everything one token lookup must return, in ONE query.
 *
 * Deliberately a flat row rather than three fetches (token, then principal, then grant): this runs
 * on every MCP call, and three round trips per call is how a per-request check becomes something
 * somebody later "optimizes" with a cache — which is exactly the thing ADR 0006 §4 forbids.
 *
 * Revocation timestamps come back rather than being filtered in SQL so the authenticator decides
 * what each one means. A store that silently dropped revoked rows would make "unknown token" and
 * "revoked token" indistinguishable *to us*, and we want that distinction in our own logs even
 * though it never crosses the wire.
 */
export interface AuthLookup {
  readonly principalId: PrincipalId;
  readonly kind: PrincipalKind;
  readonly workspaceId: WorkspaceId;
  readonly grant: Grant;
  readonly principalRevokedAt?: string;
  readonly tokenHash: Uint8Array;
  readonly tokenRevokedAt?: string;
  readonly expiresAt?: string;
}

export interface NewAgent {
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly kind: PrincipalKind;
  /** Absent means every source in the workspace. Present-but-empty means deny-all. */
  readonly sourceIds?: readonly SourceId[];
  /** The `kind: 'user'` principal doing the creating. Absent only for the bootstrap owner. */
  readonly createdBy?: PrincipalId;
}

export interface AuthStore {
  /** One indexed lookup on the token's public id. Returns undefined for an unknown id. */
  lookupToken(tokenId: string): Promise<AuthLookup | undefined>;

  /**
   * Creates a principal, its single active grant, and its first token, atomically.
   *
   * Returns the full presented token — the only moment it exists outside the caller's hands.
   */
  createAgent(input: NewAgent): Promise<{ readonly principalId: PrincipalId; readonly presented: string }>;

  /**
   * Records use. Rate-limited by the implementation and never awaited on the response path: a
   * write per call, for a field a UI renders as "2 hours ago", is not worth the amplification.
   */
  touchToken(tokenId: string, at: string): Promise<void>;
}
