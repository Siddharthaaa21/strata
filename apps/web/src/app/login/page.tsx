/**
 * The sign-in route. A Server Component wrapping the client form, for one reason: it can read
 * `?reason=` from the URL during render.
 *
 * The alternative — reading `window.location` in an effect and calling `setState` — is a cascading
 * render that the lint rule correctly rejects, and `useSearchParams` in a prerendered client
 * component needs a Suspense boundary to avoid bailing out of static rendering. Resolving the text
 * on the server sidesteps both, and keeps the wording where the security argument for it lives.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginForm } from './LoginForm.tsx';
import { verifySessionToken } from '@strata/auth';
import {
  LOCAL_COOKIE,
  LOCAL_ISSUER,
  localIssuerAllowed,
  localIssuerSecret,
} from '../../lib/local-issuer.ts';

/**
 * Why a returning link did not sign someone in.
 *
 * Every entry describes the LINK, never the person. "Not on the allowlist" is deliberately absent
 * and must stay absent: that answer belongs to nobody who has not already signed in, or the form
 * becomes a way to enumerate colleagues one address at a time (ADR 0006 §5). A PKCE exchange that
 * could not complete carries no such information, which is exactly why it is safe to explain — and
 * why leaving it unexplained turned a cookie-jar mismatch into a silent loop back to this page.
 */
const LINK_FAILURES: Record<string, string> = {
  browser:
    'That link has to be opened in the same browser you requested it from. Copy it out of your ' +
    'mail app and paste it into this browser, or just request a new one from here.',
  expired: 'That link has expired or was already used. Request a new one.',
  // The one that is NOT "request a new one" — because requesting another is what caused it, and on
  // a provider plan capped at two emails an hour that advice costs the person their remaining one.
  // Asking for a link invalidates the pending flows before it, so the newest email in the inbox is
  // the only one that can work. Say that, rather than sending them around the loop again.
  stale:
    'That was an older link. Only the most recent email works — open the newest one in your inbox. ' +
    'Requesting another link cancels the ones before it.',
  link: 'That link could not be completed. Request a new one.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['reason'];
  const nextRaw = params['next'];
  const next = Array.isArray(nextRaw) ? nextRaw[0] : nextRaw;

  /**
   * Local development: skip the form entirely.
   *
   * `npm run dev:inside` sets `STRATA_DEV_AUTH=1` and `STRATA_DEV_EMAIL`, and this turns the last
   * login-shaped step — pasting a `/auth/dev-login?email=` URL — into nothing at all. Opening the
   * app signs you in.
   *
   * THIS WEAKENS NO GUARD. `localIssuerAllowed()` is unchanged and still demands an explicit opt-in
   * plus three independent proofs the process is not deployed, and `/auth/dev-login` re-checks it
   * and 404s otherwise. The address still has to be on the workspace allowlist before it sees a
   * single document. All that changes is who types the URL.
   *
   * The loop guard tests whether the cookie VERIFIES, not whether one is present — and the
   * difference is not academic. The local issuer's signing key is generated per process and never
   * persisted, so **every dev server restart invalidates every local cookie**. Presence alone
   * therefore said "you already have a session" about a cookie that could no longer be verified by
   * anything, stranding you on a sign-in form that the whole point of this branch is to skip, with
   * no way out but clearing cookies by hand. Restarts are constant; this fired on all of them.
   *
   * Verifying instead keeps the property the guard was for: a cookie that verifies and STILL lands
   * here was refused for a real reason — not on the allowlist, membership revoked — and redirecting
   * again would loop forever while hiding the message that explains it.
   */
  const devEmail = process.env['STRATA_DEV_EMAIL']?.trim();
  if (devEmail && localIssuerAllowed()) {
    const existing = (await cookies()).get(LOCAL_COOKIE)?.value;
    let usable = false;
    if (existing !== undefined && existing !== '') {
      try {
        verifySessionToken(existing, {
          issuer: LOCAL_ISSUER,
          audience: 'authenticated',
          hmacSecret: localIssuerSecret(),
        });
        usable = true;
      } catch {
        // Stale or forged. Either way it cannot authenticate, so it must not block a fresh one.
        usable = false;
      }
    }
    if (!usable) {
      // The destination rides along, so a deep link survives the automatic sign-in instead of
      // dumping you on the Library. `/auth/dev-login` re-validates it as a same-origin path.
      const to = next ? `&next=${encodeURIComponent(next)}` : '';
      redirect(`/auth/dev-login?email=${encodeURIComponent(devEmail)}${to}`);
    }
  }

  // A repeated parameter (`?reason=a&reason=b`) arrives as an ARRAY, and an unknown value is
  // possible from any hand-edited URL. Both fall through to the generic sentence rather than
  // rendering nothing: a returning link that failed must never look like a fresh visit, whatever
  // is in the query string. Absent is the only input that shows no message.
  const reason = Array.isArray(raw) ? raw[0] : raw;
  const message = reason === undefined ? undefined : (LINK_FAILURES[reason] ?? LINK_FAILURES['link']);

  return <LoginForm linkFailure={message} next={next} />;
}
