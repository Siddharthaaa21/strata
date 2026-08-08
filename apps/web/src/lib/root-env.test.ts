/**
 * What crosses the server/browser line.
 *
 * `next.config.ts` hands `clientEnv()`'s result to Next's `env`, and Next SUBSTITUTES every entry
 * into the client bundle as a string literal. So this function's return value is, quite literally,
 * the set of things a stranger with devtools can read. Two failure modes, both tested here:
 *
 *   1. Too little — the bug that prompted the file. The server read the root `.env` at runtime and
 *      worked; the browser needs the values at BUILD time and got none, so the whole app behaved
 *      correctly right up to the sign-in button, which threw. Nothing in 232 tests noticed, because
 *      nothing in 232 tests was a browser.
 *   2. Too much — the same file holds `DATABASE_URL` and `STRATA_CLI_TOKEN`.
 *
 * The second is tested against a fixture containing real secret-shaped names rather than by
 * inspecting `CLIENT_ENV_NAMES`, because asserting the allowlist equals itself proves nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_ENV_NAMES, clientEnv, parseEnv } from './root-env.ts';

type Env = Record<string, string | undefined>;
const call = (env: Env) => clientEnv('/nonexistent/apps/web', env as NodeJS.ProcessEnv);

test('exposes the public Supabase settings when the process carries them', () => {
  const out = call({
    NEXT_PUBLIC_SUPABASE_URL: 'https://ref.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_abc',
  });

  assert.deepEqual(out, {
    NEXT_PUBLIC_SUPABASE_URL: 'https://ref.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_abc',
  });
});

test('never exposes anything outside the allowlist, however it is named', () => {
  const out = call({
    NEXT_PUBLIC_SUPABASE_URL: 'https://ref.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_abc',
    DATABASE_URL: 'postgresql://user:password@host/db',
    STRATA_CLI_TOKEN: 'stra_at_id_secret',
    SUPABASE_JWT_SECRET: 'shhh',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_dangerous',
    // The trap: a secret somebody has mislabelled. A `startsWith('NEXT_PUBLIC_')` filter over the
    // file's keys would ship this to every browser, and it would look deliberate in the diff.
    NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_mislabelled',
  });

  assert.deepEqual(Object.keys(out).sort(), [...CLIENT_ENV_NAMES].sort());
  const serialised = JSON.stringify(out);
  for (const secret of ['password', 'stra_at_', 'shhh', 'sb_secret_']) {
    assert.ok(!serialised.includes(secret), `client env leaked ${secret}`);
  }
});

test('omits a missing name rather than defaulting it to an empty string', () => {
  const out = call({ NEXT_PUBLIC_SUPABASE_URL: 'https://ref.supabase.co' });

  // `''` would be inlined by Next and would satisfy a `!== undefined` check in some future
  // refactor while being useless as a key — a configuration error that presents as a signature
  // failure. Absent must stay absent so `supabaseSettings()` can name what is missing.
  assert.deepEqual(Object.keys(out), ['NEXT_PUBLIC_SUPABASE_URL']);
  assert.ok(!Object.hasOwn(out, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'));
});

test('treats whitespace-only as missing', () => {
  assert.deepEqual(call({ NEXT_PUBLIC_SUPABASE_URL: '   ' }), {});
});

test('parseEnv strips quotes and ignores comments and blank lines', () => {
  const parsed = parseEnv(
    ['# a comment', '', 'NEXT_PUBLIC_SUPABASE_URL="https://ref.supabase.co"', "OTHER='x'", 'junk'].join('\n'),
  );

  assert.equal(parsed['NEXT_PUBLIC_SUPABASE_URL'], 'https://ref.supabase.co');
  assert.equal(parsed['OTHER'], 'x');
  assert.ok(!Object.hasOwn(parsed, 'junk'));
});

test('a value already in the process beats the file', async () => {
  // Process-first is what makes a deploy correct: on Vercel the platform supplies these and there
  // is no file, so a file-first order would let a stale local value win wherever both exist.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'strata-env-'));
  const web = join(root, 'apps', 'web');
  mkdirSync(web, { recursive: true });
  writeFileSync(
    join(root, '.env'),
    'NEXT_PUBLIC_SUPABASE_URL=https://stale.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_fromfile\n',
  );

  const platform: Env = { NEXT_PUBLIC_SUPABASE_URL: 'https://platform.supabase.co' };
  const out = clientEnv(web, platform as NodeJS.ProcessEnv);

  assert.equal(out['NEXT_PUBLIC_SUPABASE_URL'], 'https://platform.supabase.co');
  // …and the file still fills the gap the process left.
  assert.equal(out['NEXT_PUBLIC_SUPABASE_ANON_KEY'], 'sb_publishable_fromfile');
});

test('a missing file is not an error — that is the deployed case', () => {
  assert.deepEqual(call({}), {});
});
