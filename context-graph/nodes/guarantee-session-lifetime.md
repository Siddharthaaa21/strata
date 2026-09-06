---
id: guarantee-session-lifetime
kind: decision
title: A signed-in session stays signed in
status: done
owner: web
spec: apps/web/src/proxy.ts:1
depends_on: [dec-auth, screen-login, risk-auth-provider]
---

**The property:** a person who signs in stays signed in until they sign out, their membership ends,
or their refresh token genuinely expires — not for one hour.

## What was wrong

A Supabase access token lives about an hour. Nothing in this app renewed it. `claimsFromCookies`
verifies the token locally (correctly — see [[dec-auth]]) and returns `undefined` once `exp` passes,
which every screen turns into a redirect to `/login`. The browser client that can refresh on its own
is imported by exactly one file, the login form, so it never ran on a page a signed-in person
actually visits.

The result: sign-in worked perfectly and then ended, silently, an hour later, with the only remedy
being a fresh magic link. On the free provider plan that is **two emails per hour, rolling** — so
the failure mode was not an inconvenience, it was a workspace a team cannot stay logged into.

It was also expensive to find, because an expired session and a broken one are indistinguishable
from the browser: both are a bounce to `/login`. It survived three separate rounds of auth debugging
and burned real magic links, each of which was blamed on the bug fixed in the round before.

## The shape of the fix

`apps/web/src/proxy.ts` refreshes the credential. Three things it deliberately is not:

1. **Not an authorization check.** It reads no membership, mints no `Scope`, touches no vault. The
   `getUser()` result is discarded on purpose — trusting it is precisely how a middleware becomes
   the access-control decision, which ADR 0006 §5 forbids. Authority stays in `vault.ts`, per
   request, against a signature verified locally.
2. **Not a cache.** ADR 0006 §4's no-cached-authority rule is untouched. A member revoked one second
   ago is refused on the very next request even though their token was just renewed — renewal and
   permission are different questions, and only the second one is cached-never.
3. **Not a gate.** Unconfigured provider, no session cookie, a local-issuer session, or a provider
   outage all fall through to `NextResponse.next()`. Middleware that fails open is correct *here*
   only because it decides nothing; the screens still refuse.

The refresh fires only within `REFRESH_SKEW_S` (5 min) of expiry, decided by decoding `exp` locally
(`lib/token-expiry.ts`). An ordinary navigation therefore costs one base64 decode and no network
call — calling the provider on every request would contradict `session.ts`'s central claim that
verification is local, and would put a network hop on every page render.

`/auth/callback` is **excluded from the matcher**. It performs its own code exchange and writes its
own session cookies; two writers on one response race, and the loser's cookies are the ones the
browser keeps — which would break sign-in itself in the name of preserving it.

## The recurring shape

This is the fourth instance of the property recorded at D17, D22 and D23: *writing is not the same
as being read, and neither is tested by the code that writes.* Here the variant is temporal — the
session was written correctly and read correctly, and nothing tested what happened to it an hour
later. Every test in the suite ran in well under a second.
