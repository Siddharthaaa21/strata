#!/usr/bin/env node
// Imports a Claude data export into the vault.
//
//   npm run ingest:claude -- <path to conversations.json> [--projects <projects.json>] [--prune]
//
// Get the export from claude.ai: Settings -> Privacy -> Export data. A link is emailed to you and
// EXPIRES IN 24 HOURS. Unzip it and point this at `conversations.json`.
//
// This is an import, not a connector, and deliberately so — there is no Claude API to sync from
// (D22). Re-running after a fresh export is idempotent: conversation uuids are stable, so unchanged
// threads report as unchanged and a renamed one is an update on the same document.

import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createDocStore,
  createEventStore,
  createSourceStore,
  fromPoolLike,
  migrate,
  requireConnectionString,
} from '@strata/storage';
import { cliScope } from './lib/cli-scope.mjs';
import { persistIngest, projectFolders, runIngest, scanClaudeExport, storeLookup } from '@strata/ingest';

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

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('Usage: npm run ingest:claude -- <conversations.json> [--projects <projects.json>]');
  console.error('');
  console.error('Get the export from claude.ai: Settings -> Privacy -> Export data.');
  console.error('The emailed link expires in 24 hours.');
  process.exit(1);
}

const target = resolve(process.cwd(), file);
const sourceId = arg('--source-id', 'src-claude');
const sourceName = arg('--name', 'Claude');

let raw;
try {
  raw = readFileSync(target, 'utf8');
} catch {
  // Never the caught error: a filesystem error carries the full path, and the path to somebody's
  // Claude export is not something to print into a shared terminal or a CI log.
  console.error(`Could not read ${basename(target)}.`);
  process.exit(1);
}

// Optional. A user who exported only conversations still gets a working import — they just lose
// folders, which is a far better trade than refusing the whole thing.
const projectsPath = arg('--projects', undefined);
let projectsByConversation = new Map();
if (projectsPath) {
  try {
    projectsByConversation = projectFolders(readFileSync(resolve(process.cwd(), projectsPath), 'utf8'));
    console.log(`Read ${projectsByConversation.size} project assignment(s)`);
  } catch {
    console.error(`Could not read ${basename(projectsPath)} — continuing without project folders.`);
  }
}

console.log(`Reading ${basename(target)}`);
let scanned;
try {
  scanned = scanClaudeExport(raw, sourceId, { projectsByConversation });
} catch (e) {
  // The whole-file shape failing is the likeliest operator mistake — the export ZIP holds four JSON
  // files and only one of them is this. Reporting "0 imported" instead would be indistinguishable
  // from an account with no conversations.
  console.error(`\n${e.message}`);
  console.error('Expected the `conversations.json` file from a Claude export ZIP.');
  process.exit(1);
}

const { pending, failures } = scanned;
console.log(`  ${pending.length} conversation(s), ${failures.length} skipped or failed`);

const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 4 });
const db = fromPoolLike(pool);
await migrate(db);

// Verified against the database like every other caller. NOTE this is a WRITE path: a token
// narrowed away from this source is refused rather than silently writing nothing.
const scope = await cliScope(db);
const docs = createDocStore(db);
const sources = createSourceStore(db);
const events = createEventStore(db);

await sources.upsert(scope, {
  id: sourceId,
  kind: 'claude',
  name: sourceName,
  description: 'Conversations imported from a Claude data export',
  status: 'connected',
  lastSyncAt: new Date().toISOString(),
});

const known = await docs.listKnown(scope, sourceId);
const prune = process.argv.includes('--prune');
const now = new Date().toISOString();

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
    known,
    prune,
    now,
  }),
  now,
);

await events.append(scope, result.events);

console.log(
  `\nnew ${result.counts.new}  changed ${result.counts.changed}  ` +
    `renamed ${result.counts.renamed}  unchanged ${result.counts.unchanged}  ` +
    `deleted ${result.deleted}  failed ${result.counts.failed}`,
);
console.log(`written ${result.written}, skipped ${result.skipped}`);

if (result.counts.failed) {
  const byCode = new Map();
  for (const f of failures) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  console.log('\nSkipped or failed:');
  for (const [code, n] of byCode) console.log(`  ${n.toString().padStart(3)}  ${code}`);
}

// Deletions are reported whether or not they were applied — this is the whole value without
// --prune: what a prune WOULD remove, before anyone runs one. Especially important here, where a
// partial export (one project, say) would legitimately leave most of the vault unseen.
if (result.deletions.length > 0) {
  console.log(
    prune
      ? `\nTombstoned ${result.deleted} conversation(s) absent from this export:`
      : `\n${result.deletions.length} stored conversation(s) are absent from this export.` +
          ' Re-run with --prune to remove them — but only if this export is COMPLETE:',
  );
  for (const d of result.deletions.slice(0, 20)) console.log(`  ${d.externalId}`);
  if (result.deletions.length > 20) console.log(`  ... and ${result.deletions.length - 20} more`);
}

await pool.end();
