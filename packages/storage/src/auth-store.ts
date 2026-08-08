/**
 * Postgres implementation of the `AuthStore` port that `packages/auth` declares.
 *
 * The dependency points this way on purpose (ADR 0006 §4): auth declares the shape it needs and
 * storage satisfies it, so the one package permitted to mint a `Scope` never imports `pg` and stays
 * small enough to read in full.
 */

import { randomUUID } from 'node:crypto';
import { mintAgentToken, type AuthLookup, type AuthStore, type NewAgent } from '@strata/auth';
import type { Grant, GrantId, PrincipalId, PrincipalKind, SourceId, WorkspaceId } from '@strata/core';
import type { SqlDriver } from './index.ts';

/**
 * How stale `last_used_at` is allowed to be.
 *
 * A write on every call, for a value the UI renders as "2 hours ago", is write amplification bought
 * for nothing. One minute of staleness is invisible in that rendering.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * The far past. Returned for any timestamp that cannot be represented, so the failure is *closed*.
 *
 * For `revoked_at` the value is irrelevant — presence means revoked. For `expires_at` a past
 * instant means expired, which is the safe reading of a value we could not understand.
 */
const UNREPRESENTABLE = '1970-01-01T00:00:00.000Z';

/**
 * Never throws.
 *
 * Postgres timestamps include `infinity` and `-infinity`, which the driver surfaces as `±Infinity`.
 * `new Date(±Infinity).toISOString()` raises a RangeError — and that escaped `lookupToken` as
 * neither an `AuthError` nor a `ToolError`, so the MCP server mapped it to `InternalError`. That is
 * a credential-rejection path that did not collapse to `Unauthorized`, which is exactly the
 * property this layer claims to have.
 *
 * Failing closed rather than open is the deliberate half: `infinity` in `expires_at` would read
 * naturally as "never expires", but a value we cannot parse is not evidence of validity. No caller
 * writes either today; an operator can.
 */
const iso = (v: Date | string | null): string | undefined => {
  if (v == null) return undefined;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? UNREPRESENTABLE : parsed.toISOString();
};

interface TokenRow {
  principal_id: string;
  kind: string;
  workspace_id: string;
  principal_revoked_at: Date | string | null;
  token_hash: Uint8Array | Buffer | { toString(enc: string): string };
  token_revoked_at: Date | string | null;
  expires_at: Date | string | null;
  grant_id: string;
  grant_source_ids: string[] | null;
  grant_created_at: Date | string;
  grant_revoked_at: Date | string | null;
  grant_principal_id: string;
}

/** `bytea` arrives as a Buffer from node-postgres and as a Uint8Array from PGlite. */
function toBytes(v: TokenRow['token_hash']): Uint8Array {
  if (v instanceof Uint8Array) return v;
  return Uint8Array.from(Buffer.from(String(v), 'hex'));
}

