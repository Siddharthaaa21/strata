/**
 * How long a JWT has left, read WITHOUT verifying it.
 *
 * Deliberately unverified, and that is safe because of what the answer is used for: deciding
 * whether to ask the provider to refresh. A forged `exp` can make us refresh early (a wasted round
 * trip) or late (the request is rejected downstream and the person signs in again). Neither grants
 * anything. Authority still comes from `verifySessionToken`, which checks the signature against a
 * key we hold and re-reads `exp` itself.
 *
 * Kept in its own file with no imports so `node --test` can load it directly and so the middleware
 * — which runs before any `server-only` module is allowed — can use it.
 */

/**
 * Seconds until `exp`, or `undefined` if the token has no readable one.
 *
 * `undefined` means "cannot tell", which callers must treat as "do not assume it is fresh". A
 * malformed token returning a large positive number would suppress the refresh that is the only
 * thing standing between a teammate and an unexplained sign-out.
 */
export function secondsUntilExpiry(token: string, now: number = Date.now()): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;

  let payload: unknown;
  try {
    // base64url, and `atob`/`Buffer` both reject the URL alphabet, so normalise first. No padding
    // is added: both decoders tolerate its absence, and adding it wrongly is its own bug.
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    return undefined;
  }

  if (payload === null || typeof payload !== 'object') return undefined;
  const exp = (payload as Record<string, unknown>)['exp'];
  // Rejects strings. Some issuers have emitted `exp` as a string, and `"1700000000" - now` is NaN,
  // which compares false against every threshold and silently disables refreshing altogether.
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;

  return exp - Math.floor(now / 1000);
}

/**
 * Whether a token is expired or close enough that it should be refreshed now.
 *
 * `undefined` from `secondsUntilExpiry` answers TRUE. A token we cannot read is one we cannot
 * vouch for, and the cost of being wrong is one refresh call.
 */
export function needsRefresh(token: string, skewSeconds: number, now: number = Date.now()): boolean {
  const left = secondsUntilExpiry(token, now);
  return left === undefined || left <= skewSeconds;
}
