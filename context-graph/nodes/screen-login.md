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

**PKCE binds the flow to one browser, and that is the failure people hit first.** Requesting a link
stores a `code_verifier` cookie in the requesting browser; the callback needs it, so a link opened
in a mail app's built-in browser fails in single-digit milliseconds without ever reaching the
provider. The route now logs the provider's own reason plus whether that cookie arrived, and
redirects with a coarse `?reason=` (`browser` / `expired` / `link`) that `page.tsx` — a Server
Component wrapping the form for exactly this — turns into a sentence. **No reason code describes the
person**: membership stays silent or the form becomes an enumeration oracle. See D19.

**`/auth/dev-login` is a LOCAL ISSUER, not a bypass.** It signs a real session token with an
ephemeral per-process key so the app can be demonstrated without a provider account. What it does
NOT do is skip anything downstream: the token goes through the same `verifySessionToken`, and the
person it names must still be on the allowlist before they see one document. Gated by
`localIssuerAllowed()` — explicit `STRATA_DEV_AUTH=1` **and** three independent proofs the process
is not deployed (`VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `NODE_ENV`). It answers 404 rather than 403
when refused, because a route that explains itself tells an attacker on a misconfigured deploy what
to look for. Reached via `npm run dev:local`; plain `npm run dev` uses the real provider.

**This is the only screen whose configuration is read at BUILD time, and it bit us.** `supabaseBrowser()`
runs in a browser, so `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` are substituted
into the bundle by Next, from `.env*` files in `apps/web` — and ours lives at the repo root. Server
code hid that completely by loading the root file into `process.env` at runtime: every redirect and
query worked while this one button threw "not set". `apps/web/next.config.ts` now supplies them via
`src/lib/root-env.ts`, from a **fixed allowlist of two names** — the same file holds `DATABASE_URL`
and `STRATA_CLI_TOKEN`, and anything `env` is handed is inlined into a public artifact. See D18.

Consequence worth remembering: editing those two variables requires a dev-server **restart**, and on
the Supabase free plan the built-in mailer allows **two sign-in emails per hour** — so verify the
browser → provider path with a malformed address (`probe@`, rejected before sending) rather than by
sending real ones.

**Related:** [[screen-agent-access]] is increment 3 and also has no design; when both are drawn they
should be drawn together, since they are the two screens about credentials rather than documents.