export function createAuthStore(db: SqlDriver): AuthStore {
  return {
    /**
     * ONE query, joining token -> principal -> grant.
     *
     * Not three round trips: this runs on every MCP call, and a three-round-trip check is how a
     * per-request verification becomes something somebody later "optimizes" with a cache — the one
     * thing ADR 0006 §4 forbids, because the revoke button promises immediate effect.
     *
     * Revoked and expired rows are RETURNED, not filtered in SQL. The authenticator decides what
     * each means; filtering here would collapse "revoked" into "unknown" in our own logs too.
     */
    async lookupToken(tokenId) {
      const { rows } = await db.query<TokenRow>(
        `SELECT t.principal_id, t.workspace_id, t.token_hash,
                t.revoked_at AS token_revoked_at, t.expires_at,
                p.kind, p.revoked_at AS principal_revoked_at,
                g.id AS grant_id, g.source_ids AS grant_source_ids,
                g.created_at AS grant_created_at, g.revoked_at AS grant_revoked_at,
                -- The GRANT's principal, not the token's. Selecting only the token's turned
                -- mintScope's principal/grant check into a comparison of a value with itself.
                g.principal_id AS grant_principal_id
           FROM agent_tokens t
           JOIN principals p ON p.workspace_id = t.workspace_id AND p.id = t.principal_id
           JOIN grants     g ON g.workspace_id = t.workspace_id AND g.id = t.grant_id
          WHERE t.token_id = $1`,
        [tokenId],
      );

      const row = rows[0];
      if (row === undefined) return undefined;

      const grant: Grant = {
        id: row.grant_id as GrantId,
        workspaceId: row.workspace_id as WorkspaceId,
        // `grant_principal_id`, NOT `row.principal_id`.
        //
        // This one character of difference was a privilege-escalation primitive. The token row and
        // the grant row each carry a `principal_id`, and `mintScope` exists partly to check that
        // they agree — but the grant handed to it was built with the TOKEN's value, so the check
        // `grant.principalId !== principal.id` compared a value to itself and could never fail.
        //
        // An `agent_tokens` row pointing at another principal's grant therefore inherited that
        // grant's scope silently: a token for a principal narrowed to one source, re-pointed at an
        // unnarrowed grant, reached the entire workspace. There is no FK on `grant_id`, and the
        // operator workflow makes that write likely rather than exotic — `grants_one_active` forces
        // revoke-then-insert to re-scope an agent, and a re-grant that does not also rewrite
        // `agent_tokens.grant_id` bricks the token, so hand-editing `grant_id` is the obvious fix.
        //
        // The schema now forbids the mismatch outright (composite FK, see SCHEMA_SQL). This reads
        // the real value so `mintScope` is a live check rather than documentation of one.
        principalId: row.grant_principal_id as PrincipalId,
        createdAt: new Date(row.grant_created_at).toISOString(),
        // NULL means "every source"; an empty array means deny-all. Preserved as the distinction it
        // is — flattening one into the other inverts the security property in either direction.
        ...(row.grant_source_ids === null ? {} : { sourceIds: row.grant_source_ids as SourceId[] }),
        ...(row.grant_revoked_at == null ? {} : { revokedAt: iso(row.grant_revoked_at)! }),
      };

      const lookup: AuthLookup = {
        principalId: row.principal_id as PrincipalId,
        kind: row.kind as PrincipalKind,
        workspaceId: row.workspace_id as WorkspaceId,
        grant,
        tokenHash: toBytes(row.token_hash),
        ...(row.principal_revoked_at == null ? {} : { principalRevokedAt: iso(row.principal_revoked_at)! }),
        ...(row.token_revoked_at == null ? {} : { tokenRevokedAt: iso(row.token_revoked_at)! }),
        ...(row.expires_at == null ? {} : { expiresAt: iso(row.expires_at)! }),
      };
      return lookup;
    },

    /**
     * Creates principal, grant, and first token in ONE statement.
     *
     * A data-modifying CTE for the same reason `docs.upsert` is one (ADR 0004 / the atomicity fix):
     * `SqlDriver` is a bare `query`, and a `pg.Pool` can route two calls to two connections, so
     * `query('BEGIN')` would open a transaction the next statement never joins. A principal with no
     * grant, or a grant with no token, is an agent that exists and cannot be used or revoked
     * coherently.
     */
    async createAgent(input: NewAgent) {
      const principalId = randomUUID() as PrincipalId;
      const grantId = randomUUID();
      const token = mintAgentToken();
      const now = new Date().toISOString();

      await db.query(
        `WITH p AS (
           INSERT INTO principals (workspace_id, id, kind, display_name, created_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
         ), g AS (
           INSERT INTO grants (workspace_id, id, principal_id, source_ids, created_at)
           SELECT $1,$7,p.id,$8::text[],$5 FROM p RETURNING id
         )
         INSERT INTO agent_tokens
           (token_id, workspace_id, principal_id, grant_id, token_hash, last4, created_at, expires_at)
         SELECT $9,$1,$2,g.id,$10,$11,$5,$12 FROM g`,
        [
          input.workspaceId,
          principalId,
          input.kind,
          input.displayName,
          now,
          input.createdBy ?? null,
          grantId,
          input.sourceIds === undefined ? null : [...input.sourceIds],
          token.tokenId,
          token.tokenHash,
          token.last4,
          null,
        ],
      );

      return { principalId, presented: token.presented };
    },

    /**
     * Resolves a verified session within ONE workspace, creating the principal on first sign-in.
     *
     * Membership is keyed by EMAIL because the allowlist is written before anyone signs in — an
     * operator invites an address, not a stranger's opaque provider id. But the email only selects
     * the invitation. What decides *which credential* may claim it is the `(provider, subject)`
     * pair, checked below.
     *
     * TWO PROPERTIES, and the second one used not to hold at all:
     *
     *   1. **Scoped to the workspace the caller names.** `(workspace_id, email)` is unique, so this
     *      matches at most one row. Selecting on email alone returned rows from every workspace and
     *      took whichever came first, with no ORDER BY to make even that stable — so one person in
     *      two workspaces landed in an arbitrary one, and a revoked row sorting first locked out a
     *      member who was active elsewhere.
     *
     *   2. **One invitation, one credential.** `user_identities` was written on first sign-in and
     *      then never read, which made the write decorative: resolution ran entirely on email, so a
     *      DIFFERENT provider subject presenting the same address inherited the first person's
     *      principal, their grant, and their history. The address is the thing an attacker picks;
     *      binding it to the subject that first claimed it is what makes the invitation
     *      single-use.
     */
    async resolveSession(workspaceId, claims) {
      const email = claims.email.trim().toLowerCase();

      const membership = await db.query<{
        principal_id: string | null;
        revoked_at: Date | string | null;
      }>(
        `SELECT principal_id, revoked_at FROM memberships
          WHERE workspace_id = $1 AND email = $2`,
        [workspaceId, email],
      );

      const member = membership.rows[0];
      // Not on the allowlist, or membership ended. Both are "no", and the caller reports one word.
      if (member === undefined || member.revoked_at != null) return undefined;

      // Who this credential is already bound to, if anyone. `(provider, subject)` is the primary
      // key, so this is one row or none, globally.
      const { rows: identityRows } = await db.query<{
        workspace_id: string;
        principal_id: string;
      }>(
        `SELECT workspace_id, principal_id FROM user_identities
          WHERE provider = $1 AND subject = $2`,
        [claims.provider, claims.subject],
      );
      const identity = identityRows[0];

      if (identity !== undefined) {
        // A known credential. It must be bound to this workspace AND to the principal this
        // invitation already resolved to — otherwise the two records disagree about who this is,
        // and guessing which one is right is how a session gets attributed to the wrong person.
        if (identity.workspace_id !== workspaceId) return undefined;
        if (member.principal_id === null || identity.principal_id !== member.principal_id) {
          return undefined;
        }
      } else if (member.principal_id !== null) {
        // The invitation has been claimed, by a credential that is not this one. Bind only if the
        // principal genuinely has no identity yet — true for a member created before identities
        // were recorded, and for one an operator provisioned directly. If an identity already
        // exists, this is a second credential arriving at a claimed invitation, which is the case
        // the binding exists to refuse.
        const { rows: bound } = await db.query<{ one: number }>(
          `SELECT 1 AS one FROM user_identities
            WHERE workspace_id = $1 AND principal_id = $2 LIMIT 1`,
          [workspaceId, member.principal_id],
        );
        if (bound.length > 0) return undefined;

        await db.query(
          `INSERT INTO user_identities (provider, subject, workspace_id, principal_id, linked_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (provider, subject) DO NOTHING`,
          [claims.provider, claims.subject, workspaceId, member.principal_id, new Date().toISOString()],
        );
      }

      if (member.principal_id === null) {
        // First sign-in. Principal, grant, identity link, and the membership update all in ONE
        // statement — a principal without a grant is an account that exists and cannot be used, and
        // two concurrent first logins must not create two principals for one person.
        const principalId = randomUUID();
        const grantId = randomUUID();
        const now = new Date().toISOString();

        await db.query(
          `WITH p AS (
             INSERT INTO principals (workspace_id, id, kind, display_name, created_at)
             VALUES ($1,$2,'user',$3,$4)
             RETURNING id
           ), g AS (
             INSERT INTO grants (workspace_id, id, principal_id, source_ids, created_at)
             SELECT $1,$5,p.id,NULL,$4 FROM p RETURNING id
           ), i AS (
             INSERT INTO user_identities (provider, subject, workspace_id, principal_id, linked_at)
             SELECT $6,$7,$1,p.id,$4 FROM p
             ON CONFLICT (provider, subject) DO NOTHING
             RETURNING principal_id
           )
           -- EXISTS (SELECT 1 FROM i) makes the identity insert the thing that decides the winner
           -- of a concurrent first sign-in, rather than leaving membership and identity to be
           -- settled by two independent races. The loser still writes an orphan principal and
           -- grant -- data-modifying CTEs all run regardless of whether the final statement uses
           -- them -- but the orphan is unreferenced by any membership or identity, so it grants
           -- nothing. Cleaning it up is a chore, not a hole.
           UPDATE memberships SET principal_id = $2, joined_at = $4
            WHERE workspace_id = $1 AND email = $8 AND principal_id IS NULL
              AND EXISTS (SELECT 1 FROM i)`,
          [workspaceId, principalId, email, now, grantId, claims.provider, claims.subject, email],
        );
      }

      // Re-read rather than trusting what was just written: a concurrent first sign-in may have won
      // the UPDATE, in which case the principal to use is theirs, not the one minted above.
      const { rows } = await db.query<{
        principal_id: string;
        kind: string;
        principal_revoked_at: Date | string | null;
        grant_id: string;
        grant_principal_id: string;
        grant_source_ids: string[] | null;
        grant_created_at: Date | string;
        grant_revoked_at: Date | string | null;
      }>(
        `SELECT p.id AS principal_id, p.kind, p.revoked_at AS principal_revoked_at,
                g.id AS grant_id, g.principal_id AS grant_principal_id,
                g.source_ids AS grant_source_ids, g.created_at AS grant_created_at,
                g.revoked_at AS grant_revoked_at
           FROM memberships m
           JOIN principals p ON p.workspace_id = m.workspace_id AND p.id = m.principal_id
           JOIN grants     g ON g.workspace_id = m.workspace_id
                            AND g.principal_id = p.id AND g.revoked_at IS NULL
          WHERE m.workspace_id = $1 AND m.email = $2`,
        [workspaceId, email],
      );

      const row = rows[0];
      if (row === undefined) return undefined;

      return {
        principalId: row.principal_id as PrincipalId,
        kind: row.kind as PrincipalKind,
        workspaceId,
        grant: {
          id: row.grant_id as GrantId,
          workspaceId,
          principalId: row.grant_principal_id as PrincipalId,
          createdAt: new Date(row.grant_created_at).toISOString(),
          ...(row.grant_source_ids === null ? {} : { sourceIds: row.grant_source_ids as SourceId[] }),
          ...(row.grant_revoked_at == null ? {} : { revokedAt: iso(row.grant_revoked_at)! }),
        },
        // Unused on this path — sessions carry no secret — but the port is one shape.
        tokenHash: new Uint8Array(0),
        ...(row.principal_revoked_at == null
          ? {}
          : { principalRevokedAt: iso(row.principal_revoked_at)! }),
      };
    },

    /**
     * Adds or restores a member. Idempotent.
     *
     * Restoring has to undo everything `removeMember` did, or remove-then-re-add does not round
     * trip: the membership row comes back, the principal stays revoked, and the returning person
     * hits `Unauthorized` with nothing in the UI to explain why. That is a support ticket generated
     * by an asymmetry, and the asymmetry is invisible — the operator sees the member listed and
     * reasonably concludes it worked.
     *
     * Their agent TOKENS stay revoked deliberately. A credential that was revoked should require a
     * deliberate re-issue; silently reanimating one because someone was re-invited is the opposite
     * of what revocation means.
     */
    async addMember(input) {
      const workspaceId = input.workspaceId;
      const email = input.email.trim().toLowerCase();
      const now = new Date().toISOString();

      await db.query(
        `INSERT INTO memberships (workspace_id, email, invited_by, invited_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id, email) DO UPDATE SET revoked_at = NULL`,
        [workspaceId, email, input.invitedBy ?? null, now],
      );

      await db.query(
        `UPDATE principals SET revoked_at = NULL
          WHERE workspace_id = $1
            AND id = (SELECT principal_id FROM memberships WHERE workspace_id = $1 AND email = $2)`,
        [workspaceId, email],
      );

      // A returning member needs an active grant, and may have none: `removeMember` revokes the
      // membership, the principal and its tokens but deliberately not grants, so the usual way to
      // arrive here is an operator who revoked the grant directly to suspend someone's authority.
      // `grants_one_active` means we cannot simply un-revoke the old one if another has since been
      // issued, so this inserts a replacement.
      //
      // The new grant INHERITS the narrowing of the most recent one instead of being minted with
      // `source_ids = NULL`. NULL means every source in the workspace, so re-adding someone who had
      // been deliberately restricted to one source silently handed them the whole vault — a
      // privilege escalation performed by the operator, through the CLI, while doing something that
      // reads as purely administrative. Nothing would have shown it: `listMembers` reports
      // membership, not scope.
      //
      // "The last grant they actually held" is ordered by REVOCATION time, not creation time, and
      // the ordering is fully deterministic on purpose.
      //
      // `ORDER BY created_at DESC LIMIT 1` alone looked right and was not: grants get their
      // `created_at` from two different clocks — this package writes a JS timestamp, an operator
      // writing SQL by hand writes `now()` — so two grants created in the same millisecond tie,
      // and a tie with no tiebreaker resolves to whatever the planner returns. That is a coin flip
      // between inheriting the narrowing and inheriting NULL, which is the whole vault. It showed
      // up as a test that passed alone and failed in a full run, which is exactly what a race
      // looks like when it is being mistaken for flakiness.
      //
      // `revoked_at DESC` is also the better question: the grant most recently in force is the one
      // whose scope should carry over. Postgres sorts NULLs first under DESC, so an active grant
      // would win outright — correct, though unreachable here because of the NOT EXISTS guard
      // below. `created_at DESC, id DESC` then makes the remaining ties total.
      await db.query(
        `INSERT INTO grants (workspace_id, id, principal_id, source_ids, created_at)
         SELECT $1, $3, m.principal_id,
                (SELECT g2.source_ids FROM grants g2
                  WHERE g2.workspace_id = $1 AND g2.principal_id = m.principal_id
                  ORDER BY g2.revoked_at DESC, g2.created_at DESC, g2.id DESC
                  LIMIT 1),
                $4
           FROM memberships m
          WHERE m.workspace_id = $1 AND m.email = $2 AND m.principal_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM grants g
               WHERE g.workspace_id = $1 AND g.principal_id = m.principal_id AND g.revoked_at IS NULL
            )`,
        [workspaceId, email, randomUUID(), now],
      );
    },

    /**
     * Ends a membership, and kills the principal and every token it owns in the same statement.
     *
     * A membership revoked while its agent tokens keep working is not revoked — the person simply
     * stops using the web app and keeps their MCP access. Doing it in one statement means there is
     * no window where one has happened and the other has not.
     */
    async removeMember(workspaceId, email) {
      const now = new Date().toISOString();
      const { rows } = await db.query<{
        principals_revoked: string | number;
        tokens_revoked: string | number;
        unattributed_agents: string | number;
      }>(
        `WITH m AS (
           UPDATE memberships SET revoked_at = $3
            WHERE workspace_id = $1 AND email = $2 AND revoked_at IS NULL
           RETURNING principal_id
         ), doomed AS (
           -- The member, AND every agent or service principal they created.
           --
           -- Agents are separate principals, so revoking only the person left their agents alive:
           -- a departing teammate loses the web app and keeps an MCP token that reads the entire
           -- vault. That is the half of "remove this person" that actually matters, and it is the
           -- half that is invisible — nothing in the UI would have shown the orphaned agent.
           SELECT principal_id AS id FROM m WHERE principal_id IS NOT NULL
           UNION
           SELECT p.id FROM principals p
            WHERE p.workspace_id = $1
              AND p.created_by IN (SELECT principal_id FROM m WHERE principal_id IS NOT NULL)
         ), revoked_principals AS (
           UPDATE principals SET revoked_at = $3
            WHERE workspace_id = $1 AND id IN (SELECT id FROM doomed)
           RETURNING id
         ), revoked_tokens AS (
           UPDATE agent_tokens SET revoked_at = $3
            WHERE workspace_id = $1 AND principal_id IN (SELECT id FROM revoked_principals)
           RETURNING token_id
         )
         -- Counted and returned so the operator CLI can state what happened instead of asserting
         -- what is supposed to happen. The two had diverged: the CLI printed "their agents and
         -- agent tokens are revoked too" unconditionally, while every agent created through
         -- agent:create had a NULL created_by and therefore matched nothing in the doomed set
         -- (NULL IN (...) is never true). The message was the only evidence an operator had, and
         -- it was wrong in the direction that leaves a live credential behind.
         SELECT (SELECT count(*) FROM revoked_principals) AS principals_revoked,
                (SELECT count(*) FROM revoked_tokens)     AS tokens_revoked,
                -- Agents nobody can attribute, so nobody can sweep them up by removing a person.
                (SELECT count(*) FROM principals p
                  WHERE p.workspace_id = $1 AND p.created_by IS NULL
                    AND p.kind <> 'user' AND p.revoked_at IS NULL) AS unattributed_agents`,
        [workspaceId, email.trim().toLowerCase(), now],
      );

      const r = rows[0];
      return {
        principalsRevoked: Number(r?.principals_revoked ?? 0),
        tokensRevoked: Number(r?.tokens_revoked ?? 0),
        unattributedAgents: Number(r?.unattributed_agents ?? 0),
      };
    },

    async listMembers(workspaceId) {
      const { rows } = await db.query<{
        email: string;
        principal_id: string | null;
        invited_at: Date | string;
        joined_at: Date | string | null;
        revoked_at: Date | string | null;
      }>(
        `SELECT email, principal_id, invited_at, joined_at, revoked_at
           FROM memberships WHERE workspace_id = $1 ORDER BY email`,
        [workspaceId],
      );

      return rows.map((r) => ({
        email: r.email,
        ...(r.principal_id === null ? {} : { principalId: r.principal_id as PrincipalId }),
        invitedAt: new Date(r.invited_at).toISOString(),
        ...(r.joined_at == null ? {} : { joinedAt: iso(r.joined_at)! }),
        ...(r.revoked_at == null ? {} : { revokedAt: iso(r.revoked_at)! }),
      }));
    },

    /**
     * Everything the Agent Access screen renders, in one query.
     *
     * Two joins rather than a query per agent: this is a page render, and a list that costs N+1
     * round trips against a pooled connection is a page that gets slower exactly as the workspace
     * accumulates the agents it most needs to show.
     *
     * `token_hash` is never selected. Nothing that could authenticate leaves this method — `last4`
     * is what an operator matches against the string they were shown once, and it is useless to
     * anyone who reads it over their shoulder.
     */
    async listAgents(workspaceId) {
      const { rows } = await db.query<{
        id: string;
        kind: string;
        display_name: string;
        created_at: Date | string;
        created_by_email: string | null;
        revoked_at: Date | string | null;
        source_ids: string[] | null;
        tokens: unknown;
      }>(
        `SELECT p.id, p.kind, p.display_name, p.created_at, p.revoked_at,
                -- The creator resolved to an address, because a principal UUID is not something an
                -- operator can recognise as a colleague.
                m.email AS created_by_email,
                -- The ACTIVE grant. NULL source_ids means every source; '{}' means deny-all, and the
                -- two must stay distinguishable all the way to the screen.
                (SELECT g.source_ids FROM grants g
                  WHERE g.workspace_id = p.workspace_id AND g.principal_id = p.id
                    AND g.revoked_at IS NULL
                  LIMIT 1) AS source_ids,
                COALESCE((
                  SELECT json_agg(json_build_object(
                           'last4', t.last4,
                           'createdAt', t.created_at,
                           'lastUsedAt', t.last_used_at,
                           'expiresAt', t.expires_at,
                           'revokedAt', t.revoked_at
                         ) ORDER BY t.created_at DESC)
                    FROM agent_tokens t
                   WHERE t.workspace_id = p.workspace_id AND t.principal_id = p.id
                ), '[]'::json) AS tokens
           FROM principals p
           LEFT JOIN memberships m
             ON m.workspace_id = p.workspace_id AND m.principal_id = p.created_by
          WHERE p.workspace_id = $1 AND p.kind <> 'user'
          ORDER BY p.revoked_at NULLS FIRST, p.created_at DESC`,
        [workspaceId],
      );

      return rows.map((r) => {
        const tokens = (r.tokens as {
          last4: string;
          createdAt: string;
          lastUsedAt: string | null;
          expiresAt: string | null;
          revokedAt: string | null;
        }[]) ?? [];

        return {
          principalId: r.id as PrincipalId,
          kind: r.kind,
          name: r.display_name,
          createdAt: new Date(r.created_at).toISOString(),
          ...(r.created_by_email === null ? {} : { createdBy: r.created_by_email }),
          ...(r.revoked_at == null ? {} : { revokedAt: iso(r.revoked_at)! }),
          // NOT `?? []`. NULL is "every source"; '{}' is deny-all. Collapsing them here would tell
          // an operator that an unnarrowed credential reaches nothing.
          ...(r.source_ids === null ? {} : { sourceIds: r.source_ids }),
          tokens: tokens.map((t) => ({
            last4: t.last4,
            createdAt: new Date(t.createdAt).toISOString(),
            ...(t.lastUsedAt == null ? {} : { lastUsedAt: iso(t.lastUsedAt)! }),
            ...(t.expiresAt == null ? {} : { expiresAt: iso(t.expiresAt)! }),
            ...(t.revokedAt == null ? {} : { revokedAt: iso(t.revokedAt)! }),
          })),
        };
      });
    },

    /**
     * One agent, and every token it holds, revoked in a single statement.
     *
     * The principal and its tokens must not be two statements: `SqlDriver` is a bare `query` and a
     * `pg.Pool` can route two calls to two connections, so there is no transaction to hold them
     * together. A failure between them leaves a revoked agent whose tokens still authenticate —
     * which is precisely the state this screen exists to make impossible.
     *
     * `kind <> 'user'` in the predicate. A person is removed through membership, which also sweeps
     * up the agents they created; letting this endpoint revoke a user principal would be a second,
     * partial path to the same thing that skips the membership row.
     */
    async revokeAgent(workspaceId, principalId, at) {
      const { rows } = await db.query<{ principals_revoked: string | number; tokens_revoked: string | number }>(
        `WITH revoked_principal AS (
           UPDATE principals SET revoked_at = $3
            WHERE workspace_id = $1 AND id = $2 AND kind <> 'user' AND revoked_at IS NULL
           RETURNING id
         ), revoked_tokens AS (
           -- Not gated on revoked_principal returning a row. Revoking an already-revoked agent must
           -- still sweep any token that survived an earlier partial revocation — the repair path
           -- matters more than the tidy report, and an operator re-clicking Revoke is exactly the
           -- person trying to repair one.
           UPDATE agent_tokens SET revoked_at = $3
            WHERE workspace_id = $1 AND principal_id = $2 AND revoked_at IS NULL
           RETURNING token_id
         )
         SELECT (SELECT count(*) FROM revoked_principal) AS principals_revoked,
                (SELECT count(*) FROM revoked_tokens)    AS tokens_revoked`,
        [workspaceId, principalId, at],
      );

      return {
        principalsRevoked: Number(rows[0]?.principals_revoked ?? 0),
        tokensRevoked: Number(rows[0]?.tokens_revoked ?? 0),
      };
    },

    /** Rate-limited in SQL so a burst of calls writes once, not once per call. */
    async touchToken(tokenId, at) {
      await db.query(
        `UPDATE agent_tokens SET last_used_at = $2
          WHERE token_id = $1
            AND (last_used_at IS NULL OR last_used_at < $3)`,
        [tokenId, at, new Date(new Date(at).getTime() - TOUCH_INTERVAL_MS).toISOString()],
      );
    },
  };
}
