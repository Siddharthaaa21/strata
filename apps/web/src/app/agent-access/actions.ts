'use server';

/**
 * The revoke action. Its own module because `'use server'` marks EVERY export in a file as a
 * remotely callable endpoint — putting it in a file alongside helpers would publish those too.
 *
 * `principalId` arrives from a browser and is treated as such. It is not trusted to name a
 * workspace: `revokeAgentAction` re-derives the caller's scope from their session cookie and
 * `revokeAgent` is filtered by the workspace that comes back, so a crafted id belonging to another
 * workspace matches no row and changes nothing. The id is a selector, never an authorization.
 */

import { revokeAgentAction, rescopeAgentAction } from '../../lib/vault.ts';

/** Shared shape check. Not the security boundary — the workspace predicate is — but a malformed id
 *  should be rejected here rather than surface as an opaque driver error through a server action. */
function assertIdShape(principalId: string): void {
  if (typeof principalId !== 'string' || principalId.length === 0 || principalId.length > 64) {
    throw new Error('NotFound');
  }
}

export async function revoke(principalId: string): Promise<{ tokensRevoked: number }> {
  assertIdShape(principalId);
  return revokeAgentAction(principalId);
}

/**
 * Changes what one agent reaches.
 *
 * `sourceIds` is `null` for "every source" rather than `undefined`, because `undefined` does not
 * survive the server-action boundary intact — an omitted argument and an explicit "unnarrow" would
 * arrive identically, and those two mean opposite things here. The conversion to `undefined` happens
 * once, on this line, and nowhere else.
 */
export async function rescope(
  principalId: string,
  sourceIds: readonly string[] | null,
): Promise<{ grantsReplaced: number; tokensRepointed: number }> {
  assertIdShape(principalId);
  if (sourceIds !== null) {
    if (!Array.isArray(sourceIds) || sourceIds.some((s) => typeof s !== 'string' || s.length > 128)) {
      throw new Error('NotFound');
    }
  }
  return rescopeAgentAction(principalId, sourceIds ?? undefined);
}
