/**
 * Keeps a signed-in session signed in.
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16 deprecated the middleware convention in favour of
 * this one, and the deprecated name still builds, so the rename was verified by re-running the
 * probe that forges an expired session — not by trusting that a rename is a rename. A file that is
 * silently never invoked is precisely the failure mode this whole file exists to prevent.
 *
 * WHY THIS EXISTS. A Supabase access token lives about an hour. Nothing in this app renewed it:
 * `claimsFromCookies` verifies the token locally and returns `undefined` once it expires, which
 * every screen turns into a redirect to `/login`. The browser client that can refresh on its own is
 * imported by exactly one file — the login form — so it never ran on any page a signed-in person
 * actually visits.
 *
 * The result was a sign-in that worked perfectly and then ended, silently, an hour later, with the
 * only remedy being a fresh magic link. On a provider plan capped at two emails an hour that is not
 * an inconvenience; it is a workspace a team cannot stay logged into. It also cost this project
 * several real magic links during debugging, because an expired session and a broken one look
 * identical from the browser.
 *
 * WHAT IT DOES NOT DO. It makes no authority decision. It does not read membership, mint a scope,
 * or consult the vault. Refreshing a credential and deciding what that credential may see are
 * separate jobs, and the second one stays where it was: in `vault.ts`, on every request, against a
 * signature we verify ourselves. ADR 0006 §4's "no cached authority" rule is untouched — nothing
 * here is cached, and a revoked member is still refused on the very next request even though their
 * token was just renewed.
 *
 * COST. The refresh is attempted only inside `REFRESH_SKEW_S` of expiry, so an ordinary navigation
 * decodes one base64 segment and does nothing else. Calling the provider on every request would
 * contradict `session.ts`'s central claim that verification is local, and would put a network hop
 * on the render path of every page.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { accessTokenFromCookies } from './lib/session-cookie.ts';
import { needsRefresh } from './lib/token-expiry.ts';

// NOTE: no `export const runtime`. A Proxy file always runs on the Node.js runtime and Next rejects
// a route segment config here outright. That is the guarantee this code wants anyway — the cookie
// parser it shares with the server uses `Buffer`, which is not something to rely on at the edge.

/**
 * Refresh once the token is inside five minutes of expiry.
 *
 * Long enough that a person reading a document for a few minutes never has a request land on a
 * token that died mid-render, short enough that the provider is untouched for the other ~55.
 */
const REFRESH_SKEW_S = 5 * 60;

/**
 * Header carrying the path the browser actually asked for.
 *
 * A Server Component cannot see its own URL, so `requireVault` had nothing to put in `?next=` and
 * every signed-out visit lost its destination: open `/import` in a fresh browser, sign in, land on
 * the Library. The proxy runs on every request and does know, so it writes it down.
 *
 * This is INFORMATION, not a decision — the proxy still authorises nothing (D25). A forged value
 * cannot widen anything either: it is only ever used to build a redirect, and both `/auth/callback`
 * and `/auth/dev-login` reject anything that is not a same-origin path.
 */
export const PATH_HEADER = 'x-strata-path';

/** `NextResponse.next()` with the requested path attached, so every early return keeps it. */
function passThrough(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  const { pathname, search } = new URL(request.url);
  headers.set(PATH_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  // Unconfigured, or running on the local dev issuer, whose cookie this code path knows nothing
  // about. Passing through is right in both cases: middleware is an optimisation on session
  // lifetime, never a gate, and a gate that fails open would be a bug where this is merely a no-op.
  if (!url || !anonKey) return passThrough(request);

  const cookies = new Map(request.cookies.getAll().map((c) => [c.name, c.value]));
  const token = accessTokenFromCookies(cookies, url);
  // No provider session. Not signed in, or signed in through the local issuer — either way there is
  // nothing here to renew, and the screens decide what that means.
  if (token === undefined) return passThrough(request);
  if (!needsRefresh(token, REFRESH_SKEW_S)) return passThrough(request);

  // Cookies are written onto the response that is actually RETURNED. Writing them to a fresh
  // response and returning a different one is the same discarded-response bug `/auth/callback`
  // documents: the refresh succeeds, the browser is served, and no new cookie is ever stored — so
  // it refreshes again on the next request and the session still dies on schedule.
  const response = passThrough(request);

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // `getUser` is what drives the refresh: the client notices the stored token is expired, spends the
  // refresh token, and hands the new pair to `setAll` above. The returned user is deliberately
  // ignored — trusting it here is how a middleware quietly becomes the authorization check.
  try {
    const { error } = await supabase.auth.getUser();
    // LOGGED, not thrown. `getUser` RETURNS auth failures rather than throwing them, so a bare
    // try/catch here would be silent for the one case that matters most: a refresh token the
    // provider has rejected. That is the difference between "this person's session ended, here is
    // why" and another unexplained bounce to /login — the exact failure this file exists to end.
    if (error) console.warn(`[proxy] session refresh failed: ${error.message}`);
  } catch (e) {
    // A provider outage must not 500 the whole app. The stale cookie survives untouched, the
    // request proceeds, and the screens send the person to sign in if the token is genuinely dead.
    console.warn(`[proxy] session refresh threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except static assets and the auth callback.
     *
     * `/auth/callback` is excluded because it performs its own code exchange and writes its own
     * session cookies. Two writers on one response race, and the loser's cookies are the ones the
     * browser keeps — which would break sign-in itself in the name of preserving it.
     */
    '/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
};
