/**
 * The whole product loop, end to end: Markdown files on a (fake) disk -> scan -> dedupe -> persist
 * -> a ranked search that finds them, against real PostgreSQL via PGlite.
 *
 * This is the first test that exercises every stage together. Each stage has its own tests; this
 * one exists to catch the seams between them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mintScope } from '@strata/core/scope-internal';
import type { DocId, GrantId, PrincipalId, SourceId, WorkspaceId } from '@strata/core';
import { createDocStore, migrate, type SqlDriver } from '@strata/storage';
import type { FileEntry, FileSystemPort, FileStat } from './fs-port.ts';
import { scanMarkdown } from './markdown.ts';
import { runIngest } from './pipeline.ts';
import { persistIngest, storeLookup } from './persist.ts';

const WS = 'ws-alpha' as WorkspaceId;
const SRC = 'src-markdown' as SourceId;

const scope = mintScope(
  { id: 'p1' as PrincipalId, kind: 'user', workspaceId: WS },
  { id: 'g1' as GrantId, workspaceId: WS, principalId: 'p1' as PrincipalId, createdAt: '2026-07-29T00:00:00.000Z' },
);

function port(files: Record<string, { text: string; modifiedAt?: string }>): FileSystemPort {
  return {
    async scan(): Promise<readonly FileEntry[]> {
      return Object.keys(files).map((path) => ({ path, isSymlink: false }));
    },
    async stat(_root, path): Promise<FileStat> {
      return {
        size: files[path]!.text.length,
        modifiedAt: files[path]!.modifiedAt ?? '2026-07-28T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
      };
    },
    async readText(_root, path) {
      return files[path]!.text;
    },
  };
}

const VAULT = {
  'Architecture/idempotency.md': {
    text: [
      '---',
      'tags: [ledger, retries]',
      '---',
      '# Idempotent Retry Strategy',
      '',
      'A keying scheme so gateway retries never double-write the ledger.',
    ].join('\n'),
  },
  'Incidents/rate-limiter.md': {
    text: '# Token Bucket Rate Limiter\n\nRollout and rollback steps for the shared middleware.',
  },
  'notes.md': { text: '# Scratch Notes\n\nUnfiled thoughts about kubernetes deployments.' },
};

async function freshVault() {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  return { db, store: createDocStore(db) };
}

let counter = 0;
const ingestOnce = async (
  store: ReturnType<typeof createDocStore>,
  files: Record<string, { text: string; modifiedAt?: string }>,
) => {
  const { pending, failures } = await scanMarkdown(port(files), '/vault', SRC);
  const result = await runIngest({
    scope,
    sourceId: SRC,
    pending,
    failures,
    lookup: storeLookup(scope, store),
    newId: () => `doc-${++counter}` as DocId,
    newEventId: () => `evt-${counter}`,
    now: '2026-07-29T00:00:00.000Z',
  });
  return persistIngest(scope, store, result);
};

test('a folder of Markdown becomes searchable documents', async () => {
  const { store } = await freshVault();
  const result = await ingestOnce(store, VAULT);

  assert.equal(result.counts.new, 3);
  assert.equal(result.written, 3);
  assert.equal(result.counts.failed, 0);

  const hits = await store.search(scope, 'idempotent retry ledger');
  assert.equal(hits[0]?.title, 'Idempotent Retry Strategy');
  assert.equal(hits[0]?.folder, 'Architecture', 'folder came from the directory it was filed in');
  assert.deepEqual(hits[0]?.tags, ['ledger', 'retries']);
});

test('re-running the same scan changes nothing — no duplicates, no rewrites', async () => {
  const { db, store } = await freshVault();
  await ingestOnce(store, VAULT);
  const second = await ingestOnce(store, VAULT);

  assert.equal(second.counts.unchanged, 3, 'every file recognised as already ingested');
  assert.equal(second.counts.new, 0);
  assert.equal(second.written, 0, 'unchanged rows are not rewritten');
  assert.equal(second.skipped, 3);

  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM docs');
  assert.equal(rows[0]?.n, 3, 'idempotent re-import: still three rows');
});

test('editing a file updates it in place and keeps its id', async () => {
  const { db, store } = await freshVault();
  await ingestOnce(store, VAULT);
  const before = await store.search(scope, 'idempotent retry');
  const originalId = before[0]?.id;

  const edited = {
    ...VAULT,
    'Architecture/idempotency.md': {
      text: '---\ntags: [ledger, retries]\n---\n# Idempotent Retry Strategy\n\nNow mentions kubernetes.',
      modifiedAt: '2026-07-30T00:00:00.000Z',
    },
  };
  const result = await ingestOnce(store, edited);

  assert.equal(result.counts.changed, 1);
  assert.equal(result.counts.unchanged, 2);
  assert.equal(result.written, 1, 'only the edited file is rewritten');

  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM docs');
  assert.equal(rows[0]?.n, 3, 'an edit is an update, never a second document');

  const after = await store.search(scope, 'kubernetes');
  assert.equal(after[0]?.id, originalId, 'the document kept its identity across the edit');
  assert.equal(after.length, 2, 'the edited doc and the unfiled note both mention kubernetes');
});

test('a CRLF checkout does not look like an edit', async () => {
  const { store } = await freshVault();
  await ingestOnce(store, VAULT);

  const windowsCheckout = Object.fromEntries(
    Object.entries(VAULT).map(([path, f]) => [path, { text: f.text.replace(/\n/g, '\r\n') }]),
  );
  const result = await ingestOnce(store, windowsCheckout);

  assert.equal(result.counts.unchanged, 3, 'line endings must not re-import the whole vault');
  assert.equal(result.written, 0);
});

test('the full loop is scope-bound: another workspace sees nothing', async () => {
  const { store } = await freshVault();
  await ingestOnce(store, VAULT);

  const otherScope = mintScope(
    { id: 'p2' as PrincipalId, kind: 'user', workspaceId: 'ws-beta' as WorkspaceId },
    {
      id: 'g2' as GrantId,
      workspaceId: 'ws-beta' as WorkspaceId,
      principalId: 'p2' as PrincipalId,
      createdAt: '2026-07-29T00:00:00.000Z',
    },
  );

  assert.deepEqual(await store.search(otherScope, 'idempotent retry'), []);
});

test('failures are reported alongside successes, not instead of them', async () => {
  const { store } = await freshVault();
  const result = await ingestOnce(store, {
    ...VAULT,
    'broken.md': { text: '---\ntitle: [unclosed\n---\nbody' },
  });

  assert.equal(result.counts.new, 3, 'the three good files still land');
  assert.equal(result.counts.failed, 1);

  const failed = result.events.find((e) => e.status === 'failed');
  assert.equal(failed?.error?.code, 'frontmatter-invalid');
  assert.equal(failed?.workspaceId, WS, 'events carry tenancy from the Scope');
});

test('an authored tag outranks the same word guessed elsewhere', async () => {
  const { store } = await freshVault();
  await ingestOnce(store, VAULT);

  // "ledger" is an authored (frontmatter) tag on the idempotency doc and appears only in prose
  // elsewhere, so ADR 0004's weighting should put the tagged document first.
  const hits = await store.search(scope, 'ledger');
  assert.equal(hits[0]?.title, 'Idempotent Retry Strategy');
});

test('one document failing to persist does not erase the audit trail for the rest', async () => {
  // Persist used to throw on the first failure, which aborted the run before `events.append` ever
  // ran — so a single bad document left ZERO rows in import_events, including for the documents
  // already written. The state was invisible in the database and in the Import screen at once.
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const real = createDocStore(db);

  const flaky = {
    ...real,
    async upsert(s: Parameters<typeof real.upsert>[0], input: Parameters<typeof real.upsert>[1]) {
      if (input.externalId === 'b.md') throw new Error('connection lost');
      return real.upsert(s, input);
    },
  };

  const { pending, failures } = await scanMarkdown(
    port({
      'a.md': { text: '# Alpha\n\nfirst' },
      'b.md': { text: '# Bravo\n\nsecond' },
      'c.md': { text: '# Charlie\n\nthird' },
    }),
    '/vault',
    SRC,
  );

  let n = 0;
  const result = await persistIngest(
    scope,
    flaky,
    await runIngest({
      scope,
      sourceId: SRC,
      pending,
      failures,
      lookup: storeLookup(scope, real),
      newId: () => `doc-${++n}` as DocId,
      newEventId: () => `evt-${n}`,
      now: '2026-08-02T00:00:00.000Z',
    }),
  );

  assert.equal(result.written, 2, 'the other two documents still land');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.externalId, 'b.md');

  // The event for the failed document must say `failed`, not `imported`. runIngest decided the
  // status before the write happened, so persistIngest is the only stage that knows better.
  const failedEvent = result.events.find((e) => e.externalId === 'b.md');
  assert.equal(failedEvent?.status, 'failed');
  assert.equal(failedEvent?.error?.code, 'persist-failed');
  assert.equal(failedEvent?.docId, undefined, 'a failed write must not claim a doc id');
  assert.ok(
    !/connection lost/.test(JSON.stringify(result.events)),
    'the driver error must never reach a stored message',
  );

  // And every event still names its file, which is what makes a failure actionable at all.
  for (const e of result.events) assert.ok(e.externalId, `${e.id} names no file`);
  assert.deepEqual(
    result.events.filter((e) => e.status !== 'failed').map((e) => e.externalId).sort(),
    ['a.md', 'c.md'],
  );
});
