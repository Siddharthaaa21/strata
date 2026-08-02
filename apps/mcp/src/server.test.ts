/**
 * End-to-end MCP test: a real SDK Client talks to the real Strata Server over a linked in-memory
 * transport, backed by real PostgreSQL (PGlite).
 *
 * This is M6's "a real MCP client can search and read the vault" made checkable without a hosted
 * database. Nothing here is stubbed except the network hop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
import { createDocStore, createSourceStore, migrate, type SqlDriver } from '@strata/storage';
import { createStrataServer } from './server.ts';

const WS = 'ws-alpha' as WorkspaceId;
const OTHER_WS = 'ws-beta' as WorkspaceId;
const SRC = 'src-claude' as SourceId;
const HIDDEN_SRC = 'src-github' as SourceId;

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

/** Boots a real client/server pair over PGlite and returns both, plus the seeded doc id. */
async function connected(sourceIds?: readonly SourceId[]) {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const docs = createDocStore(db);
  const sources = createSourceStore(db);
  const seedScope = scopeFor(WS);

  await sources.upsert(seedScope, {
    id: SRC,
    kind: 'claude',
    name: 'Claude',
    description: 'Syncs research threads and project docs.',
    status: 'connected',
    credentialRef: 'vault://secret/claude-oauth-token',
  });
  await sources.upsert(seedScope, {
    id: HIDDEN_SRC,
    kind: 'github',
    name: 'GitHub',
    description: 'Indexes READMEs and ADRs.',
    status: 'disconnected',
  });

  const docId = await docs.upsert(seedScope, {
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
    body: 'The ledger service retries failed writes without an idempotency key.',
  });

  // Cross-tenant doc that must never be reachable.
  await docs.upsert(scopeFor(OTHER_WS), {
    id: 'doc-other' as DocId,
    sourceId: SRC,
    externalId: 'a.md',
    contentHash: 'sha256:bbb',
    title: 'Idempotent Retry Strategy',
    excerpt: authored('other tenant'),
    folder: authored('Architecture'),
    tags: authored(['ledger']),
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    body: 'other tenant body',
  });

  const server = createStrataServer({ docs, sources, scope: () => scopeFor(WS, sourceIds) });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, docId };
}

/**
 * The SDK types callTool's return as a union (CallToolResult | CompatibilityCallToolResult), so a
 * structural parameter type is not assignable from it. Takes unknown and narrows here instead.
 */
const payload = (result: unknown) =>
  JSON.parse(
    (result as { content: { text: string }[] }).content[0]!.text,
  ) as Record<string, unknown>;

test('a real MCP client can list the tools', async () => {
  const { client } = await connected();
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['get_doc', 'list_sources', 'search_docs'],
  );
});

test('a real MCP client can search the vault', async () => {
  const { client } = await connected();
  const res = await client.callTool({ name: 'search_docs', arguments: { query: 'idempotent retry' } });
  const body = payload(res);

  assert.equal(body['notice'], FENCE_PREAMBLE);
  const results = body['results'] as { doc_id: string; title: string }[];
  assert.equal(results.length, 1, 'exactly the one doc in this workspace');
  assert.equal(results[0]?.title, 'Idempotent Retry Strategy');
});

test('a real MCP client can read a document, fenced', async () => {
  const { client, docId } = await connected();
  const res = await client.callTool({ name: 'get_doc', arguments: { doc_id: docId } });
  const body = payload(res);

  const content = body['content'] as string;
  assert.ok(content.startsWith(FENCE_PREAMBLE));
  assert.match(content, /<untrusted-document nonce="[0-9a-f]{16}">/);
  assert.ok(content.includes('idempotency key'));
});

test('list_sources returns no credentials and no workspace id', async () => {
  const { client } = await connected();
  const res = await client.callTool({ name: 'list_sources', arguments: {} });
  const raw = (res.content as { text: string }[])[0]!.text;

  assert.ok(!raw.includes('credential'), 'a credentialRef must never cross the wire');
  assert.ok(!raw.includes('vault://'), 'the credential reference value must not appear');
  assert.ok(!raw.includes('workspace'), 'workspaceId is an access-control input, not data');

  const sources = payload(res)['sources'] as { source_id: string }[];
  assert.deepEqual(sources.map((s) => s.source_id).sort(), [SRC, HIDDEN_SRC].sort());
});

test('a narrowed Grant hides a source from list_sources rather than failing the call', async () => {
  const { client } = await connected([SRC]);
  const sources = payload(await client.callTool({ name: 'list_sources', arguments: {} }))[
    'sources'
  ] as { source_id: string }[];

  assert.deepEqual(sources.map((s) => s.source_id), [SRC], 'the excluded source is dropped silently');
});

test('cross-tenant get_doc fails identically to a nonexistent id', async () => {
  const { client } = await connected();

  const crossTenant = await client.callTool({ name: 'get_doc', arguments: { doc_id: 'doc-other' } });
  const missing = await client.callTool({ name: 'get_doc', arguments: { doc_id: 'doc-never' } });

  assert.equal(crossTenant.isError, true);
  assert.equal(missing.isError, true);
  assert.equal(
    (crossTenant.content as { text: string }[])[0]?.text,
    (missing.content as { text: string }[])[0]?.text,
    'a distinguishable error enumerates doc ids across tenants',
  );
});

test('an unexpected failure does not leak internals to the model', async () => {
  const { client } = await connected();
  const res = await client.callTool({ name: 'search_docs', arguments: { query: 42 } });

  assert.equal(res.isError, true);
  const text = (res.content as { text: string }[])[0]!.text;
  assert.equal(text, 'InvalidInput');
  assert.ok(!text.includes('SELECT') && !text.includes('docs'), 'no SQL or schema names');
});

test('an unknown tool name is rejected', async () => {
  const { client } = await connected();
  const res = await client.callTool({ name: 'delete_doc', arguments: {} });
  assert.equal(res.isError, true);
  assert.equal((res.content as { text: string }[])[0]?.text, 'UnknownTool');
});
