import 'server-only';

/**
 * Turning a browser request into verified `SessionClaims` (ADR 0006 §5, increment 2).
 *
 * The division of labour, which is the whole point of the file:
 *
 *   - `session-cookie.ts` knows Supabase's cookie SHAPE. Provider-specific, pure, heavily tested.
 *   - `@strata/auth`'s `verifySessionToken` knows JWS. Provider-agnostic, hand-written, no deps.
 *   - This file holds them together and reads configuration.
 *
 * Nothing here decides whether the person may use the workspace. That is membership, and it lives
 * in `scopeFromSession` — keeping the two apart is what stops a provider's user list from quietly
 * becoming our access-control list.
 *
 * VERIFICATION IS LOCAL. We do not call the provider's `getUser()` on every request: that is a
 * network round trip on the render path, and an outage at the provider becomes an outage here. The
 * signature is checked against a key we hold, which is what a JWT is for.
 */

import { verifySessionToken, SessionError, type SessionClaims, type SessionVerifierConfig } from '@strata/auth';
import { accessTokenFromCookies } from './session-cookie.ts';
import { LOCAL_COOKIE, LOCAL_ISSUER, localIssuerAllowed, localIssuerSecret } from './local-issuer.ts';

// Re-exported so callers have one import for "the session layer" while the guard itself stays in a
// file `node --test` can load. See local-issuer.ts for why that separation exists.
export { LOCAL_COOKIE, LOCAL_ISSUER, localIssuerAllowed, localIssuerSecret };

/**
 * How long a fetched JWKS is trusted before refetching.
 *
 * This is NOT a session cache — sessions are verified per request, and ADR 0006 §4's "no cache"
 * rule is about revocation, which this cannot delay. It caches the provider's PUBLIC KEYS, which
 * change only on rotation, and a rotation is handled explicitly below rather than by waiting out
 * the TTL.
 */
const JWKS_TTL_MS = 10 * 60 * 1000;

export interface SupabaseSettings {
  readonly url: string;
  readonly anonKey: string;
  readonly issuer: string;
  readonly jwtSecret?: string;
}


/**
 * Reads configuration, or explains exactly what is missing.
 *
 * Throws rather than falling back. A web app that silently drops to an unauthenticated mode when a
 * variable is unset is one misconfigured deploy away from serving the whole vault to the internet,
 * and the symptom is that everything looks like it works.
 */
