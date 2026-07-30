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
