'use client';

/**
 * The browser-side provider client. Its ONLY job is to sign in and sign out.
 *
 * Deliberately not `server-only`'s counterpart in spirit: nothing here reads the vault, and nothing
 * here decides anything. The session it writes is a cookie; every authority decision is made on the
 * server from that cookie (`lib/session.ts` -> `@strata/auth` -> membership). If this file were
 * deleted and a user pasted a valid cookie by hand, the server would behave identically — which is
 * the property that makes it safe for this to run in a browser at all.
 *
 * COOKIES, NOT localStorage. `createBrowserClient` from `@supabase/ssr` persists the session as a
 * cookie so the server can read it during SSR. The default `supabase-js` client uses localStorage,
 * which the server never sees — with that, every Server Component would render as signed out while
 * the browser insisted it was signed in.
 *
 * The anon key is public by design. It identifies the project and carries no authority beyond what
 * the provider's own rules allow; the service_role key is the dangerous one and must never appear
 * in this app at all.
 */

import { createBrowserClient } from '@supabase/ssr';

let client: ReturnType<typeof createBrowserClient> | undefined;

export function supabaseBrowser() {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. See docs/SETUP.md.',
    );
  }
  // One client per tab. Two would keep two copies of the session and race each other's refreshes.
  client ??= createBrowserClient(url, anonKey);
  return client;
}
