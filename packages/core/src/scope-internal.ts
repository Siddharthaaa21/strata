/**
 * The only place a `Scope` may be constructed. See ADR 0002.
 *
 * Imported by `packages/auth` (or whatever mints request-scoped auth) and nowhere else. A
 * `post-edit` hook enforces the "nowhere else" half, mirroring the raw-color-literal restriction
 * from D3.
 *
 * `Scope`'s witness field is a type-only brand (same convention as `DocId`/`SourceId` in
 * `./index`), so it is produced by a cast here rather than an object literal with a computed key —
 * there is no separate runtime tag to smuggle out.
 */
import type { Grant, Principal, Scope } from './index';

/**
 * Mints a `Scope` for one request. Throws if the grant is revoked or does not match the
 * principal's workspace. Never cache the result across requests — see `Scope`'s doc comment.
 */
export function mintScope(principal: Principal, grant: Grant): Scope {
  if (grant.revokedAt !== undefined) {
    throw new Error('Grant revoked');
  }
  if (grant.principalId !== principal.id || grant.workspaceId !== principal.workspaceId) {
    throw new Error('Grant does not match principal');
  }
  return { principal, workspaceId: principal.workspaceId, grant } as Scope;
}
