#!/usr/bin/env node
// Imports a GitHub repository's Markdown into the vault.
//
//   npm run ingest:github -- <owner/repo> [--branch main] [--max-files 300] [--prune]
//
// Works with NO token against a public repository, at GitHub's unauthenticated ceiling of 60
// requests an hour. Set GITHUB_TOKEN in .env for private repositories and for 5,000/hour — a
// fine-grained token with read-only Contents access is enough, and nothing here can write.
//
// This is the only one of the four connectors with a real API, so unlike the Claude import it can
// genuinely re-sync: re-running is idempotent, because a document's identity is its path in the repo.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
import {
  createGitHubHttpPort,
  parseRepoRef,
  persistIngest,
  runIngest,
  scanGitHubRepo,
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

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('Usage: npm run ingest:github -- <owner/repo> [--branch main] [--prune]');
  console.error('');
  console.error('Works without a token on a public repo (60 requests/hour).');
  console.error('Set GITHUB_TOKEN in .env for private repos and a 5,000/hour limit.');
  process.exit(1);
}

let ref;
try {
  ref = parseRepoRef(target);
} catch {
  console.error(`"${target}" is not a repository. Expected owner/repo, or a github.com URL.`);
  process.exit(1);
}

// One Source per repository, so two repos never share an identity space — `externalId` is the path
// WITHIN a repo, and `docs/README.md` exists in most of them.
const sourceId = arg('--source-id', `src-github-${ref.owner}-${ref.repo}`.toLowerCase());
const maxFiles = Number(arg('--max-files', '300'));
const token = process.env.GITHUB_TOKEN;

console.log(`Reading ${ref.owner}/${ref.repo}${token ? '' : ' (unauthenticated — 60 requests/hour)'}`);

let scanned;
try {
  scanned = await scanGitHubRepo(createGitHubHttpPort(token), ref, sourceId, {
    ...(arg('--branch', undefined) ? { branch: arg('--branch', undefined) } : {}),
    maxFiles,
  });
} catch (e) {
  // Named codes, never a raw message: GitHub's error bodies quote request URLs and, on a private
  // repository, path names (ADR 0003's sanitized-message rule).
  const help = {
    'rate-limited': token
      ? 'GitHub rate limit reached. Wait for the window to reset.'
      : 'GitHub rate limit reached (60/hour unauthenticated). Set GITHUB_TOKEN in .env for 5,000/hour.',
    unauthorized: 'Not authorized. A private repository needs GITHUB_TOKEN with read access to Contents.',
    'not-found': 'No such repository or branch — or it is private and the token cannot see it.',
    network: 'Could not reach api.github.com.',
  };
  console.error(`\n${help[e.code] ?? `GitHub request failed: ${e.code ?? 'unknown'}`}`);
  process.exit(1);
}

const { pending, failures, branch, found, incomplete } = scanned;
console.log(`  branch ${branch}: ${found} markdown file(s) found, ${pending.length} readable`);

const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 4 });
const db = fromPoolLike(pool);
await migrate(db);

const scope = await cliScope(db);
const docs = createDocStore(db);
const sources = createSourceStore(db);
const events = createEventStore(db);

await sources.upsert(scope, {
  id: sourceId,
  kind: 'github',
  name: arg('--name', `${ref.owner}/${ref.repo}`),
  description: `Markdown indexed from github.com/${ref.owner}/${ref.repo}`,
  status: 'connected',
  lastSyncAt: new Date().toISOString(),
});

// PRUNE IS REFUSED ON AN INCOMPLETE SCAN, and this is the guard that matters most in this file.
//
// Pruning means "anything stored but absent from this listing is gone". That is only true if the
// listing is complete. A truncated tree or a `--max-files` cutoff produces a PARTIAL listing that is
// indistinguishable in shape from a complete one — so honouring --prune there would tombstone every
// document that simply fell outside the cutoff. The user asked to remove deleted files, not to
// delete the ones we did not look at.
const askedToPrune = process.argv.includes('--prune');
const prune = askedToPrune && !incomplete;
if (askedToPrune && incomplete) {
  console.error('\nRefusing --prune: this scan was incomplete, so absence proves nothing.');
  console.error(`Raise --max-files above ${maxFiles}, or narrow the repository.`);
}

const known = await docs.listKnown(scope, sourceId);
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

if (incomplete) {
  // Stated loudly and last-but-one, because a partial import that reads as complete is the failure
  // this adapter is most exposed to.
  console.log(`\nINCOMPLETE: ${found} markdown file(s) exist, ${pending.length} were imported.`);
  console.log(`Raise the ceiling with --max-files <n> to take in more.`);
}

if (result.counts.failed) {
  const byCode = new Map();
  for (const f of failures) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  console.log('\nSkipped or failed:');
  for (const [code, n] of byCode) console.log(`  ${n.toString().padStart(3)}  ${code}`);
}

if (result.deletions.length > 0) {
  console.log(
    prune
      ? `\nTombstoned ${result.deleted} document(s) no longer in the repository:`
      : `\n${result.deletions.length} stored document(s) are absent from this scan.` +
          (incomplete ? '' : ' Re-run with --prune to remove them:'),
  );
  for (const d of result.deletions.slice(0, 20)) console.log(`  ${d.externalId}`);
  if (result.deletions.length > 20) console.log(`  ... and ${result.deletions.length - 20} more`);
}

await pool.end();
