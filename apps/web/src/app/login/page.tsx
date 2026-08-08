/**
 * The sign-in route. A Server Component wrapping the client form, for one reason: it can read
 * `?reason=` from the URL during render.
 *
 * The alternative — reading `window.location` in an effect and calling `setState` — is a cascading
 * render that the lint rule correctly rejects, and `useSearchParams` in a prerendered client
 * component needs a Suspense boundary to avoid bailing out of static rendering. Resolving the text
 * on the server sidesteps both, and keeps the wording where the security argument for it lives.
 */

import { LoginForm } from './LoginForm.tsx';

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
  link: 'That link could not be completed. Request a new one.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams)['reason'];

  // A repeated parameter (`?reason=a&reason=b`) arrives as an ARRAY, and an unknown value is
  // possible from any hand-edited URL. Both fall through to the generic sentence rather than
  // rendering nothing: a returning link that failed must never look like a fresh visit, whatever
  // is in the query string. Absent is the only input that shows no message.
  const reason = Array.isArray(raw) ? raw[0] : raw;
  const message = reason === undefined ? undefined : (LINK_FAILURES[reason] ?? LINK_FAILURES['link']);

  return <LoginForm linkFailure={message} />;
}
