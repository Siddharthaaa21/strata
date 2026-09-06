# Sign-in debug log — every cause, in the order we found them

**Period:** 2026-08-09 → 2026-08-10
**Symptom, unchanged throughout:** request a magic link, receive the email, click it, land back on
`/login`.
**Status:** all six causes closed. The last remaining step needs one fresh magic link.

## Why this document exists

Six independent bugs produced **one identical symptom**. Every fix was followed by a retry that
failed again, which made each fix look ineffective — and each retry cost a magic link on a plan that
allows two per hour. Without a written record, the natural conclusion after the fourth attempt is
"this is fundamentally broken", which was never true.

The other reason: **an expired session and a broken session are indistinguishable from a browser.**
Both are a redirect to `/login`. That is the property that let five of these hide behind each other,
and it is why so much of the fix is about making the failures *say which one they are*.

---

## The causes, in the order they were found

### 1. `NEXT_PUBLIC_*` never reached the browser

**Found:** 2026-08-09 · **Fix:** `apps/web/next.config.ts` + `apps/web/src/lib/root-env.ts`

`NEXT_PUBLIC_*` is substituted into the client bundle **at build time**, and Next only reads `.env`
from the app directory. Ours lives at the repo root.

Every *server* path read the root `.env` fine, so redirects, queries and rendering all worked. Only
the browser was blind — the sign-in button threw "not set" the moment it was clicked.

`root-env.ts` reads the root file and exposes it through `next.config.ts`, using an **allowlist of
literal variable names** — never `startsWith('NEXT_PUBLIC_')`. The same file holds `DATABASE_URL`
and `STRATA_CLI_TOKEN`, and the distance between "expose the public ones" and "inline the database
password into a public JavaScript bundle" is one careless prefix match.

### 2. The local dev issuer refused real sessions

**Found:** 2026-08-09 · **Fix:** `apps/web/src/lib/session.ts`

`STRATA_DEV_AUTH=1` made `claimsFromCookies` check the local cookie and **return** — so a machine
running `npm run dev:local` never looked at the Supabase cookie at all.

The failure is maximally confusing: the magic link works, the PKCE exchange succeeds in 233ms, the
cookie is written, and the very next request behaves as though none of it happened. Nothing in any
log says why, because from that function's point of view nothing went wrong.

The local issuer was being treated as a **mode** when it was only ever meant to be an **addition**.
It now falls through to the provider when no local cookie is present.

### 3. The identity binding was already spent

**Found:** 2026-08-09 · **Fix:** `packages/auth/src/store.ts`, `packages/storage/src/auth-store.ts`

D16 binds an invitation to exactly one `(provider, subject)` credential — right, and it stays. But
`/auth/dev-login` mints a **real** session, so it wrote a real binding. Using the dev shortcut once
permanently spent the member's single binding, and the genuine Supabase credential was then refused
with `no-membership` forever.

A development convenience that locks you out of production authentication is a trap, not a
convenience.

Fixed with `SessionOptions.bindIdentity`. The **caller** decides, because the store is
provider-agnostic by construction and must not learn the name of our dev issuer. A non-binding
session skips the refusal *and* the insert together — it is neither blocked by a binding nor able to
claim one.

> Verified on 2026-08-10: after a dev sign-in, `user_identities` still had **0 rows**.

### 4. Nothing ever refreshed the session — *the big one*

**Found:** 2026-08-10 · **Fix:** `apps/web/src/proxy.ts`, `apps/web/src/lib/token-expiry.ts` (D25)

**There was no middleware and no refresh anywhere in the app.**

Supabase access tokens live about an hour. `claimsFromCookies` verifies locally and returns
`undefined` past `exp`, which every screen turns into a redirect to `/login`. The only client that
can refresh itself is imported by the login form alone — so it never ran on a single page a
signed-in person actually visits.

Every teammate would be signed out one hour after signing in, needing a fresh magic link, on a plan
capped at two emails per hour.

It also explains the retries: each attempt was made *after* a long debugging round, by which point
the previous session had quietly expired. **Every retry looked like the previous fix not working.**

`proxy.ts` refreshes within 5 minutes of expiry, decided by decoding `exp` locally — so ordinary
navigation costs one base64 decode and no network call. It makes **no authorization decision**: it
reads no membership, mints no `Scope`, and discards the `getUser()` result on purpose.

> **Verified, not assumed.** A forged cookie holding an expired token produced
> `[proxy] session refresh failed: Auth session missing!` in the production build — proving the file
> runs *and* that its env was inlined.
>
> **Re-run 2026-08-10 after the rename to Next 16's `proxy.ts` convention, and confirmed identical.**
> Worth doing rather than assuming: a rename that silently disables the file is this bug's favourite
> shape, and it would have restored the exact symptom while every test stayed green.

### 5. A stale link was reported as a broken link

**Found:** 2026-08-10 · **Fix:** `apps/web/src/app/auth/callback/route.ts`, `login/page.tsx` (D26)

