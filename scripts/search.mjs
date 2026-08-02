#!/usr/bin/env node
// Ranked search against the live database. A debugging view of what an agent would receive.
//
//   npm run search -- "idempotent retry"

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { localDevScope } from '@strata/auth';
import { createDocStore, fromPoolLike, requireConnectionString } from '@strata/storage';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of (() => {
  try {
    return readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
})()) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.error('Usage: npm run search -- "<query>"');
  process.exit(1);
}

const workspaceId = process.env['STRATA_WORKSPACE_ID'];
if (!workspaceId) {
  console.error('STRATA_WORKSPACE_ID is not set.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 2 });
const store = createDocStore(fromPoolLike(pool));
const hits = await store.search(localDevScope({ workspaceId }), query);

console.log(`"${query}" -> ${hits.length} result(s)\n`);
for (const h of hits) {
  console.log(`  ${h.rank.toFixed(4)}  ${h.title}`);
  console.log(`          ${h.folder}${h.tags.length ? '  [' + h.tags.join(', ') + ']' : ''}`);
  if (h.excerpt) console.log(`          ${h.excerpt.slice(0, 110)}`);
  console.log();
}

await pool.end();
