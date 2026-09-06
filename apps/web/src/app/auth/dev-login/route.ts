/**
 * LOCAL ISSUER. Signs a real session token so the app can be run without a provider account.
 *
 * Read `localIssuerAllowed` in `lib/session.ts` before changing anything here — this route is the
 * reason that function is written the way it is.
 *
 * WHAT THIS IS NOT: a bypass. It mints a token and nothing else. That token is verified by the same
 * `verifySessionToken` a Supabase token goes through, and the person it names still has to be on
 * the workspace allowlist before they can see a single document. Sign in as someone who is not a
 * member and you get bounced straight back, exactly as with the real provider.
 *
 * WHAT IT IS: a stand-in for the identity provider, on a developer's machine, for a demo. The
 * signing key is generated per process and never persisted, so sessions die with the server.
 *
 * It answers 404 — not 403 — when it is not allowed. A route that explains itself to an
 * unauthorized caller is a route that tells an attacker on a misconfigured deployment exactly what
 * to look for next.
 */

import { createHmac } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  LOCAL_COOKIE,
  LOCAL_ISSUER,
  localIssuerAllowed,
  localIssuerSecret,
} from '../../../lib/local-issuer.ts';
import { safeInternalPath } from '../../../lib/safe-path.ts';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function GET(request: NextRequest) {
  if (!localIssuerAllowed()) return new NextResponse('Not found', { status: 404 });

  const url = new URL(request.url);
  const email = url.searchParams.get('email')?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json(
      {
        error: 'email is required',
        usage: '/auth/dev-login?email=you@example.com',
        note: 'The address must already be on the allowlist: npm run member -- add <email>',
      },
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: LOCAL_ISSUER,
    aud: 'authenticated',
    // Derived from the address so the same person gets the same principal across restarts, the way
    // a real provider's stable subject id behaves. A random subject each time would mint a new
    // principal per sign-in and make the identity binding untestable locally.
    sub: `local|${createHmac('sha256', 'strata-local-subject').update(email).digest('hex').slice(0, 32)}`,
    email,
    // The local issuer only ever issues verified addresses: there is nobody to deceive, and an
    // unverified one would be refused by the verifier anyway.
    email_verified: true,
    iat: now,
    exp: now + 60 * 60 * 8,
  };

  const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  const signature = createHmac('sha256', localIssuerSecret()).update(input).digest('base64url');

  /**
   * Return to where the person was actually going.
   *
   * Validated exactly as `/auth/callback` validates its own `next`: a same-origin PATH only. A value
   * starting `//` is protocol-relative and therefore absolute (`//evil.example`), so accepting one
   * would turn this into an open redirect — and the auth route is where an open redirect gets used,
   * because the domain in the address bar is genuinely ours right until it is not.
   */
  const next = safeInternalPath(url.searchParams.get('next')) ?? '/';

  const response = NextResponse.redirect(new URL(next, url.origin));
  response.cookies.set(LOCAL_COOKIE, `${input}.${signature}`, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  return response;
}
