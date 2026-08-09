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

import { revokeAgentAction } from '../../lib/vault.ts';

export async function revoke(principalId: string): Promise<{ tokensRevoked: number }> {
  // Shape check before the query. Not a security boundary — the workspace predicate is — but a
  // malformed id should be a rejection here rather than a driver error thrown through a server
  // action, where it would surface to the browser as an opaque failure.
  if (typeof principalId !== 'string' || principalId.length === 0 || principalId.length > 64) {
    throw new Error('NotFound');
  }
  return revokeAgentAction(principalId);
}
