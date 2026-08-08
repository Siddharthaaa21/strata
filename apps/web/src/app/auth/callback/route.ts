/**
 * Completes the magic-link sign-in (PKCE code exchange) and sets the session cookie.
 *
 * The only reason this route exists: the link in the email lands here with a `code`, and that code
 * has to be exchanged for a session by a client that holds the PKCE verifier — which lives in a
 * cookie this route can read and the browser client cannot reach mid-navigation.
 *
 * It grants NOTHING on its own. A successful exchange writes a provider session cookie; whether
 * that session can see a single document is decided later and elsewhere, by membership. A stranger
 * who completes this flow perfectly still lands on the Library and is sent straight back to /login.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Sends the person back to sign in, with a coarse reason.
 *
 * The reason describes OUR flow — "the link did not complete an exchange" — never an authorization
 * outcome. Whether an address is a member stays silent (ADR 0006 §5): saying so here would make the
 * sign-in form a membership oracle. A protocol failure carries no such information, and leaving it
 * silent is what turned a five-minute cookie problem into a dead end that looks identical to being
 * refused.
 */
function backToLogin(origin: string, reason?: string): NextResponse {
  const to = new URL('/login', origin);
  if (reason) to.searchParams.set('reason', reason);
  return NextResponse.redirect(to);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  // The provider redirects its OWN failures here too — an expired or already-used link arrives as
  // `error=access_denied&error_code=otp_expired` with no `code`. Without this branch that case is
  // indistinguishable from "no code at all" and the person lands on a clean sign-in form with no
  // hint that their link was simply stale.
  const providerError = url.searchParams.get('error_code') ?? url.searchParams.get('error');
  if (providerError !== null) {
    console.warn(
      `[auth/callback] provider rejected the link: ${providerError} — ` +
        `${url.searchParams.get('error_description') ?? 'no description'}`,
    );
    return backToLogin(url.origin, providerError.includes('expired') ? 'expired' : 'link');
  }

  // `next` lets a link return someone to the page they were trying to reach. It is a URL supplied
  // by whoever crafted the link, so only a same-origin PATH is honoured — accepting an absolute URL
  // here is an open redirect, and an open redirect on the auth callback is the one that gets used,
  // because the domain in the address bar is genuinely ours right up to the moment it is not.
  const requested = url.searchParams.get('next') ?? '/';
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  if (!code) return backToLogin(url.origin);

  const response = NextResponse.redirect(new URL(next, url.origin));

  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        // Written onto the REDIRECT response, not a fresh one. Setting them on a response that is
        // then discarded is the classic version of this bug: the exchange succeeds, the browser is
        // redirected, and no cookie is ever stored — so the app loops back to /login forever with
        // nothing in any log to explain it.
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    // LOG THE REASON. This branch swallowed it, and the cost was concrete: a real sign-in failed,
    // the person landed back on /login, and the only evidence anywhere was a 307 in an access log.
    // The reason is never sent to the browser — it goes here, where an operator can read it, which
    // is the same split `AuthError.kind` and `NotSignedIn.reason` already use.
    //
    // `verifierPresent` is in the message because the overwhelmingly common cause is a PKCE
    // code_verifier that never arrived: the browser that opens the emailed link is not the browser
    // that requested it (a mail client's in-app browser, or a link pasted into a different one).
    // That failure returns in single-digit milliseconds without ever contacting the provider, and
    // it is otherwise indistinguishable from a bad code.
    const verifierPresent = request.cookies
      .getAll()
      .some((c) => c.name.includes('-code-verifier'));
    console.warn(
      `[auth/callback] code exchange failed: ${error.message} ` +
        `(code_verifier cookie ${verifierPresent ? 'present' : 'MISSING — link opened in a different browser?'})`,
    );
    return backToLogin(url.origin, verifierPresent ? 'link' : 'browser');
  }

  return response;
}
