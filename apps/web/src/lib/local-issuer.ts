/**
 * The guard on the local issuer, and its constants.
 *
 * DELIBERATELY FREE OF `server-only`, and that is the entire reason this file exists separately
 * from `session.ts`. `server-only` throws on import outside a Server Component — including under
 * `node --test` — so anything living beside it is code the test runner cannot load. This repo has
 * already been bitten by that once: the `MarkdownBody` ReDoS survived review partly because it sat
 * in a file the runner could not reach (D15). **Code the test runner cannot reach will eventually
 * be wrong**, and the last place to accept that is the check standing between a token minter and
 * production.
 *
 * Nothing here touches a request, a cookie, or a secret. It reads environment variables and returns
 * a boolean, which is exactly the kind of thing that should be exhaustively testable.
 */

import { randomBytes } from 'node:crypto';

/**
 * The local issuer's signing key.
 *
 * Generated per process and never written anywhere. That is deliberate: a key on disk is a key that
 * can be copied to a server, and a key in `.env` is one that gets committed eventually. Restarting
 * the dev server invalidates every local session, which is exactly the right amount of durability
 * for something that exists so a demo can run without a provider account.
 */
const globalForDevKey = globalThis as unknown as { strataDevKey?: string };
export function localIssuerSecret(): string {
  globalForDevKey.strataDevKey ??= randomBytes(32).toString('hex');
  return globalForDevKey.strataDevKey;
}

/** The issuer string local tokens carry. Never a value any real provider would emit. */
export const LOCAL_ISSUER = 'strata-local-dev';

/**
 * A cookie name distinct from any real project's.
 *
 * `sb-<ref>-auth-token` is derived from the configured Supabase URL, so this cannot collide with a
 * genuine session — and a browser holding both does not get them confused.
 */
export const LOCAL_COOKIE = 'sb-devlocal-auth-token';

/**
 * True only when a LOCAL issuer may stand in for the identity provider.
 *
 * This is the single guard the whole local-sign-in path rests on, so it is deliberately hostile: an
 * explicit opt-in AND three independent proofs that this is not a deployment. `VERCEL` and
 * `AWS_LAMBDA_FUNCTION_NAME` are set by the platform and cannot be unset from our code; `NODE_ENV`
 * is `production` under any `next start`. Any one would do; all four are checked because the cost
 * of being wrong is an application anyone can obtain a session on.
 *
 * OPT-IN, not "on in development". A guard that reads "enabled unless disabled" is one `NODE_ENV`
 * mistake away from being enabled everywhere, and nothing about the running app would look
 * different. `npm run dev:local` sets it; plain `npm run dev` does not and uses the real provider.
 *
 * Presence, not truthiness, is the signal for the platform variables — `VERCEL=` set to an empty
 * string still means Vercel.
 */
export function localIssuerAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['STRATA_DEV_AUTH'] !== '1') return false;
  if (env['VERCEL'] !== undefined) return false;
  if (env['AWS_LAMBDA_FUNCTION_NAME'] !== undefined) return false;
  if (env['NODE_ENV'] === 'production') return false;
  return true;
}