export function supabaseSettings(env: NodeJS.ProcessEnv = process.env): SupabaseSettings {
  const url = env['NEXT_PUBLIC_SUPABASE_URL']?.trim();
  const anonKey = env['NEXT_PUBLIC_SUPABASE_ANON_KEY']?.trim();

  const missing = [
    url ? null : 'NEXT_PUBLIC_SUPABASE_URL',
    anonKey ? null : 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Supabase is not configured: ${missing.join(', ')} not set.\n` +
        'Project Settings -> API in the Supabase dashboard. Use the ANON/publishable key, never ' +
        'the service_role key — service_role bypasses every check in this codebase.\n' +
        'See docs/SETUP.md.',
    );
  }

  const jwtSecret = env['SUPABASE_JWT_SECRET']?.trim();
  return {
    url: url!,
    anonKey: anonKey!,
    // Derived, not configured separately: two settings that must agree are two settings that can
    // disagree, and `iss` is checked exactly, so a mismatch rejects every token with no clue why.
    issuer: `${url!.replace(/\/+$/, '')}/auth/v1`,
    ...(jwtSecret ? { jwtSecret } : {}),
  };
}

interface CachedKeys {
  readonly keys: Record<string, import('node:crypto').JsonWebKey>;
  readonly fetchedAt: number;
}
let jwksCache: CachedKeys | undefined;

/**
 * Fetches the provider's public keys.
 *
 * Supabase signs with asymmetric keys (ES256/RS256) on current projects and with a shared HS256
 * secret on legacy ones. Both are supported because we cannot tell from here which a given project
 * uses, and guessing wrong rejects every token.
 */
async function fetchJwks(issuer: string): Promise<Record<string, import('node:crypto').JsonWebKey>> {
  const res = await fetch(`${issuer}/.well-known/jwks.json`, { cache: 'no-store' });
  if (!res.ok) throw new SessionError(`jwks fetch failed: ${res.status}`);

  const body: unknown = await res.json();
  const keys = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new SessionError('jwks: no keys array');

  const out: Record<string, import('node:crypto').JsonWebKey> = {};
  for (const k of keys) {
    if (k !== null && typeof k === 'object' && typeof (k as { kid?: unknown }).kid === 'string') {
      out[(k as { kid: string }).kid] = k as import('node:crypto').JsonWebKey;
    }
  }
  if (Object.keys(out).length === 0) throw new SessionError('jwks: no usable keys');
  return out;
}

async function verifierConfig(
  settings: SupabaseSettings,
  forceRefresh = false,
): Promise<SessionVerifierConfig> {
  const base = { issuer: settings.issuer, audience: 'authenticated' } as const;

  // Legacy shared secret. `assertOneKeyKind` in the verifier refuses to hold both kinds at once, so
  // configuring a secret means the header can never promote a token to asymmetric verification.
  if (settings.jwtSecret) return { ...base, hmacSecret: settings.jwtSecret };

  const fresh = forceRefresh || jwksCache === undefined || Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS;
  if (fresh) jwksCache = { keys: await fetchJwks(settings.issuer), fetchedAt: Date.now() };
  return { ...base, publicKeys: jwksCache!.keys };
}

/**
 * Verifies the request's session cookie and returns its claims, or `undefined` if there is none.
 *
 * `undefined` means "not signed in", which is the ordinary state of a first visit and not an error.
 * A token that is PRESENT and bad also returns undefined: the caller's response is the same either
 * way (send them to sign in), and the distinction is not one worth leaking to a browser.
 */
export async function claimsFromCookies(
  cookies: ReadonlyMap<string, string>,
  settings: SupabaseSettings | undefined = undefined,
): Promise<SessionClaims | undefined> {
  // The local issuer is checked FIRST and returns early, so a machine running it never falls
  // through to provider configuration it does not have. Note what is NOT special-cased below:
  // verification, membership, and scope minting are the same code for both. A local session is a
  // real session that happens to be signed by us — it is not a bypass, and a person with one still
  // has to be on the allowlist to see a single document.
  if (settings === undefined && localIssuerAllowed()) {
    const raw = cookies.get(LOCAL_COOKIE);
    if (raw === undefined || raw === '') return undefined;
    try {
      return verifySessionToken(raw, {
        issuer: LOCAL_ISSUER,
        audience: 'authenticated',
        hmacSecret: localIssuerSecret(),
      });
    } catch {
      return undefined;
    }
  }

  const resolved = settings ?? supabaseSettings();
  const token = accessTokenFromCookies(cookies, resolved.url);
  if (token === undefined) return undefined;
  return providerClaims(token, resolved);
}

async function providerClaims(
  token: string,
  settings: SupabaseSettings,
): Promise<SessionClaims | undefined> {

  try {
    return verifySessionToken(token, await verifierConfig(settings));
  } catch (e) {
    // An unknown `kid` is the signature of a key rotation, not of a forged token: the provider has
    // started signing with a key minted after our JWKS was cached. Refetch once and retry, because
    // the alternative is signing every user out for up to the TTL every time a key rotates.
    if (e instanceof SessionError && e.reason === 'unknown kid' && !settings.jwtSecret) {
      try {
        return verifySessionToken(token, await verifierConfig(settings, true));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Test seam. Key rotation and TTL expiry are otherwise only reachable by waiting ten minutes. */
export function resetJwksCacheForTests(): void {
  jwksCache = undefined;
}
