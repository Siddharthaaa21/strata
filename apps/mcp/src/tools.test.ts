/**
 * MCP tool-surface tests. Runs the handlers against a real store (PGlite / PostgreSQL 18), because
 * the properties under test — tenancy isolation, indistinguishable errors, no body in search — are
 * only meaningful end to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mintScope } from '@strata/core/scope-internal';
import { FENCE_PREAMBLE } from '@strata/core';
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
import { createDocStore, migrate, MAX_RESULTS, type SqlDriver } from '@strata/storage';
import { TOOL_SCHEMAS, ToolError, getDoc, searchDocs } from './tools.ts';

const WS_A = 'ws-alpha' as WorkspaceId;
const WS_B = 'ws-beta' as WorkspaceId;
const SRC = 'src-claude' as SourceId;
const OTHER_SRC = 'src-github' as SourceId;

function scopeFor(ws: WorkspaceId, sourceIds?: readonly SourceId[]) {
  const p: Principal = { id: 'p1' as PrincipalId, kind: 'agent', workspaceId: ws };
  const base = {
    id: 'g1' as GrantId,
    workspaceId: ws,
    principalId: 'p1' as PrincipalId,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
  const g: Grant = sourceIds === undefined ? base : { ...base, sourceIds };
  return mintScope(p, g);
}

const authored = <T>(value: T): Derived<T> => ({
  value,
  provenance: 'user',
  derivedAt: '2026-07-29T00:00:00.000Z',
});

async function seeded() {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const store = createDocStore(db);
  const id = await store.upsert(scopeFor(WS_A), {
    id: 'doc-1' as DocId,
    sourceId: SRC,
    externalId: 'a.md',
    contentHash: 'sha256:aaa',
    title: 'Idempotent Retry Strategy',
    excerpt: authored('Keying scheme so gateway retries never double-write.'),
    folder: authored('Architecture'),
    tags: authored(['ledger']),
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    body: 'The ledger service currently retries failed writes without an idempotency key.',
  });
  return { store, id };
}

test('tool signatures are pinned — a rename breaks agent workflows silently', () => {
  // Changing this list is changing a published interface. Update it deliberately, never to make a
  // failing test pass — an agent's stored workflow breaks silently when a tool is renamed.
  assert.deepEqual(Object.keys(TOOL_SCHEMAS), ['search_docs', 'get_doc', 'list_sources']);
  assert.deepEqual(TOOL_SCHEMAS.list_sources.inputSchema.required, []);
  assert.equal(TOOL_SCHEMAS.list_sources.inputSchema.additionalProperties, false);
  assert.deepEqual(TOOL_SCHEMAS.search_docs.inputSchema.required, ['query']);
  assert.deepEqual(TOOL_SCHEMAS.get_doc.inputSchema.required, ['doc_id']);
  assert.equal(TOOL_SCHEMAS.search_docs.inputSchema.additionalProperties, false);
  assert.equal(TOOL_SCHEMAS.get_doc.inputSchema.additionalProperties, false);
  assert.equal(TOOL_SCHEMAS.search_docs.inputSchema.properties.limit.maximum, MAX_RESULTS);
});

test('no mutating tool exists (D5: the surface is read-only)', () => {
  const names = Object.keys(TOOL_SCHEMAS).join(' ');
  for (const forbidden of ['create', 'update', 'delete', 'write', 'sync']) {
    assert.ok(!names.includes(forbidden), `${forbidden} tool must not exist yet`);
  }
});

test('search returns metadata with a single fence preamble, and no body', async () => {
  const { store } = await seeded();
  const out = await searchDocs(scopeFor(WS_A), store, { query: 'idempotent retry' });

  assert.equal(out.notice, FENCE_PREAMBLE);
  assert.equal(out.results.length, 1);
  assert.ok(!('body' in (out.results[0] as object)), 'search must never carry bodies');
  assert.ok(!('content' in (out.results[0] as object)));
  assert.equal(JSON.stringify(out).split(FENCE_PREAMBLE).length - 1, 1, 'one preamble per response');
});

test('no payload ever contains workspaceId', async () => {
  const { store, id } = await seeded();
  const search = JSON.stringify(await searchDocs(scopeFor(WS_A), store, { query: 'idempotent' }));
  const single = JSON.stringify(await getDoc(scopeFor(WS_A), store, { doc_id: id }));

  for (const payload of [search, single]) {
    assert.ok(!payload.includes('workspace'), 'workspaceId is an access-control input, not data');
    assert.ok(!payload.includes(WS_A), 'the workspace id value must not appear either');
  }
});

test('search does not cross a workspace boundary', async () => {
  const { store } = await seeded();
  const out = await searchDocs(scopeFor(WS_B), store, { query: 'idempotent retry' });
  assert.deepEqual(out.results, []);
});

test('search clamps an oversized limit', async () => {
  const { store } = await seeded();
  const out = await searchDocs(scopeFor(WS_A), store, { query: 'idempotent', limit: 100000 });
  assert.ok(out.results.length <= MAX_RESULTS);
});

test('search rejects malformed input rather than coercing it', async () => {
  const { store } = await seeded();
  for (const bad of [{}, { query: '' }, { query: 42 }, { query: 'ok', limit: 'ten' }]) {
    await assert.rejects(
      () => searchDocs(scopeFor(WS_A), store, bad),
      (e: Error) => e.message === 'InvalidInput',
    );
  }
});

test('get_doc fences the body in a nonce envelope', async () => {
  const { store, id } = await seeded();
  const out = await getDoc(scopeFor(WS_A), store, { doc_id: id });

  assert.ok(out.content.startsWith(FENCE_PREAMBLE));
  assert.match(out.content, /<untrusted-document nonce="[0-9a-f]{16}">/);
  assert.match(out.content, /<\/untrusted-document nonce="[0-9a-f]{16}">/);
  assert.ok(out.content.includes('idempotency key'), 'the body itself is still delivered');
});

test('each get_doc response uses a fresh nonce', async () => {
  const { store, id } = await seeded();
  const a = await getDoc(scopeFor(WS_A), store, { doc_id: id });
  const b = await getDoc(scopeFor(WS_A), store, { doc_id: id });
  const nonce = (s: string) => /nonce="([0-9a-f]+)"/.exec(s)?.[1];
  assert.notEqual(nonce(a.content), nonce(b.content), 'a reused nonce is a forgeable delimiter');
});

test('cross-tenant and nonexistent get_doc are indistinguishable', async () => {
  const { store, id } = await seeded();

  const crossTenant = await getDoc(scopeFor(WS_B), store, { doc_id: id }).then(
    () => null,
    (e: Error) => e.message,
  );
  const missing = await getDoc(scopeFor(WS_B), store, { doc_id: 'doc-nope' }).then(
    () => null,
    (e: Error) => e.message,
  );

  assert.equal(crossTenant, 'NotFound');
  assert.equal(crossTenant, missing, 'a distinguishable error enumerates doc ids');
});

test('a Grant that excludes the source hides the doc from both tools', async () => {
  const { store, id } = await seeded();
  const narrowed = scopeFor(WS_A, [OTHER_SRC]);

  assert.deepEqual((await searchDocs(narrowed, store, { query: 'idempotent' })).results, []);
  await assert.rejects(
    () => getDoc(narrowed, store, { doc_id: id }),
    (e: Error) => e instanceof ToolError && e.message === 'NotFound',
  );
});

test('tool descriptions contain no interpolated content', () => {
  for (const schema of Object.values(TOOL_SCHEMAS)) {
    assert.ok(!schema.description.includes('${'), 'a description is read by a model as instruction');
    assert.ok(schema.description.length < 400, 'descriptions stay short and fixed');
  }
});

test('the published inputSchema is actually enforced, not decorative', async () => {
  // server.ts uses the low-level request handler, which does not validate arguments against a
  // tool's own schema — so every constraint the schema advertises has to be re-stated here or it
  // is a promise the server does not keep. A non-integer limit previously reached Postgres and
  // came back as InternalError, which tells a caller nothing and makes a driver error reachable
  // from tool input.
  const { store } = await seeded();
  const scope = scopeFor(WS_A);

  for (const bad of [2.5, 0, -1, '10', NaN]) {
    await assert.rejects(
      () => searchDocs(scope, store, { query: 'retry', limit: bad as never }),
      (e: Error) => e.message === 'InvalidInput',
      `limit=${String(bad)} must be InvalidInput, never InternalError`,
    );
  }

  // additionalProperties: false, applied rather than advertised.
  await assert.rejects(
    () => searchDocs(scope, store, { query: 'retry', evil: 1 } as never),
    (e: Error) => e.message === 'InvalidInput',
  );

  // Oversized is CLAMPED, not rejected — the description promises exactly that, and a server that
  // contradicts its own published contract is worse than one that is merely strict.
  const clamped = await searchDocs(scope, store, { query: 'retry', limit: MAX_RESULTS + 500 });
  assert.ok(clamped.results.length <= MAX_RESULTS);

  // And the valid boundaries still work.
  assert.ok(await searchDocs(scope, store, { query: 'retry', limit: 1 }));
  assert.ok(await searchDocs(scope, store, { query: 'retry', limit: MAX_RESULTS }));
});
