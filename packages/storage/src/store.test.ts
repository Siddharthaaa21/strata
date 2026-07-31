/**
 * Storage tests run against real PostgreSQL — PGlite is Postgres 18 compiled to WASM, in-process.
 * No container, no external service, and the SQL under test is the SQL that ships. A mock would
 * prove nothing here: every invariant below is enforced by Postgres semantics (ON CONFLICT,
 * tsvector weighting, GIN ranking), not by our own code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mintScope } from '@strata/core/scope-internal';
import type {
  Derived,
  DocId,
  Grant,
  GrantId,
  Principal,
  PrincipalId,
  SourceId,
  WorkspaceId,
} from '@strata/core';
import { createDocStore, migrate, MAX_RESULTS, type SqlDriver, type UpsertDocInput } from './index.ts';

const WS_A = 'ws-alpha' as WorkspaceId;
const WS_B = 'ws-beta' as WorkspaceId;
const SRC_CLAUDE = 'src-claude' as SourceId;
const SRC_GITHUB = 'src-github' as SourceId;

function principal(workspaceId: WorkspaceId, id = 'p1'): Principal {
  return { id: id as PrincipalId, kind: 'agent', workspaceId };
}

function grant(workspaceId: WorkspaceId, sourceIds?: readonly SourceId[]): Grant {
  const base = {
    id: 'g1' as GrantId,
    workspaceId,
    principalId: 'p1' as PrincipalId,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
  return sourceIds === undefined ? base : { ...base, sourceIds };
}

const scopeFor = (ws: WorkspaceId, sourceIds?: readonly SourceId[]) =>
  mintScope(principal(ws), grant(ws, sourceIds));

const authored = <T>(value: T): Derived<T> => ({
  value,
  provenance: 'user',
  derivedAt: '2026-07-29T00:00:00.000Z',
});
const guessed = <T>(value: T): Derived<T> => ({
  value,
  provenance: 'model',
  derivedAt: '2026-07-29T00:00:00.000Z',
});

function doc(over: Partial<UpsertDocInput> = {}): UpsertDocInput {
  return {
    id: 'doc-1' as DocId,
    sourceId: SRC_CLAUDE,
    externalId: 'notes/a.md',
    contentHash: 'sha256:aaa',
    title: 'Idempotent Retry Strategy',
    excerpt: authored('Keying scheme so gateway retries never double-write.'),
    folder: authored('Architecture'),
    tags: authored(['ledger', 'retries']),
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    body: 'full document body text',
    ...over,
  };
}

async function freshStore() {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  return { db, store: createDocStore(db) };
}

test('upsert inserts and returns the minted id', async () => {
  const { store } = await freshStore();
  const id = await store.upsert(scopeFor(WS_A), doc());
  assert.equal(id, 'doc-1');
});

test('re-import returns the EXISTING id, not the newly minted one (ADR 0003)', async () => {
  const { db, store } = await freshStore();
  const first = await store.upsert(scopeFor(WS_A), doc());

  // Ingest mints a fresh DocId on every run; the identity tuple is what actually identifies a doc.
  const second = await store.upsert(
    scopeFor(WS_A),
    doc({ id: 'doc-DIFFERENT' as DocId, title: 'Idempotent Retry Strategy v2', contentHash: 'sha256:bbb' }),
  );

  assert.equal(second, first, 'the stored id must win — the minted id is provisional');
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM docs');
  assert.equal(rows[0]?.n, 1, 'a retry after a mid-persist crash must not double-write');
});

test('re-import updates the searchable content', async () => {
  const { store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc());
  await store.upsert(scopeFor(WS_A), doc({ title: 'Completely Different Subject Matter' }));

  const hits = await store.search(scopeFor(WS_A), 'different subject');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.title, 'Completely Different Subject Matter');
});

test('the same externalId in two workspaces does not collide', async () => {
  const { db, store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc({ id: 'doc-a' as DocId }));
  await store.upsert(scopeFor(WS_B), doc({ id: 'doc-b' as DocId }));

  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM docs');
  assert.equal(rows[0]?.n, 2, 'the uniqueness constraint is per workspace');
});

test('search never returns another workspace’s documents', async () => {
  const { store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc({ id: 'doc-a' as DocId }));
  await store.upsert(scopeFor(WS_B), doc({ id: 'doc-b' as DocId }));

  const hits = await store.search(scopeFor(WS_A), 'idempotent retry');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, 'doc-a');
});

test('a Grant narrowed by sourceIds excludes other sources', async () => {
  const { store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc({ id: 'doc-claude' as DocId, sourceId: SRC_CLAUDE, externalId: 'a.md' }));
  await store.upsert(scopeFor(WS_A), doc({ id: 'doc-github' as DocId, sourceId: SRC_GITHUB, externalId: 'b.md' }));

  const unrestricted = await store.search(scopeFor(WS_A), 'idempotent retry');
  assert.equal(unrestricted.length, 2, 'an absent sourceIds means every source');

  const narrowed = await store.search(scopeFor(WS_A, [SRC_GITHUB]), 'idempotent retry');
  assert.deepEqual(narrowed.map((h) => h.id), ['doc-github']);
});

test('an empty sourceIds Grant is deny-all, not allow-all', async () => {
  const { store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc());
  const hits = await store.search(scopeFor(WS_A, []), 'idempotent retry');
  assert.deepEqual(hits, [], 'a present-but-empty sourceIds must deny everything');
});

test('authored tags outrank model-guessed tags (ADR 0004 weighting)', async () => {
  const { store } = await freshStore();
  await store.upsert(
    scopeFor(WS_A),
    doc({ id: 'doc-authored' as DocId, externalId: 'x.md', title: 'X', excerpt: authored(''), tags: authored(['kubernetes']) }),
  );
  await store.upsert(
    scopeFor(WS_A),
    doc({ id: 'doc-guessed' as DocId, externalId: 'y.md', title: 'Y', excerpt: authored(''), tags: guessed(['kubernetes']) }),
  );

  const hits = await store.search(scopeFor(WS_A), 'kubernetes');
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.id, 'doc-authored', 'provenance weighting is inverted');
  assert.ok(
    (hits[0]?.rank ?? 0) > (hits[1]?.rank ?? 0),
    `authored ${hits[0]?.rank} must rank above guessed ${hits[1]?.rank}`,
  );
});

test('a term that appears ONLY in the body is findable', async () => {
  // Regression: search_vector originally indexed title/tags/excerpt/folder but never the body,
  // so a knowledge base could not find text inside its own documents. Every earlier test passed
  // because its search terms happened to be in the title. Caught only by real data.
  const { store } = await freshStore();
  await store.upsert(
    scopeFor(WS_A),
    doc({
      title: 'Unrelated Heading',
      excerpt: authored('also unrelated'),
      folder: authored('misc'),
      tags: authored([]),
      body: 'The distinguishing word here is chrysanthemum, and it appears nowhere else.',
    }),
  );

  const hits = await store.search(scopeFor(WS_A), 'chrysanthemum');
  assert.equal(hits.length, 1, 'document bodies must be searchable');
  assert.equal(hits[0]?.title, 'Unrelated Heading');
});

test('body matches rank below title matches (weight D vs A)', async () => {
  const { store } = await freshStore();
  await store.upsert(
    scopeFor(WS_A),
    doc({ id: 'doc-title' as DocId, externalId: 't.md', title: 'Kubernetes', body: 'unrelated' }),
  );
  await store.upsert(
    scopeFor(WS_A),
    doc({
      id: 'doc-body' as DocId,
      externalId: 'b.md',
      title: 'Unrelated',
      excerpt: authored(''),
      tags: authored([]),
      body: 'This mentions kubernetes only in the body text.',
    }),
  );

  const hits = await store.search(scopeFor(WS_A), 'kubernetes');
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.id, 'doc-title', 'a title match must outrank a body match');
});

test('list browses everything in scope, newest first', async () => {
  const { store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc({ id: 'old' as DocId, externalId: 'o.md', updatedAt: '2026-01-01T00:00:00.000Z' }));
  await store.upsert(scopeFor(WS_A), doc({ id: 'new' as DocId, externalId: 'n.md', updatedAt: '2026-07-01T00:00:00.000Z' }));
  await store.upsert(scopeFor(WS_B), doc({ id: 'other' as DocId, externalId: 'x.md' }));

  const listed = await store.list(scopeFor(WS_A));
  assert.deepEqual(listed.map((d) => d.id), ['new', 'old'], 'recency order, and no cross-workspace rows');
});

test('list filters by folder and respects a narrowed Grant', async () => {
  const { store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc({ id: 'a' as DocId, externalId: 'a.md', folder: authored('Architecture') }));
  await store.upsert(scopeFor(WS_A), doc({ id: 'b' as DocId, externalId: 'b.md', folder: authored('Incidents'), sourceId: SRC_GITHUB }));

  assert.deepEqual((await store.list(scopeFor(WS_A), { folder: 'Incidents' })).map((d) => d.id), ['b']);
  assert.deepEqual((await store.list(scopeFor(WS_A, [SRC_CLAUDE]))).map((d) => d.id), ['a']);
});

test('search results carry no body field', async () => {
  const { store } = await freshStore();
  await store.upsert(scopeFor(WS_A), doc());
  const hits = await store.search(scopeFor(WS_A), 'idempotent retry');
  assert.ok(!('body' in (hits[0] as object)), 'metadata-first retrieval is a contract requirement');
});

test('search clamps limit to MAX_RESULTS', async () => {
  const { store } = await freshStore();
  for (let i = 0; i < 5; i++) {
    await store.upsert(scopeFor(WS_A), doc({ id: `doc-${i}` as DocId, externalId: `f${i}.md` }));
  }
  const hits = await store.search(scopeFor(WS_A), 'idempotent retry', 10_000);
  assert.ok(hits.length <= MAX_RESULTS, 'a caller must not be able to pull the whole workspace');
});

test('get returns the body for an in-scope doc', async () => {
  const { store } = await freshStore();
  const id = await store.upsert(scopeFor(WS_A), doc());
  const got = await store.get(scopeFor(WS_A), id);
  assert.equal(got.body, 'full document body text');
  assert.equal(got.title, 'Idempotent Retry Strategy');
  assert.equal(got.tags.provenance, 'user', 'provenance survives the round trip');
});

test('get throws NotFound across workspaces — indistinguishable from missing', async () => {
  const { store } = await freshStore();
  const id = await store.upsert(scopeFor(WS_A), doc());

  const crossTenant = await store.get(scopeFor(WS_B), id).then(
    () => null,
    (e: Error) => e.message,
  );
  const genuinelyMissing = await store.get(scopeFor(WS_B), 'doc-never-existed' as DocId).then(
    () => null,
    (e: Error) => e.message,
  );

  assert.equal(crossTenant, 'NotFound');
  assert.equal(
    crossTenant,
    genuinelyMissing,
    'a distinguishable error is an enumeration oracle over doc ids',
  );
});

test('get throws NotFound when the Grant excludes the doc’s source', async () => {
  const { store } = await freshStore();
  const id = await store.upsert(scopeFor(WS_A), doc({ sourceId: SRC_CLAUDE }));
  const denied = await store.get(scopeFor(WS_A, [SRC_GITHUB]), id).then(
    () => null,
    (e: Error) => e.message,
  );
  assert.equal(denied, 'NotFound', 'assertVisible must re-check the grant, not just the workspace');
});
