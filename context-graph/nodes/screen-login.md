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

`/auth/callback` completes the PKCE exchange. Sign-out is `POST /auth/signout`.

**`/auth/dev-login` is a LOCAL ISSUER, not a bypass.** It signs a real session token with an
ephemeral per-process key so the app can be demonstrated without a provider account. What it does
NOT do is skip anything downstream: the token goes through the same `verifySessionToken`, and the
person it names must still be on the allowlist before they see one document. Gated by
`localIssuerAllowed()` — explicit `STRATA_DEV_AUTH=1` **and** three independent proofs the process
is not deployed (`VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `NODE_ENV`). It answers 404 rather than 403
when refused, because a route that explains itself tells an attacker on a misconfigured deploy what
to look for. Reached via `npm run dev:local`; plain `npm run dev` uses the real provider.

**Related:** [[screen-agent-access]] is increment 3 and also has no design; when both are drawn they
should be drawn together, since they are the two screens about credentials rather than documents.
