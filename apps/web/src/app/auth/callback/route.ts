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

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  // `next` lets a link return someone to the page they were trying to reach. It is a URL supplied
  // by whoever crafted the link, so only a same-origin PATH is honoured — accepting an absolute URL
  // here is an open redirect, and an open redirect on the auth callback is the one that gets used,
  // because the domain in the address bar is genuinely ours right up to the moment it is not.
  const requested = url.searchParams.get('next') ?? '/';
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';

  if (!code) return NextResponse.redirect(new URL('/login', url.origin));

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
  if (error) return NextResponse.redirect(new URL('/login', url.origin));

  return response;
}
