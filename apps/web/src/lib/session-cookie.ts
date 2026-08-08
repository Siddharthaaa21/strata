/**
 * Getting the provider's access token out of a request's cookies.
 *
 * Separated from everything that touches Next or the database so it can be tested as what it is: a
 * parser for a hostile string. Every value here arrives from the browser, which means from anyone.
 *
 * This is the only file in the repo that knows Supabase's cookie SHAPE. Verification does not live
 * here — that is `@strata/auth`'s `verifySessionToken`, which is provider-agnostic and stays that
 * way. Swapping providers should change this file and nothing behind it.
 *
 * WHY IT IS MORE THAN `cookies.get(name)`. Supabase stores the whole session — access token,
 * refresh token, user object — as JSON in a cookie, and a cookie has a ~4KB browser limit. So the
 * client base64-encodes it, and when it still does not fit, SPLITS it across numbered cookies
 * (`sb-<ref>-auth-token.0`, `.1`, ...). A reader that fetches the unsuffixed name alone works
 * perfectly until a user's token grows — which happens when a provider adds claims, not when we
 * change anything — and then everyone is silently signed out with no error anywhere.
 */

/** Supabase's own marker for a base64-encoded cookie payload. */
const BASE64_PREFIX = 'base64-';

/**
 * A hard ceiling on reassembled cookie size.
 *
 * Cookies are attacker-controlled and chunks are concatenated, so without a bound a client can hand
 * the server an arbitrarily large string to JSON.parse on every request. 64KB is far above any real
 * session (which struggles past 8KB) and far below anything that matters.
 */
const MAX_TOTAL_BYTES = 64 * 1024;

/** How many chunks to look for. Supabase numbers from 0; five is already an implausible session. */
const MAX_CHUNKS = 8;

/**
 * The cookie name Supabase uses, derived from the project ref.
 *
 * The ref is the first label of the project host: `https://abcdefgh.supabase.co` -> `abcdefgh`.
 * Derived rather than configured separately, because two settings that must agree are two settings
 * that can disagree, and the one that loses is the one nobody was looking at.
 */
export function projectRef(supabaseUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    return undefined;
  }
  const first = host.split('.')[0];
  // A bare hostname with no dot (localhost, an IP) has no ref to extract, and returning the whole
  // host would produce a cookie name that silently matches nothing.
  if (first === undefined || first === '' || first === host) return undefined;
  return first;
}

export function authCookieName(supabaseUrl: string): string | undefined {
  const ref = projectRef(supabaseUrl);
  return ref === undefined ? undefined : `sb-${ref}-auth-token`;
}

/**
 * Reassembles the cookie, chunked or not, and returns the raw payload string.
 *
 * Returns undefined rather than throwing for every "not signed in" shape, because not being signed
 * in is the ordinary case for a login page and is not an error.
 */
function reassemble(cookies: ReadonlyMap<string, string>, base: string): string | undefined {
  const whole = cookies.get(base);
  if (typeof whole === 'string' && whole !== '') return whole;

  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = cookies.get(`${base}.${i}`);
    // Chunks are contiguous from 0. Stopping at the first gap rather than skipping it matters: a
    // client that supplies .0 and .2 must not have them silently spliced into something that looks
    // like a valid session.
    if (typeof part !== 'string' || part === '') break;
    total += part.length;
    if (total > MAX_TOTAL_BYTES) return undefined;
    parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join('');
}

/**
 * Pulls the access token out of the session cookie.
 *
 * Every failure is `undefined`, never a throw. This runs on every request including unauthenticated
 * ones, and a parser that throws on malformed input hands anyone a 500 for the price of a bad
 * cookie.
 */
export function accessTokenFromCookies(
  cookies: ReadonlyMap<string, string>,
  supabaseUrl: string,
): string | undefined {
  const base = authCookieName(supabaseUrl);
  if (base === undefined) return undefined;

  const raw = reassemble(cookies, base);
  if (raw === undefined || raw.length > MAX_TOTAL_BYTES) return undefined;

  let json = raw;
  if (raw.startsWith(BASE64_PREFIX)) {
    try {
      json = Buffer.from(raw.slice(BASE64_PREFIX.length), 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  // Supabase has shipped both shapes: a bare session object, and `[session, ...]`. Accepting both
  // costs one line and avoids an upgrade signing everybody out.
  const session = Array.isArray(parsed) ? parsed[0] : parsed;
  if (session === null || typeof session !== 'object') return undefined;

  const token = (session as Record<string, unknown>)['access_token'];
  if (typeof token !== 'string' || token === '') return undefined;
  return token;
}

/** Parses a `Cookie:` header into a map. Exported for the tests and for any non-Next caller. */
export function parseCookieHeader(header: string | null | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === '') continue;
    // First occurrence wins. A duplicated cookie name is how a subdomain or a stale path shadows
    // the real one; taking the last would let an attacker who can set a cookie on a neighbouring
    // host override the session that the real login flow wrote.
    if (!out.has(name)) out.set(name, decodeURIComponent(value));
  }
  return out;
}
