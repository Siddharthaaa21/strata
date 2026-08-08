/**
 * R5: what happens to a document when its file moves or disappears.
 *
 * Against real PostgreSQL via PGlite, because every claim here is about rows — that a `DocId`
 * survives a move, that a tombstoned document is invisible to *every* read path and not merely to
 * the one that was checked, that a restored file resurrects the row it used to be.
 *
 * Until this existed, ingest handled a rename as a delete-plus-create: the old `DocId` — and every
 * `import_events` row, access-log entry, and agent reference pointing at it — was orphaned, and the
 * document appeared twice. A deleted file had no tombstone at all, so the vault only ever grew.
 *
 * The tests are written around the two ways this feature can be WORSE than the bug it fixes:
 * matching a rename that is not one, and deleting on a run that never authorized deletion.
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
const NOW = '2026-08-09T00:00:00.000Z';

const scope = mintScope(
  { id: 'p1' as PrincipalId, kind: 'user', workspaceId: WS },
  { id: 'g1' as GrantId, workspaceId: WS, principalId: 'p1' as PrincipalId, createdAt: '2026-07-29T00:00:00.000Z' },
);

type Files = Record<string, string>;

function port(files: Files): FileSystemPort {
  return {
    async scan(): Promise<readonly FileEntry[]> {
      return Object.keys(files).map((path) => ({ path, isSymlink: false }));
    },
    async stat(_root, path): Promise<FileStat> {
      return { size: files[path]!.length, modifiedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-07-01T00:00:00.000Z' };
    },
    async readText(_root, path) {
      return files[path]!;
    },
  };
}

async function freshVault() {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  return { db, store: createDocStore(db) };
}

let counter = 0;
type Store = ReturnType<typeof createDocStore>;

async function ingest(store: Store, files: Files, options: { prune?: boolean } = {}) {
  const { pending, failures } = await scanMarkdown(port(files), '/vault', SRC);
  const result = await runIngest({
    scope,
    sourceId: SRC,
    pending,
    failures,
    lookup: storeLookup(scope, store),
    known: await store.listKnown(scope, SRC),
    ...(options.prune === undefined ? {} : { prune: options.prune }),
    newId: () => `doc-${++counter}` as DocId,
    newEventId: () => `evt-${++counter}`,
    now: NOW,
  });
  return persistIngest(scope, store, result, NOW);
}

const ARCH = '# Idempotent Retry Strategy\n\nA keying scheme so gateway retries never double-write the ledger.';
const INCIDENT = '# Token Bucket Rate Limiter\n\nRollout and rollback steps for the shared middleware.';

test('a renamed file keeps its DocId instead of becoming a second document', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'Architecture/idempotency.md': ARCH, 'Incidents/rate-limiter.md': INCIDENT });

  const before = await store.findKnown(scope, SRC, 'Architecture/idempotency.md');
  assert.ok(before, 'seeded');

  const result = await ingest(store, {
    'Design/retries.md': ARCH, // moved AND renamed
    'Incidents/rate-limiter.md': INCIDENT,
  });

  assert.equal(result.counts.renamed, 1);
  assert.equal(result.counts.new, 0, 'a move must not mint a document');

  // The identity claim, which is the entire point: same id, new path.
  const after = await store.findKnown(scope, SRC, 'Design/retries.md');
  assert.equal(after?.docId, before.docId);
  assert.equal(await store.count(scope), 2, 'the vault did not grow');
  assert.equal(await store.findKnown(scope, SRC, 'Architecture/idempotency.md'), undefined);

  // And the operator can see WHICH move was made, not just that one was.
  const moved = result.decisions.find((d) => d.outcome === 'renamed');
  assert.equal(moved?.previousExternalId, 'Architecture/idempotency.md');
});

test('a move updates the folder the document is filed under', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'Architecture/idempotency.md': ARCH });
  assert.deepEqual(await store.folders(scope), ['Architecture']);

  await ingest(store, { 'Design/idempotency.md': ARCH });

  // Not a detail: `folder` is derived from the path, and the Library's filter pills are built from
  // it. A relocate that moved the row but left the folder would file the document under a directory
  // that no longer exists, and the pill for it would return one document forever.
  assert.deepEqual(await store.folders(scope), ['Design']);
});

test('two identical files are never guessed at — an ambiguous rename stays a new document', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'a/one.md': ARCH, 'b/keep.md': INCIDENT });

  // One stored document disappears; TWO new files arrive carrying its exact bytes. Nothing in the
  // content can say which is the move, and picking either would silently rewrite this document's
  // identity to an arbitrary path.
  const result = await ingest(store, { 'c/copy-1.md': ARCH, 'c/copy-2.md': ARCH, 'b/keep.md': INCIDENT });

  assert.equal(result.counts.renamed, 0, 'ambiguity must not be resolved by guessing');
  assert.equal(result.counts.new, 2);
  assert.deepEqual(
    result.deletions.map((d) => d.externalId),
    ['a/one.md'],
    'the vanished file is reported as a deletion candidate rather than silently matched',
  );
});

test('a deleted file is reported but NOT removed unless pruning was asked for', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'Architecture/idempotency.md': ARCH, 'Incidents/rate-limiter.md': INCIDENT });

  const result = await ingest(store, { 'Incidents/rate-limiter.md': INCIDENT });

  // Computed, so the operator can read what a prune WOULD do...
  assert.deepEqual(
    result.deletions.map((d) => d.externalId),
    ['Architecture/idempotency.md'],
  );
  // ...and not acted on, because they did not ask.
  assert.equal(result.deleted, 0);
  assert.equal(await store.count(scope), 2, 'an ordinary ingest must never delete');
  assert.equal(
    result.events.filter((e) => e.status === 'deleted').length,
    0,
    'no deletion happened, so the audit trail must not claim one',
  );
});

test('pruning tombstones the document, and every read path hides it', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'Architecture/idempotency.md': ARCH, 'Incidents/rate-limiter.md': INCIDENT });
  const gone = (await store.findKnown(scope, SRC, 'Architecture/idempotency.md'))!.docId;

  const result = await ingest(store, { 'Incidents/rate-limiter.md': INCIDENT }, { prune: true });
  assert.equal(result.deleted, 1);
  assert.equal(result.counts.deleted, 1);

  // EVERY read path, enumerated rather than sampled. A tombstone filtered out of `list` but not out
  // of `search` is worse than no tombstone: the document is unreachable by browsing and still
  // returned to an agent, so nobody discovers it is supposed to be gone.
  assert.equal(await store.count(scope), 1, 'count');
  assert.deepEqual((await store.list(scope)).map((d) => d.id), [
    (await store.findKnown(scope, SRC, 'Incidents/rate-limiter.md'))!.docId,
  ]);
  assert.deepEqual(await store.folders(scope), ['Incidents'], 'folders');
  assert.equal((await store.search(scope, 'idempotent')).length, 0, 'search');
  await assert.rejects(() => store.get(scope, gone), (e: Error) => e.message === 'NotFound', 'get');

  // The row is still there, which is what makes it a tombstone and not a delete.
  assert.equal((await store.findKnown(scope, SRC, 'Architecture/idempotency.md'))?.docId, gone);
  assert.ok((await store.findKnown(scope, SRC, 'Architecture/idempotency.md'))?.deletedAt);
});

test('the audit trail survives a prune — a deleted document keeps its events', async () => {
  const { db, store } = await freshVault();
  await ingest(store, { 'Architecture/idempotency.md': ARCH });
  const docId = (await store.findKnown(scope, SRC, 'Architecture/idempotency.md'))!.docId;

  await ingest(store, {}, { prune: true });

  // The reason the delete is soft. A hard DELETE would either orphan this row or cascade it away,
  // and an audit trail that loses entries when the thing they describe is removed has lost them
  // exactly when someone needs to ask what happened.
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM docs WHERE id = $1', [docId]);
  assert.equal(rows[0]?.n, 1, 'the row survives');
});

test('a file that comes back resurrects its original document', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'Architecture/idempotency.md': ARCH });
  const original = (await store.findKnown(scope, SRC, 'Architecture/idempotency.md'))!.docId;

  await ingest(store, {}, { prune: true });
  assert.equal(await store.count(scope), 0);

  // Restored with IDENTICAL bytes — the case that breaks a naive implementation. The content hash
  // still matches, so the ordinary comparison says `unchanged` and writes nothing, leaving the row
  // tombstoned while the run cheerfully reports the file as present.
  const result = await ingest(store, { 'Architecture/idempotency.md': ARCH });

  assert.equal(result.counts.unchanged, 0, 'a tombstoned document must be rewritten, not skipped');
  assert.equal(await store.count(scope), 1);
  assert.equal(
    (await store.findKnown(scope, SRC, 'Architecture/idempotency.md'))?.docId,
    original,
    'the same document came back, not a second one',
  );
  assert.equal((await store.search(scope, 'idempotent')).length, 1);
});

test('renaming and deleting in one run does not delete the renamed document', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'a/moved.md': ARCH, 'a/doomed.md': INCIDENT });
  const moving = (await store.findKnown(scope, SRC, 'a/moved.md'))!.docId;

  // Both old paths vanish, but one of them is a move. Treating "not seen" as "deleted" without
  // subtracting the moves would tombstone the document that was just relocated — with prune on,
  // the rename would be undone by the delete in the same run.
  const result = await ingest(store, { 'b/moved.md': ARCH }, { prune: true });

  assert.equal(result.counts.renamed, 1);
  assert.equal(result.deleted, 1, 'only the genuinely missing file');
  assert.deepEqual(
    result.deletions.map((d) => d.externalId),
    ['a/doomed.md'],
  );
  assert.equal((await store.findKnown(scope, SRC, 'b/moved.md'))?.docId, moving);
  assert.equal(await store.count(scope), 1);
});

test('without a known inventory, nothing is renamed or proposed for deletion', async () => {
  const { store } = await freshVault();
  await ingest(store, { 'a/one.md': ARCH });

  // A caller that cannot supply the inventory keeps the old behaviour rather than getting an error
  // or, worse, an empty inventory read as "every document is missing".
  const { pending, failures } = await scanMarkdown(port({ 'b/one.md': ARCH }), '/vault', SRC);
  const result = await runIngest({
    scope,
    sourceId: SRC,
    pending,
    failures,
    lookup: storeLookup(scope, store),
    prune: true,
    newId: () => `doc-${++counter}` as DocId,
    newEventId: () => `evt-${++counter}`,
    now: NOW,
  });

  assert.deepEqual(result.deletions, [], 'an absent inventory must never be read as "all missing"');
  assert.equal(result.counts.renamed, 0);
  assert.equal(result.counts.new, 1);
});
