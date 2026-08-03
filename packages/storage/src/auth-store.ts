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
