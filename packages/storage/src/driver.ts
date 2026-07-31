/**
 * Driver adapters.
 *
 * The database is **PostgreSQL**. That is not a placeholder and not a mock — `SCHEMA_SQL` is real
 * DDL and every query in `./index.ts` is real Postgres (`tsvector`, `setweight`, `ts_rank_cd`, GIN,
 * `ON CONFLICT`). Nothing about the data layer is hardcoded or simulated.
 *
 * Two ways to satisfy `SqlDriver`:
 *
 *   Tests   — PGlite: PostgreSQL 18 compiled to WASM, running in-process. It is the same Postgres,
 *             not a lookalike, which is why the tests are meaningful: they exercise the SQL that
 *             ships. It needs no server, no container, and no credentials, so CI runs it as-is.
 *
 *   Runtime — a real Postgres server over the wire, via `fromPoolLike` below.
 *
 * `fromPoolLike` deliberately takes a structural type rather than importing `pg`. That keeps this
 * package free of a client dependency and works with node-postgres, postgres.js, Neon's serverless
 * driver, or a pooled connection from any host — the choice of provider is an operational decision
 * ADR 0004 explicitly left open.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SqlDriver } from './index.ts';

/** The shape every Postgres client library already has. */
export interface PoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Adapts any Postgres client to `SqlDriver`.
 *
 * `exec` maps onto `query` because the driver interface distinguishes them only for PGlite, which
 * needs `exec` for multi-statement DDL. A real client runs multi-statement SQL through `query`.
 *
 * NOTE: untested against a live server — there is no Postgres in this environment yet (see
 * `docs/plan/02-milestones.md`, M4). The adapter is four lines and the SQL underneath it is covered
 * by the PGlite suite, but "connects to a real server" is not yet demonstrated. Treat the first
 * real connection as the thing to verify, not as a formality.
 */
export function fromPoolLike(pool: PoolLike): SqlDriver {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      return pool.query(sql);
    },
  };
}

/**
 * Reads the connection string. Never defaulted to a hardcoded localhost URL: a silent fallback is
 * how a process ends up quietly writing to the wrong database.
 */
export function requireConnectionString(env: Record<string, string | undefined>): string {
  const url = env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Storage requires a PostgreSQL connection string; there is no ' +
        'default. See docs/adr/0004-storage-and-search.md.',
    );
  }
  return url;
}

/**
 * Loads `.env` from a directory into `process.env`, without overwriting anything already set.
 *
 * Deliberately shared: the MCP server, the web app, and three CLI scripts all need the same file,
 * and five hand-rolled parsers is five chances to disagree about quoting. Existing environment
 * variables always win, so a platform-supplied value is never clobbered by a stale local file.
 *
 * Not a full dotenv implementation — no interpolation, no multiline values. If this repo ever needs
 * those, take the dependency rather than growing this.
 */
export function loadDotEnv(dir: string, env: Record<string, string | undefined> = process.env): void {
  let raw: string;
  try {
    raw = readFileSync(join(dir, '.env'), 'utf8');
  } catch (e) {
    // A missing file is normal — the platform may supply the environment instead. Anything else
    // is a real failure and must surface: a blanket catch here previously swallowed a genuine
    // module error and presented it as "no .env", which is a much harder bug to find.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key === undefined || env[key] !== undefined) continue;
    env[key] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
  }
}
