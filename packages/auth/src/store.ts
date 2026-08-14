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

/**
 * How a session should be treated beyond what its claims say.
 *
 * One option, and it exists because of a trap this codebase built for itself. See `bindIdentity`.
 */
export interface SessionOptions {
  /**
   * Whether this credential may CLAIM the member's identity binding. Defaults to true.
   *
   * D16 made an invitation bind to exactly one credential: once `alice@company.com` has signed in,
   * a second provider account presenting that address is refused rather than silently inheriting
   * her membership. That rule is right and it stays.
   *
   * What it cannot see is that the local development issuer (`/auth/dev-login`) mints a REAL
   * session and therefore wrote a real binding — so using the dev shortcut once permanently spent
   * the member's one binding, and the genuine provider was then refused with `no-membership`
   * forever. A development convenience that locks you out of production authentication is a trap,
   * not a convenience, and it cost a magic link and an hour to find.
   *
   * The store cannot make this judgement: it is provider-agnostic by construction (ADR 0006 §5) and
   * must not learn the name of our dev issuer. The CALLER knows — it is the one that chose the local
   * branch — so the caller says so. A session passed `bindIdentity: false` still resolves through
   * membership and still gets a scope; it simply never becomes the credential the invitation is
   * spent on.
   *
   * No deployed configuration can reach this: `localIssuerAllowed()` requires an explicit flag AND
   * three independent proofs the process is not deployed.
   */
  readonly bindIdentity?: boolean;
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
  resolveSession(
    workspaceId: WorkspaceId,
    claims: SessionClaims,
    options?: SessionOptions,
  ): Promise<AuthLookup | undefined>;

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

  /**
   * Every non-human principal in a workspace, with what it can reach and when it was last used.
   *
   * What the Agent Access screen renders. Carries **no token material** — not the hash, not the
   * full id, only `last4`, which is what an operator matches against the string they were shown
   * once at creation. A screen that could display a credential is a screen that leaks one to
   * whoever is standing behind you.
   *
   * `kind <> 'user'` rather than an allowlist of agent kinds: a kind added later is something this
   * screen should show by default. Forgetting to add it here is how a credential becomes invisible,
   * and invisible is the one state a revocation UI must never put a credential in.
   */
  listAgents(workspaceId: WorkspaceId): Promise<readonly AgentSummary[]>;

  /**
   * Revokes one agent and every token it holds, in one statement.
   *
   * Returns counts, not void, for the reason `removeMember` does (D16): revocation is the one
   * operation where an optimistic message is worse than none. An operator who reads "revoked" stops
   * looking, and if it did not happen the credential is still live.
   *
   * Idempotent — the predicates require `revoked_at IS NULL`, so revoking twice reports zero the
   * second time rather than restamping and claiming it did something.
   */
  revokeAgent(workspaceId: WorkspaceId, principalId: PrincipalId, at: string): Promise<AgentRevocation>;

  /**
   * Changes what one agent can reach, in ONE statement.
   *
   * `sourceIds` follows the same rule as everywhere else: `undefined` means **every source in the
   * workspace**, `[]` means **deny-all**. They are opposites, and any `?? []` between the caller and
   * here turns "reaches everything" into "reaches nothing" — or, far worse, the reverse.
   *
   * ## Why this cannot be two statements
   *
   * Grants are replaced, never edited: `grants_one_active` is a partial unique index over
   * `(workspace_id, principal_id) WHERE revoked_at IS NULL`, so re-scoping is revoke-then-insert.
   * That is the shape the schema comment for `agent_tokens_grant_belongs_to_principal` warns about,
   * because between those two writes every live token points at a **revoked** grant — and a token
   * whose grant is revoked authenticates and then fails `mintScope` with `AuthError('revoked')`.
   *
   * Split across two calls, `pg.Pool` may route them to two connections (the reason this codebase
   * uses data-modifying CTEs rather than BEGIN/COMMIT at all), so the window is not merely short —
   * it can be left open indefinitely by a crash between them, silently disabling an agent that the
   * UI has just reported as successfully re-scoped.
   *
   * The CTEs are chained through data dependencies rather than merely listed, and the two guards do
   * **different** jobs — mutation testing was what established this, after the first version of this
   * comment claimed both were about ordering:
   *
   *   - `replaced` -> `inserted` **is** ordering. Independent data-modifying CTEs run in an
   *     unpredictable order, and the old grant has to leave the `grants_one_active` partial index
   *     before the new row enters it. Removing this guard fails seven tests.
   *   - `inserted` -> `moved` is **not** ordering. Foreign keys are checked by AFTER triggers at
   *     statement end, by which point the new grant exists whatever order the CTEs ran in. This
   *     guard stops live tokens being repointed at a grant that was never inserted **because the
   *     re-scope was refused** — which would turn a quiet refusal into a foreign-key error.
   *
   * ## What it refuses
   *
   * A revoked principal, and any principal of kind `user`. Both return zero counts rather than
   * throwing. Re-scoping a revoked agent would mint a fresh ACTIVE grant onto a dead principal —
   * a live-looking credential attached to something an operator believes they have already shut
   * off. And a person's grant is not this screen's to edit; membership is where that is decided.
   *
   * Widening is permitted, not just narrowing. ADR 0006 §2's "narrows only" governs deriving a
   * `Scope` from a `Grant` at mint time; it is not a limit on the operator who administers the
   * grant, who can already create an unrestricted agent from the CLI.
   *
   * Returns counts, for the reason `removeMember` and `revokeAgent` do: an operator who reads
   * "re-scoped" stops checking, and if it did not happen the old scope is still live.
   */
  rescopeAgent(
    workspaceId: WorkspaceId,
    principalId: PrincipalId,
    sourceIds: readonly SourceId[] | undefined,
    at: string,
  ): Promise<AgentRescope>;
}

/** What `rescopeAgent` actually did. Zeroes mean it refused — see the method's doc comment. */
export interface AgentRescope {
  /** 1 on success, 0 if the agent was revoked, unknown, or a person. */
  readonly grantsReplaced: number;
  /** Live tokens moved onto the new grant. Zero is normal for an agent whose tokens are all revoked. */
  readonly tokensRepointed: number;
}

/** One row of the Agent Access screen. Deliberately contains nothing that could authenticate. */
export interface AgentSummary {
  readonly principalId: PrincipalId;
  readonly kind: string;
  readonly name: string;
  readonly createdAt: string;
  /** The member who created it, by email. Absent for agents minted before `--by` was required. */
  readonly createdBy?: string;
  readonly revokedAt?: string;
  /**
   * The sources this agent can reach, or `undefined` for **every source in the workspace**.
   *
   * `undefined` and `[]` are opposites and must never be collapsed: NULL is unnarrowed, `'{}'` is
   * deny-all. Any `?? []` on this field turns "reaches everything" into "reaches nothing" on screen
   * — a UI that tells an operator a credential is harmless when it holds the whole vault.
   */
  readonly sourceIds?: readonly string[];
  readonly tokens: readonly {
    readonly last4: string;
    readonly createdAt: string;
    readonly lastUsedAt?: string;
    readonly expiresAt?: string;
    readonly revokedAt?: string;
  }[];
}

export interface AgentRevocation {
  readonly principalsRevoked: number;
  readonly tokensRevoked: number;
}
