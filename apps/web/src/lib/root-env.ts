/**
 * Reading the monorepo-root `.env` from inside `apps/web`.
 *
 * Next loads `.env*` from the directory it is started in — `apps/web` — and ours lives at the
 * repo root so the CLIs, the MCP server and the web app read one file. Server code papered over
 * that at runtime by mutating `process.env` on first use, and it worked, which is exactly why the
 * real hole stayed invisible for a whole milestone:
 *
 *   `NEXT_PUBLIC_*` is not read at runtime. It is SUBSTITUTED INTO THE CLIENT BUNDLE AT BUILD TIME.
 *
 * So every server path — redirects, membership, the vault — behaved perfectly against a root
 * `.env`, and the one line that runs in a browser (`supabaseBrowser()`) threw
 * "NEXT_PUBLIC_SUPABASE_URL … not set" the first time anybody pressed the button. A server-side
 * workaround cannot fix a build-time substitution, and it hid the symptom everywhere else.
 *
 * Hence this module, imported by `next.config.ts` so the values exist while the bundle is built.
 *
 * NOT a symlink from `apps/web/.env`, which was the shorter fix: a symlink is invisible in a diff,
 * survives no `git clone`, and points a file full of secrets at a directory Next will happily serve
 * from. A dozen lines that say what they do beat a filesystem trick nobody can see.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The ONLY variables allowed to reach the browser.
 *
 * An allowlist of literal names, never a filter over the file's keys — not even
 * `startsWith('NEXT_PUBLIC_')` applied to whatever the file happens to contain. The same file holds
 * `DATABASE_URL` and `STRATA_CLI_TOKEN`, and the distance between "expose the public ones" and
 * "expose the file" is one mistyped predicate. Adding a name here is a deliberate act with a
 * reviewer; matching a pattern is a decision nobody makes again.
 *
 * Both of these are public by design: the URL is a hostname and the publishable key identifies the
 * project without granting anything. The `service_role`/secret key must never appear in this app.
 */
export const CLIENT_ENV_NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const;

/** Parses `.env` syntax. Deliberately the same three rules the CLI scripts use, and no more. */
export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Values for `next.config.ts`'s `env`, drawn from the process first and the root `.env` second.
 *
 * Process-first is what makes a deploy work: on Vercel the platform sets these and there is no file
 * to read, so a file-first order would let a stale committed value beat the configured one.
 *
 * A missing name is OMITTED rather than defaulted to `''`. Next inlines whatever it is given, and an
 * empty string is truthy enough to pass a `!url` guard in some future refactor while being useless
 * as a URL. Absent stays absent, and `supabaseSettings()` says which name is missing.
 */
export function clientEnv(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnv(readFileSync(resolve(cwd, '../../.env'), 'utf8'));
  } catch {
    /* No file is the normal case on a deployment platform. */
  }

  const out: Record<string, string> = {};
  for (const name of CLIENT_ENV_NAMES) {
    const value = env[name]?.trim() || fromFile[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
}
