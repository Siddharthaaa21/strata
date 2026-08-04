/**
 * Authentication. The only place in the system that mints a `Scope`.
 *
 * ADR 0002 makes this a boundary, not a convention: `mintScope` lives in
 * `@strata/core/scope-internal` and a `post-edit` hook rejects an import of it from anywhere except
 * this package. Everything downstream — storage, MCP, the web app — takes a `Scope` as a parameter.
 *
 * STATUS: no real authentication exists yet (R7, M7). What is here is a single deliberately
 * labelled development path, so that adding real auth later is a change *inside* this package
 * rather than a change to every caller.
 */

import { mintScope } from '@strata/core/scope-internal';
import type { GrantId, PrincipalId, Scope, SourceId, WorkspaceId } from '@strata/core';
import { parseAgentToken, secretMatches } from './tokens.ts';
import type { AuthStore, SessionClaims } from './store.ts';

export * from './tokens.ts';
export * from './store.ts';

/** Why a credential was rejected. For OUR logs — never for the wire. */
export type AuthFailureKind = 'malformed' | 'unknown' | 'revoked' | 'expired' | 'no-membership';

/**
 * Every rejection is this one class, and the caller collapses all of them to a single wire message.
 *
 * `kind` exists so an operator debugging "my agent stopped working" can tell expired from revoked in
 * a server log. Returning that distinction to the caller would let someone probe which `tokenId`s
 * exist, which is the same enumeration problem `NotFound` solves for document ids.
 */
export class AuthError extends Error {
  readonly kind: AuthFailureKind;

  constructor(kind: AuthFailureKind) {
    super(`authentication failed: ${kind}`);
    this.name = 'AuthError';
    this.kind = kind;
  }
}

export interface Authenticator {
  /** Verifies a presented agent token and mints a request `Scope`. */
  scopeFromAgentToken(presented: string): Promise<Scope>;
  /** Turns a verified provider session into a request `Scope`, gated on workspace membership. */
  scopeFromSession(claims: SessionClaims): Promise<Scope>;
}

/**
 * The verification path (ADR 0006 section 4).
 *
 * One indexed lookup per call, and **no cache**. The rule that outlives this code: the maximum
 * legitimate cache TTL equals the revocation latency the Agent Access screen promises the user. It
 * promises immediate, so the TTL is zero. A cache added without changing that copy is a lie in the
 * product, not a performance tweak.
 */
export function createAuthenticator(store: AuthStore, now: () => Date = () => new Date()): Authenticator {
  return {
    async scopeFromAgentToken(presented) {
      const parsed = parseAgentToken(presented);
      if (parsed === undefined) throw new AuthError('malformed');

      const row = await store.lookupToken(parsed.tokenId);
      // An unknown tokenId and a wrong secret return the SAME failure. Distinguishing them would
      // confirm that a given tokenId is real, turning the error channel into an oracle over which
      // credentials exist.
      if (row === undefined) throw new AuthError('unknown');
      if (!secretMatches(parsed.secret, row.tokenHash)) throw new AuthError('unknown');

      if (row.tokenRevokedAt !== undefined || row.principalRevokedAt !== undefined) {
        throw new AuthError('revoked');
      }
      if (row.expiresAt !== undefined && new Date(row.expiresAt).getTime() <= now().getTime()) {
        throw new AuthError('expired');
      }

      // mintScope re-checks the grant's own revocation and that it matches the principal. Kept even
      // though the query could filter it: it is the invariant's home, and belt-and-braces on the one
      // function permitted to create authority is cheap.
      //
      // It throws a bare Error, which is neither AuthError nor ToolError, so it used to fall
      // through the MCP server's catch to `InternalError`. Two problems with that, and the second
      // is the real one: revoking a GRANT was distinguishable from revoking a token or a principal,
      // contradicting "every authentication failure collapses to one word"; and an operator who had
      // just deliberately revoked a grant saw the message the server emits for *bugs*. Translated
      // here rather than in the server, because this is the layer that knows what the throw means.
      let scope: Scope;
      try {
        scope = mintScope(
          { id: row.principalId, kind: row.kind, workspaceId: row.workspaceId },
          row.grant,
        );
      } catch {
        throw new AuthError('revoked');
      }

      // Fire and forget. A failure to record usage must never fail the request it is recording.
      void store.touchToken(parsed.tokenId, now().toISOString()).catch(() => {});
      return scope;
    },

    /**
     * The web app's path. The provider says who someone is; MEMBERSHIP says whether they get a
     * workspace, and that decision stays here rather than in the provider's console (ADR 0006 §5).
     *
     * The caller must have verified the session already — this takes claims, not a cookie or a JWT,
     * so signature checking lives with the provider integration and this function stays
     * provider-agnostic and testable without one.
     */
    async scopeFromSession(claims) {
      if (
        typeof claims?.email !== 'string' ||
        typeof claims.subject !== 'string' ||
        typeof claims.provider !== 'string' ||
        claims.email.trim() === '' ||
        claims.subject === ''
      ) {
        throw new AuthError('malformed');
      }

      // An authenticated stranger is still a stranger. A provider will happily sign in anyone with
      // a Google account; not being on the allowlist is the common case, not an error condition.
      const row = await store.resolveSession({
        provider: claims.provider,
        subject: claims.subject,
        email: claims.email.trim().toLowerCase(),
      });
      if (row === undefined) throw new AuthError('no-membership');
      if (row.principalRevokedAt !== undefined) throw new AuthError('revoked');

      try {
        return mintScope(
          { id: row.principalId, kind: row.kind, workspaceId: row.workspaceId },
          row.grant,
        );
      } catch {
        throw new AuthError('revoked');
      }
    },
  };
}

export interface LocalScopeOptions {
  readonly workspaceId: WorkspaceId;
  /** Absent means every source in the workspace. Present-but-empty means deny-all. */
  readonly sourceIds?: readonly SourceId[];
}

/**
 * A `Scope` for local, single-user development. **Not authentication.**
 *
 * Anything able to start the process gets this workspace: there is no credential, no verification,
 * and no revocation path. Acceptable for a local vault on one machine; not acceptable for anything
 * shared or hosted. Replacing this with a per-connection authenticated principal is M7.
 *
 * Mint per request. Never cache the result — a cached `Scope` is a `Grant` revocation that silently
 * does not take effect.
 */
export function localDevScope(options: LocalScopeOptions): Scope {
  const principalId = 'local-user' as PrincipalId;
  const grant = {
    id: 'local-grant' as GrantId,
    workspaceId: options.workspaceId,
    principalId,
    createdAt: new Date(0).toISOString(),
    ...(options.sourceIds === undefined ? {} : { sourceIds: options.sourceIds }),
  };

  return mintScope(
    { id: principalId, kind: 'user', workspaceId: options.workspaceId },
    grant,
  );
}
