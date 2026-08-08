/**
 * Sign out: clear the provider session cookie and return to the login screen.
 *
 * POST only. A GET sign-out is triggerable by any image tag, prefetch, or link on any page on the
 * internet — harmless-looking and endlessly annoying, and it is why the browser's own prefetching
 * can log a user out of an app they are actively using.
 *
 * This ends the SESSION. It does not revoke anything: agent tokens the person created keep working,
 * because they are separate credentials with their own lifecycle (ADR 0006 §6b). Removing a person
 * entirely is `npm run member -- remove`, which does revoke those.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const response = NextResponse.redirect(new URL('/login', origin), {
    // 303, so the browser follows with GET rather than re-POSTing to the login page.
    status: 303,
  });

  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  // Best effort. If the provider call fails we still clear the cookie below — a sign-out that
  // reports failure and leaves the user signed in is the wrong way round for this particular
  // button, which people press when they want to be sure.
  await supabase.auth.signOut().catch(() => {});

  return response;
}
