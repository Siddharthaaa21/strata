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

export interface NewMember {
  readonly workspaceId: WorkspaceId;
  readonly email: string;
  readonly invitedBy?: PrincipalId;
}

/** What `removeMember` actually did, so the caller never has to guess. */
export interface RemovalReport {
  /** The person, plus every agent or service principal attributable to them. */
  readonly principalsRevoked: number;
  readonly tokensRevoked: number;
  /**
   * Live agents in the workspace with no `created_by`, which no removal can ever sweep up.
   *
   * Surfaced because it is invisible everywhere else and it is precisely the gap that makes a
   * removal incomplete. A non-zero value here means "this person may still have access through an
   * agent nobody can attribute to them" — an operator can act on that; a silent zero-effect
   * revocation is one they cannot.
   */
  readonly unattributedAgents: number;
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

/**
 * What a verified identity-provider session tells us.
 *
 * Deliberately three fields. Everything else a provider returns — display name, avatar, its own
 * roles and org memberships — is either presentation or an authorization model we refuse to adopt
 * (ADR 0006 §5, rule 2). `subject` is the provider's stable id and is never used as a `PrincipalId`.
 *
 * This type is provider-agnostic on purpose: swapping Supabase Auth for anything else changes the
 * code that PRODUCES these three values and nothing downstream of it.
 */
export interface SessionClaims {
  readonly provider: string;
  readonly subject: string;
  /** Lower-cased by the store. Providers disagree on case, and an allowlist that misses on
   *  capitalisation locks out exactly the person it was written for. */
  readonly email: string;
}

export interface AuthStore {
  /** One indexed lookup on the token's public id. Returns undefined for an unknown id. */
  lookupToken(tokenId: string): Promise<AuthLookup | undefined>;

  /**
   * Resolves a verified session to a principal in ONE named workspace, or `undefined`.
   *
   * Creates the principal, its grant, and the identity link on FIRST sign-in — but only for an
   * address already on the allowlist. A provider will happily authenticate anyone with a Google
   * account; membership is what decides whether that person gets a workspace, and it is ours to
   * decide, not the provider's.
   *
   * `workspaceId` is a parameter rather than something the implementation discovers. Without it the
   * lookup was `WHERE email = $1` across every workspace, taking whichever row the planner returned
   * first — so a person in two workspaces landed in an arbitrary one that could change between
   * requests, and a single revoked row was enough to lock out an active member. Neither is
   * something a caller could work around, because there was nowhere to say which workspace was
   * meant.
   */
  resolveSession(workspaceId: WorkspaceId, claims: SessionClaims): Promise<AuthLookup | undefined>;

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

  /** Adds an address to the allowlist. Idempotent — re-inviting an existing member is a no-op. */
  addMember(input: NewMember): Promise<void>;

  /**
   * Ends a membership.
   *
   * Revokes the person's principal and every token it owns in the same statement, because a
   * membership that is revoked while its agent tokens keep working is not revoked. Never deletes:
   * the access log has to stay attributable.
   *
   * Returns counts rather than void so the caller can report what happened instead of asserting
   * what is meant to happen. Revocation is the one operation where an optimistic message is worse
   * than no message: the operator stops looking, and the credential is still live.
   */
  removeMember(workspaceId: WorkspaceId, email: string): Promise<RemovalReport>;

  /** For the operator CLI. Never exposed over MCP — it is a list of people, not of documents. */
  listMembers(workspaceId: WorkspaceId): Promise<
    readonly {
      readonly email: string;
      readonly principalId?: PrincipalId;
      readonly invitedAt: string;
      readonly joinedAt?: string;
      readonly revokedAt?: string;
    }[]
  >;
}
