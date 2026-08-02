#!/usr/bin/env node
// Ingests a folder of Markdown into the database named by DATABASE_URL.
//
//   npm run ingest -- <folder> [--source-id src-markdown] [--name "Local Markdown"] [--reindex]
//
// --reindex forces every file to be re-derived and re-written. Use it after changing the
// normalizer or the search vector, when stored content is identical but the derivation is stale.
//
// Idempotent: re-running reports every unchanged file as skipped-duplicate and writes nothing.

import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { localDevScope } from '@strata/auth';
import {
  createDocStore,
  createEventStore,
  createSourceStore,
  fromPoolLike,
  migrate,
  requireConnectionString,
} from '@strata/storage';
import {
  createNodeFileSystemPort,
  persistIngest,
  runIngest,
  scanMarkdown,
  storeLookup,
} from '@strata/ingest';

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

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};

const folder = process.argv[2];
if (!folder || folder.startsWith('--')) {
  console.error('Usage: npm run ingest -- <folder> [--source-id <id>] [--name <name>]');
  process.exit(1);
}

const target = resolve(process.cwd(), folder);
const sourceId = arg('--source-id', 'src-markdown');
const sourceName = arg('--name', 'Local Markdown');

const workspaceId = process.env['STRATA_WORKSPACE_ID'];
if (!workspaceId) {
  console.error('STRATA_WORKSPACE_ID is not set. See .env.example.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 4 });
const db = fromPoolLike(pool);
await migrate(db);

const scope = localDevScope({ workspaceId });
const docs = createDocStore(db);
const sources = createSourceStore(db);
const events = createEventStore(db);

await sources.upsert(scope, {
  id: sourceId,
  kind: 'markdown',
  name: sourceName,
  description: `Markdown ingested from ${basename(target)}`,
  status: 'connected',
  lastSyncAt: new Date().toISOString(),
});

console.log(`Scanning ${target}`);
const { pending, failures } = await scanMarkdown(createNodeFileSystemPort(), target, sourceId);
console.log(`  ${pending.length} ingestible file(s), ${failures.length} skipped or failed`);

const result = await persistIngest(
  scope,
  docs,
  await runIngest({
    scope,
    sourceId,
    pending,
    failures,
    lookup: storeLookup(scope, docs),
    reprocess: process.argv.includes('--reindex'),
    now: new Date().toISOString(),
  }),
);

// Every event, including failures — storing only successes makes partial-sync bugs invisible.
await events.append(scope, result.events);

console.log(
  `\nnew ${result.counts.new}  changed ${result.counts.changed}  ` +
    `unchanged ${result.counts.unchanged}  failed ${result.counts.failed}`,
);
console.log(`written ${result.written}, skipped ${result.skipped}`);

if (result.counts.failed) {
  console.log('\nSkipped or failed:');
  const bySkipCode = new Map();
  for (const f of failures) bySkipCode.set(f.code, (bySkipCode.get(f.code) ?? 0) + 1);
  for (const [code, n] of bySkipCode) console.log(`  ${n.toString().padStart(3)}  ${code}`);
}

await pool.end();