The log contradicted itself, one line apart, in messages we wrote ourselves:

```
code exchange failed: PKCE code verifier not found in storage ... (code_verifier cookie present)
```

`@supabase/ssr` 0.12 stores the verifier in **per-flow slots**
(`<storageKey>-flow-<flowId>-code-verifier`), plus a fixed key and an index. Requesting a new link
writes a new slot and evicts older ones. Our check was `name.includes('-code-verifier')`, which
matches all three — so it said "present" whenever *any* flow was pending, including the one that had
just displaced the link being clicked.

Now three states instead of two:

| Verifier slots | Provider said | Reason | Message |
| --- | --- | --- | --- |
| 0 | anything | `browser` | Open it in the browser you asked from |
| >0 | verifier not found | `stale` | **Open the newest email** — a new request cancels older ones |
| >0 | anything else | `link` | Request a new one |

**The middle row was the expensive one.** It used to be collapsed into `link`, whose copy says
"request a new one" — which is exactly what *caused* the failure, and which spends another of two
hourly emails while the working link sits unopened in the inbox.

Also added `token_hash` support to the callback. It needs no verifier, so it survives mail-app
in-app browsers, other devices, and older emails — the whole class. It only applies if the email
template sends `{{ .TokenHash }}`, so both forms are handled and the template can change later
without a code change.

### 6. Every link in the inbox had simply expired

**Found:** 2026-08-10 · **Not a code bug**

```
[auth/callback] provider rejected the link: otp_expired — Email link is invalid or has expired
```

Supabase rejected the link at its own `/auth/v1/verify` endpoint, before our code ran any exchange.
Every email in the inbox was past the OTP expiry (default **1 hour**), having been sent during
earlier debugging rounds.

Our code identified and named this correctly. There is nothing left to fix here — it needs one fresh
link.

---

## Things checked and ruled out

Recorded so nobody re-checks them.

| Checked | Verdict |
| --- | --- |
| `SUPABASE_JWT_SECRET` set | **Was a real problem** — forced HS256 against an ES256 project. Commented out. |
| Root `.env` contents | Correct. All five variables present, values valid. |
| Membership row | Present, `revoked_at` NULL. |
| `user_identities` orphan | Table empty; the "provisioned before identities" branch binds cleanly on next sign-in. |
| Server actually running | **Was a real problem once** — the preview server had died mid-debug and a "reload" hit nothing. |
| Wrong-browser / PKCE mismatch | Ruled out: the verifier cookie was present; the failure was slot eviction (cause 5). |
| Callback discarding its response | Correct already — cookies are written onto the returned redirect. |
| Open redirect on `next` | Correct already — same-origin paths only. |

---

## How each fix was proven

Not "the code looks right" in any case.

- **Cause 3** — queried `user_identities` after a dev sign-in: 0 rows.
- **Cause 4** — forged an expired-token cookie against the **production build** and confirmed the
  refresh attempt in the server log. Re-run after the `proxy.ts` rename.
- **Cause 5** — `curl /login?reason=stale` renders the new copy; an unknown reason still falls
  through to the generic sentence.
- **Whole app** — dev-auth sign-in → Library renders 46 docs; Import, Agent Access and Reader all
  200; the Upload button ran a real import through the real pipeline and reported `1 updated.`
- **Gate** — `npm run verify`: 295 tests, 0 failures.

---

## The pattern, four times now

D17, D22, D23 and D25 are the same property in different clothes:

> **Writing is not the same as being read, and neither is tested by the code that writes.**

- **D17** — the Library shipped without search, because nobody opened the page.
- **D22** — the Claude adapter was right in isolation and the loop was wrong; found by running the
  CLI twice, not by 19 unit tests.
- **D23** — the access log was filled correctly for a whole milestone while its only reader could not
  see its most important rows.
- **D25** — the session was written correctly and read correctly. Nothing tested what it was an hour
  later, because the whole suite runs in under a second.

A fifth, found the same day while verifying cause 4's fix: the Markdown upload input carried
`webkitdirectory`, whose comment claimed it "degrades to a multi-file pick". It does not degrade — in
Chrome it makes the input **folder-only**, so somebody handed three `.md` files could not select
them at all. Found by driving the real control in a real browser. Nothing else would have caught it.

---

## What is still owed, and by whom

**Me:** nothing blocking. Per-agent re-scoping (#31) is the last unbuilt M7 item.

**You, in the Supabase dashboard** — neither is required to sign in:

1. **Raise the OTP expiry.** Auth → Providers → Email. Default is 1 hour; the maximum is 24. Cause 6
   stops happening.
2. **Switch the magic-link template to `{{ .TokenHash }}`.** Links then work in any browser and on
   any device. The code already handles both forms.

**Rate limit:** the built-in mailer allows **2 emails/hour, rolling**. Custom SMTP removes the cap
and needs a provider choice, so it stays your call.
