---
id: screen-login
kind: screen
title: Sign in
status: in-progress
owner: web
spec: apps/web/src/app/login/page.tsx
depends_on: [dec-auth, contract-membership, svc-storage]
---

The front door. Added by M7 increment 2; **no handoff design exists for it** — `design/handoff/`
covers Library, Import and Reader only. Built entirely from existing `packages/tokens` values rather
than invented ones, so redesigning it later means replacing one CSS module instead of unpicking
hardcoded colours.

Email magic link via Supabase Auth. Chosen over OAuth because it needs no provider app registration,
no client secret, and no redirect allowlist beyond our own callback — for a handful of teammates
that is the whole setup cost removed.

**What this screen does NOT do:** decide anything. It writes a session cookie and nothing else.
Every authority decision happens server-side from that cookie — `lib/session-cookie.ts` extracts the
access token, `@strata/auth` verifies the JWS, and [[contract-membership]] decides whether the person
gets a workspace at all. A stranger with a perfectly valid provider session and no membership row
gets the same treatment as no session: back to this screen. That separation is why it is safe for
any of this to run in a browser.

`/auth/callback` completes the PKCE exchange and is the only other route in the flow. Sign-out is a
server action that clears the cookie.

**Related:** [[screen-agent-access]] is increment 3 and also has no design; when both are drawn they
should be drawn together, since they are the two screens about credentials rather than documents.
