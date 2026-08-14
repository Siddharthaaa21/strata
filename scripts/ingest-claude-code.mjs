#!/usr/bin/env node
// Recovers documents Claude WROTE, from local Claude Code session transcripts.
//
//   npm run ingest:claude-code -- --list
//   npm run ingest:claude-code -- --project PorTfolio-React
//   npm run ingest:claude-code -- --ignore design-handoff-strata-workspace
//   npm run ingest:claude-code -- --dry-run
//
// No export, no API, no token. Claude Code already writes every session to
// `~/.claude/projects/<slug>/*.jsonl`, and those transcripts contain the full text of every file
// written — so a document is recoverable even if the file was never kept.
//
// Only `Write` calls produce documents, and only document-ish extensions. See
// `packages/ingest/src/claude-code.ts` for why edits are counted rather than applied.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
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
import { persistIngest, runIngest, scanClaudeCode, storeLookup } from '@strata/ingest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const line of (() => {
  try {
    return readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
})()) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

/** Every `--flag value` occurrence, so --project and --ignore can be repeated. */
const all = (flag) =>
  process.argv.reduce((acc, a, i) => (a === flag && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc), []);

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
if (!existsSync(PROJECTS_DIR)) {
  console.error(`No Claude Code transcripts found at ${PROJECTS_DIR}.`);
  process.exit(1);
}

const slugs = readdirSync(PROJECTS_DIR).filter((d) => {
  try {
    return readdirSync(join(PROJECTS_DIR, d)).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
});

// A slug is the project path with separators flattened; matching on substring is what lets someone
// type the folder name they recognise rather than the whole mangled string.
const wanted = all('--project');
const ignored = all('--ignore');
const selected = slugs.filter(
  (s) =>
    (wanted.length === 0 || wanted.some((w) => s.toLowerCase().includes(w.toLowerCase()))) &&
    !ignored.some((g) => s.toLowerCase().includes(g.toLowerCase())),
);

if (process.argv.includes('--list')) {
  console.log(`Claude Code projects with transcripts (${slugs.length}):\n`);
  for (const s of slugs) {
    const files = readdirSync(join(PROJECTS_DIR, s)).filter((f) => f.endsWith('.jsonl'));
    const mark = selected.includes(s) ? ' ' : '-';
    console.log(`  ${mark} ${s}  (${files.length} session${files.length === 1 ? '' : 's'})`);
  }
  console.log(`\n"-" means excluded by --project / --ignore. Nothing was written.`);
  process.exit(0);
}

if (selected.length === 0) {
  console.error('No projects matched. Run with --list to see what is available.');
  process.exit(1);
}

const transcripts = [];
for (const slug of selected) {
  for (const f of readdirSync(join(PROJECTS_DIR, slug)).filter((x) => x.endsWith('.jsonl'))) {
    try {
      transcripts.push({ project: slug, jsonl: readFileSync(join(PROJECTS_DIR, slug, f), 'utf8') });
    } catch {
      // One unreadable transcript must not lose the rest.
      console.error(`  could not read ${slug}/${f} — skipping`);
    }
  }
}

console.log(`Reading ${transcripts.length} session(s) across ${selected.length} project(s)`);

const sourceId = 'src-claude-code';
const scanned = await scanClaudeCode(transcripts, sourceId);
console.log(`  ${scanned.recovered} document(s) recovered, ${scanned.stale} with later edits not reflected`);
console.log(`  ${scanned.pending.length} ingestible, ${scanned.failures.length} skipped or failed`);

if (process.argv.includes('--dry-run')) {
  console.log('\n--dry-run: nothing written. What WOULD be imported:\n');
  for (const d of scanned.pending.slice(0, 40)) console.log(`  ${d.externalId}\n      ${d.title}`);
  if (scanned.pending.length > 40) console.log(`  ... and ${scanned.pending.length - 40} more`);
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 4 });
const db = fromPoolLike(pool);
await migrate(db);

const scope = await cliScope(db);
const docs = createDocStore(db);
const sources = createSourceStore(db);
const events = createEventStore(db);

await sources.upsert(scope, {
  id: sourceId,
  kind: 'claude',
  name: 'Claude Code',
  description: 'Documents Claude wrote, recovered from local session transcripts',
  status: 'connected',
  lastSyncAt: new Date().toISOString(),
});

const now = new Date().toISOString();

// NO --prune, and no flag to enable one. A transcript is an append-only record of what happened; a
// document missing from this scan means the session that wrote it was rotated away, NOT that the
// document was deleted. Pruning on that basis would erase exactly the old work this adapter exists
// to recover.
const result = await persistIngest(
  scope,
  docs,
  await runIngest({
    scope,
    sourceId,
    pending: scanned.pending,
    failures: scanned.failures,
    lookup: storeLookup(scope, docs),
    reprocess: process.argv.includes('--reindex'),
    known: await docs.listKnown(scope, sourceId),
    now,
  }),
  now,
);

await events.append(scope, result.events);

console.log(
  `\nnew ${result.counts.new}  changed ${result.counts.changed}  ` +
    `renamed ${result.counts.renamed}  unchanged ${result.counts.unchanged}  failed ${result.counts.failed}`,
);
console.log(`written ${result.written}, skipped ${result.skipped}`);

await pool.end();
