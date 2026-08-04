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
     * Resolves a verified session, creating the principal on first sign-in.
     *
     * Membership is looked up by EMAIL, not by the provider's subject id, because the allowlist is
     * written before anyone signs in — an operator adds an address, not a stranger's opaque
     * provider id. The subject is recorded on first sign-in so later logins are stable even if the
     * person changes their email at the provider.
     */
    async resolveSession(claims) {
      const email = claims.email.trim().toLowerCase();

      const membership = await db.query<{
        workspace_id: string;
        principal_id: string | null;
        revoked_at: Date | string | null;
      }>(
        `SELECT workspace_id, principal_id, revoked_at FROM memberships WHERE email = $1`,
        [email],
      );

      const member = membership.rows[0];
      // Not on the allowlist, or membership ended. Both are "no", and the caller reports one word.
      if (member === undefined || member.revoked_at != null) return undefined;

      const workspaceId = member.workspace_id as WorkspaceId;

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
           UPDATE memberships SET principal_id = $2, joined_at = $4
            WHERE workspace_id = $1 AND email = $8 AND principal_id IS NULL`,
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

      // A returning member needs an active grant. Their old one was left revoked by removeMember,
      // and grants_one_active means we cannot simply un-revoke it if another has since been issued.
      await db.query(
        `INSERT INTO grants (workspace_id, id, principal_id, source_ids, created_at)
         SELECT $1, $3, m.principal_id, NULL, $4
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
      await db.query(
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
         )
         UPDATE agent_tokens SET revoked_at = $3
          WHERE workspace_id = $1 AND principal_id IN (SELECT id FROM revoked_principals)`,
        [workspaceId, email.trim().toLowerCase(), now],
      );
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
