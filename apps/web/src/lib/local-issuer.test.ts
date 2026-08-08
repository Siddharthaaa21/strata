/**
 * The guard on the local issuer.
 *
 * `/auth/dev-login` mints a valid session token. Everything downstream still applies — the token is
 * verified normally and membership still decides — but a deployment where this route answers is a
 * deployment anyone can obtain a session on. `localIssuerAllowed()` is the only thing preventing
 * that, so it gets enumerated rather than spot-checked.
 *
 * The test is written as "deny unless ALL of these hold", not as a list of blocked cases, because a
 * list of blocked cases is satisfied by an implementation that blocks exactly those and nothing
 * else — the failure this repo has now hit three times (D15, D16).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
// Imported from `local-issuer.ts`, NOT from `session.ts` which re-exports it. `session.ts` pulls in
// `server-only`, which throws on import outside a Server Component — so importing the guard through
// the convenient path is exactly what makes it untestable. That is the point of the split.
import { localIssuerAllowed } from './local-issuer.ts';

// A plain record rather than NodeJS.ProcessEnv: this repo's TS config makes NODE_ENV
// required and read-only on that type, which would stop the exhaustive sweep below from
// constructing the very environments it needs to test.
type Env = Record<string, string | undefined>;
const check = (e: Env) => localIssuerAllowed(e as NodeJS.ProcessEnv);

/** The one combination that may return true. */
const ALLOWED: Env = { STRATA_DEV_AUTH: '1', NODE_ENV: 'development' };

test('the only environment that permits a local issuer is the explicit, non-deployed one', () => {
  assert.equal(check(ALLOWED), true);
});

test('it is OPT-IN — absent or any value other than "1" denies', () => {
  // Off by default matters more than it looks: a guard that reads "on unless disabled" is one
  // NODE_ENV mistake away from being on everywhere, and nothing about the app would look different.
  for (const v of [undefined, '', '0', 'true', 'yes', 'TRUE', ' 1', '1 ', '01']) {
    const env = { ...ALLOWED, ...(v === undefined ? {} : { STRATA_DEV_AUTH: v }) };
    if (v === undefined) delete (env as Record<string, unknown>)['STRATA_DEV_AUTH'];
    assert.equal(check(env), false, `STRATA_DEV_AUTH=${JSON.stringify(v)} was allowed`);
  }
});

test('any single deployment signal denies, even with the opt-in set', () => {
  // Three independent signals, each sufficient on its own. Vercel and Lambda set theirs and our
  // code cannot unset them; NODE_ENV is production under `next start`. Redundant deliberately —
  // the cost of one of them being absent on some platform is an app anyone can sign into.
  const signals: Env[] = [
    { VERCEL: '1' },
    { VERCEL: '' }, // presence is the signal, not truthiness
    { AWS_LAMBDA_FUNCTION_NAME: 'strata-web' },
    { AWS_LAMBDA_FUNCTION_NAME: '' },
    { NODE_ENV: 'production' },
  ];
  for (const signal of signals) {
    assert.equal(
      check({ ...ALLOWED, ...signal }),
      false,
      `${JSON.stringify(signal)} did not deny`,
    );
  }
});

test('an empty environment denies', () => {
  // The case that matters if this ever runs somewhere the opt-in was never considered.
  assert.equal(check({}), false);
});

test('every combination of the four inputs is denied except exactly one', () => {
  // Exhaustive rather than illustrative. Four booleans is 16 cases, so there is no reason to sample
  // them — and sampling is precisely how a guard ends up correct on the cases someone thought of.
  let allowedCount = 0;
  for (const optIn of [true, false]) {
    for (const vercel of [true, false]) {
      for (const lambda of [true, false]) {
        for (const prod of [true, false]) {
          const env: Env = {};
          if (optIn) env['STRATA_DEV_AUTH'] = '1';
          if (vercel) env['VERCEL'] = '1';
          if (lambda) env['AWS_LAMBDA_FUNCTION_NAME'] = 'fn';
          env['NODE_ENV'] = prod ? 'production' : 'development';

          const got = check(env);
          const want = optIn && !vercel && !lambda && !prod;
          assert.equal(got, want, `mismatch for ${JSON.stringify(env)}`);
          if (got) allowedCount++;
        }
      }
    }
  }
  assert.equal(allowedCount, 1, 'exactly one of the sixteen environments may permit a local issuer');
});
