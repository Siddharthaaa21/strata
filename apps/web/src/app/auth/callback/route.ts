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
import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { safeInternalPath } from '../../../lib/safe-path.ts';

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

/**
 * Matches ONE in-flight PKCE flow's verifier slot: `<storageKey>-flow-<flowId>-code-verifier`.
 *
 * Mirrors `@supabase/ssr`'s own `PKCE_VERIFIER_SLOT_KEY`, which is not exported. Copying a regex is
 * a real cost, so it is worth stating why it earns its keep: the naive `name.includes('-code-
 * verifier')` this replaces also matched `<storageKey>-code-verifier` (a fixed key written for every
 * flow) and `<storageKey>-flows-code-verifier` (the index of pending flows). Both are present even
 * when the flow being exchanged has no verifier left, so the diagnostic reported "code_verifier
 * cookie present" at the exact moment the provider said "code verifier not found in storage" — two
 * messages, one line apart in the log, flatly contradicting each other.
 *
 * The cost of that was not cosmetic. It made a STALE link (an older email, whose slot the client
 * evicted when a newer one was requested) indistinguishable from a SPENT one, so the screen told the
 * person to request a new link when they already had one sitting in their inbox.
 */
const PKCE_VERIFIER_SLOT = /-flow-[A-Za-z0-9_-]{8,64}-code-verifier$/;

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
  // `safeInternalPath` is the single implementation of this check (see lib/safe-path.ts). It used
  // to be hand-rolled here, correctly — and hand-rolled correctly in two other files, which is the
  // arrangement where one of them eventually drifts.
  const next = safeInternalPath(url.searchParams.get('next')) ?? '/';

  // The browser-independent link form. `token_hash` needs NO PKCE verifier, so it completes in a
  // mail app's in-app browser, on a phone that is not the machine that asked, and from an older
  // email — every case where `code` fails through no fault of the person clicking. It is only
  // produced when the email template sends `{{ .TokenHash }}`; handling both means the template can
  // be changed (or not) without a code change, and a project that never changes it loses nothing.
  const tokenHash = url.searchParams.get('token_hash');
  if (!code && !tokenHash) return backToLogin(url.origin);

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

  if (tokenHash) {
    const type = (url.searchParams.get('type') ?? 'magiclink') as EmailOtpType;
    const { error: otpError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (otpError) {
      console.warn(`[auth/callback] token_hash verification failed: ${otpError.message}`);
      // No verifier is involved on this path, so there is no browser question to answer. A failure
      // here is genuinely the link: used, expired, or not ours.
      return backToLogin(url.origin, /expired/i.test(otpError.message) ? 'expired' : 'link');
    }
    return response;
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code!);
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
    // THREE states, not two. Collapsing the middle one into "link" is what made a fixable problem
    // read as an unfixable one for three rounds of debugging.
    const slots = request.cookies.getAll().filter((c) => PKCE_VERIFIER_SLOT.test(c.name)).length;
    const notFound = /verifier not found|code verifier/i.test(error.message);

    const state =
      slots === 0
        ? ('browser' as const) // Nothing to exchange with: a different browser, or storage cleared.
        : notFound
          ? ('stale' as const) // Other flows are pending — this link is simply an older email.
          : ('link' as const); // The verifier was there and the provider still refused it.

    console.warn(
      `[auth/callback] code exchange failed: ${error.message} ` +
        `(${slots} pending PKCE flow slot(s); classified as '${state}')`,
    );
    return backToLogin(url.origin, state);
  }

  return response;
}
