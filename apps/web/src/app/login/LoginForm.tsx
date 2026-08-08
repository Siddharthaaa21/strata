'use client';

/**
 * Sign in. No handoff design exists for this screen — see `Login.module.css` and the
 * `screen-login` context-graph node.
 *
 * Email magic link, chosen over OAuth because it needs no provider app registration, no client
 * secret, and no redirect allowlist beyond our own callback. For a handful of teammates that
 * removes the entire setup cost.
 *
 * THE MESSAGE IS DELIBERATELY THE SAME whether or not the address is a member. Saying "you are not
 * on the allowlist" here would turn this form into a membership oracle: anyone could enumerate who
 * works here, one address at a time, without an account. Membership is checked server-side after a
 * link is followed, and a non-member simply lands back here.
 *
 * `linkFailure` arrives as a PROP, resolved by the Server Component in `page.tsx`. It describes the
 * LINK — expired, wrong browser — and never the person, for the reason above.
 */

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '../../lib/supabase-browser.ts';
import styles from './Login.module.css';

export function LoginForm({ linkFailure }: { linkFailure?: string | undefined }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  /**
   * Some provider failures arrive in the URL FRAGMENT (`#error=access_denied&error_code=…`), which
   * a browser never sends to a server — so `page.tsx` cannot see them and neither can any log.
   *
   * This rewrites such an arrival as the query form and lets the server render the message, rather
   * than holding a second copy of the same state on the client. It is a navigation, not a state
   * update, which is also why there is no `setState` in this effect: an effect that immediately
   * sets state is a cascading render, and the framework is right to complain about it.
   */
  useEffect(() => {
    if (window.location.hash === '') return;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const code = fragment.get('error_code') ?? fragment.get('error');
    if (code === null) return;

    window.location.replace(`/login?reason=${code.includes('expired') ? 'expired' : 'link'}`);
  }, []);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (state === 'sending') return;
    setState('sending');
    setError('');

    const { error: err } = await supabaseBrowser().auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // The allowlist IS the invite (ADR 0006 §6b). Letting the provider create a user for an
        // address nobody invited would fill the provider's user table with strangers who can never
        // sign in — noise that looks like a breach the first time somebody reads it.
        shouldCreateUser: true,
      },
    });

    if (err) {
      // Provider errors here are transport-level (rate limit, malformed address, provider down).
      // They carry nothing about membership, so they are safe to show.
      setError(err.message);
      setState('error');
      return;
    }
    setState('sent');
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>Strata</div>

        {state === 'sent' ? (
          <>
            <h1 className={styles.title}>Check your email</h1>
            <p className={styles.subtitle}>
              If that address can access this workspace, a sign-in link is on its way. The link
              works once and expires.
            </p>
            <p className={styles.note}>
              Open it in this browser. A link opened somewhere else — a mail app’s built-in
              browser, or a different one — cannot complete the sign-in, because the proof it needs
              was stored here.
            </p>
            <p className={styles.note}>
              Nothing arrived? The address may not be on the workspace allowlist. Ask whoever set
              this up to add you.
            </p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>Sign in</h1>
            <p className={styles.subtitle}>
              We will email you a link. No password to choose or forget.
            </p>

            {linkFailure !== undefined && <p className={styles.error}>{linkFailure}</p>}

            <form className={styles.form} onSubmit={send}>
              <label className={styles.label} htmlFor="email">
                Email address
              </label>
              <input
                id="email"
                className={styles.input}
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
              <button
                className={styles.button}
                type="submit"
                disabled={state === 'sending' || email.trim() === ''}
              >
                {state === 'sending' ? 'Sending…' : 'Email me a link'}
              </button>
            </form>

            {state === 'error' && <p className={styles.error}>{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}
