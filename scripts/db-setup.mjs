#!/usr/bin/env node
// Connects to the Postgres named by DATABASE_URL, applies the schema, and verifies the pieces
// ADR 0004 depends on actually work on that server.
//
//   npm run db:setup          apply schema + run checks
//   npm run db:setup -- --check   checks only, no DDL
//
// Reads DATABASE_URL from the environment or a local .env. The URL contains a password: it belongs
// in .env (gitignored), never in a commit, a commit message, or a chat window.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, createDocStore, fromPoolLike } from '@strata/storage';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile() {
  try {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
      if (!m) continue;
      const [, key, rawValue] = m;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — environment may still supply DATABASE_URL */
  }
}

/** Never print the URL itself; a password in a terminal is a password in scrollback. */
function describe(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

loadEnvFile();

const url = process.env['DATABASE_URL'];
const isLocal = process.env['STRATA_LOCAL_DB'] === '1' || url === 'local';

if (!url && !isLocal) {
  console.error(
    'DATABASE_URL is not set.\n\n' +
      'Create a .env at the repo root containing:\n' +
      '  DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require\n\n' +
      'Or run with STRATA_LOCAL_DB=1 to use in-process PGlite.\n\n' +
      '.env is gitignored. There is deliberately no default — a silent localhost fallback is how a\n' +
      'process ends up writing to the wrong database.',
  );
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');

let pool;
let db;

if (isLocal) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite(resolve(ROOT, 'apps/web/.data/strata.db'));
  db = {
    async query(sql, params) {
      const res = await pglite.query(sql, params);
      return { rows: res.rows };
    },
    async exec(sql) {
      return pglite.exec(sql);
    },
  };
  console.log('Connecting to local PGlite (apps/web/.data/strata.db)');
} else {
  pool = new pg.Pool({ connectionString: url, max: 2 });
  db = fromPoolLike(pool);
  console.log(`Connecting to ${describe(url)}`);
}

let failures = 0;
const check = async (label, fn) => {
  try {
    const detail = await fn();
    console.log(`  OK    ${label}${detail ? ` -> ${detail}` : ''}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL  ${label}: ${e.message}`);
  }
};

await check('server reachable', async () => {
  const { rows } = await db.query('SELECT version() AS v');
  return String(rows[0].v).split(',')[0];
});

if (!checkOnly) {
  await check('schema applied', async () => {
    await migrate(db);
    return 'docs, doc_bodies, indexes';
  });
}

await check('tables present', async () => {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('docs','doc_bodies')
      ORDER BY table_name`,
  );
  const names = rows.map((r) => r.table_name);
  if (names.length !== 2) throw new Error(`expected docs + doc_bodies, found: ${names.join(', ') || 'none'}`);
  return names.join(', ');
});

await check('full-text search works on this server', async () => {
  const { rows } = await db.query(
    `SELECT ts_rank_cd(
              setweight(to_tsvector('english', 'idempotent retry strategy'), 'A'),
              websearch_to_tsquery('english', 'idempotent')
            ) AS rank`,
  );
  const rank = Number(rows[0].rank);
  if (!(rank > 0)) throw new Error('ts_rank_cd returned 0 — the english config may be missing');
  return `ts_rank_cd = ${rank.toFixed(4)}`;
});

await check('GIN index present on search_vector', async () => {
  const { rows } = await db.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'docs' AND indexname = 'docs_fts'`,
  );
  if (!rows.length) throw new Error('docs_fts is missing — run without --check to apply the schema');
  return 'docs_fts';
});

// Proves the store works against this server, not just against PGlite, then cleans up after itself.
await check('round trip through the real store', async () => {
  const store = createDocStore(db);
  const scope = await import('@strata/core/scope-internal').then(({ mintScope }) =>
    mintScope(
      { id: 'setup-probe', kind: 'agent', workspaceId: 'ws-setup-probe' },
      { id: 'g', workspaceId: 'ws-setup-probe', principalId: 'setup-probe', createdAt: new Date(0).toISOString() },
    ),
  );
  const derived = (value) => ({ value, provenance: 'user', derivedAt: new Date(0).toISOString() });
  const doc = {
    id: 'doc-setup-probe',
    sourceId: 'src-setup-probe',
    externalId: 'setup-probe.md',
    contentHash: 'sha256:probe',
    title: 'Setup probe document',
    excerpt: derived('written by db:setup, safe to delete'),
    folder: derived('probe'),
    tags: derived(['probe']),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    body: 'probe body',
  };

  const first = await store.upsert(scope, doc);
  const again = await store.upsert(scope, { ...doc, id: 'doc-different-id' });
  if (first !== again) throw new Error(`upsert is not idempotent: ${first} then ${again}`);

  const hits = await store.search(scope, 'setup probe');
  if (!hits.length) throw new Error('search returned nothing for a doc that was just written');

  await db.query('DELETE FROM doc_bodies WHERE workspace_id = $1', ['ws-setup-probe']);
  await db.query('DELETE FROM docs WHERE workspace_id = $1', ['ws-setup-probe']);
  return 'upsert idempotent, search ranked, probe rows removed';
});

if (pool) await pool.end();

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nDatabase ready.');
