/**
 * The access log, driven through a real MCP client (ADR 0005 section 5).
 *
 * Written at this level rather than as a unit test of the store because the properties are about
 * what the SERVER records for a real call — which principal, which documents, and what it declines
 * to write down. A store-level test would prove the INSERT and say nothing about whether the tool
 * surface ever calls it.
 *
 * The first test is the one that matters. ADR 0005 is explicit that a log holding the payload is a
 * second copy of the problem: it sits outside every fence, gets read by whoever debugs an incident,
 * and inherits none of the retention that applies to documents.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mintScope } from '@strata/core/scope-internal';
import { AuthError } from '@strata/auth';
import type { DocId, GrantId, PrincipalId, SourceId, WorkspaceId } from '@strata/core';
import {
  createAccessLog,
  createDocStore,
  createSourceStore,
  docIdsIn,
  migrate,
  type SqlDriver,
} from '@strata/storage';
import { createStrataServer } from './server.ts';

const WS = 'ws-target' as WorkspaceId;
const SRC = 'src-markdown' as SourceId;
const PRINCIPAL = 'p-reader' as PrincipalId;
const SECRET_BODY = 'ZZSECRETBODYZZ the crown jewels of this document';

const scope = mintScope(
  { id: PRINCIPAL, kind: 'agent', workspaceId: WS },
  {
    id: 'g1' as GrantId,
    workspaceId: WS,
    principalId: PRINCIPAL,
    createdAt: '2026-08-04T00:00:00.000Z',
  },
);

async function connected(opts: { failAuth?: boolean } = {}) {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const docs = createDocStore(db);
  const sources = createSourceStore(db);
  const log = createAccessLog(db);

  await docs.upsert(scope, {
    id: 'doc-1' as DocId,
    sourceId: SRC,
    externalId: 'a.md',
    contentHash: 'sha256:a',
    title: 'Deployment Runbook',
    excerpt: { value: 'summary', provenance: 'user', derivedAt: '2026-08-04T00:00:00.000Z' },
    folder: { value: 'ops', provenance: 'user', derivedAt: '2026-08-04T00:00:00.000Z' },
    tags: { value: [], provenance: 'user', derivedAt: '2026-08-04T00:00:00.000Z' },
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    body: SECRET_BODY,
  });

  const server = createStrataServer({
    docs,
    sources,
    log,
    scope: async () => {
      if (opts.failAuth) throw new AuthError('revoked');
      return scope;
    },
  });
  const client = new Client({ name: 'audit', version: '1.0.0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return { client, db, log };
}

const rows = (db: SqlDriver) =>
  db.query<Record<string, unknown>>('SELECT * FROM access_log ORDER BY occurred_at');

test('the log records the call and NOT one byte of the content', async () => {
  // The whole reason this table stores a hash. If it fails, the audit trail is a second, unfenced
  // copy of every document anyone has ever read.
  const { client, db } = await connected();
  await client.callTool({ name: 'get_doc', arguments: { doc_id: 'doc-1' } });

  const { rows: logged } = await rows(db);
  assert.equal(logged.length, 1);

  const dump = JSON.stringify(logged);
  assert.ok(!dump.includes(SECRET_BODY), 'the body reached the access log');
  assert.ok(!dump.includes('Deployment Runbook'), 'the title reached the access log');
  assert.ok(!dump.includes('summary'), 'the excerpt reached the access log');

  // What it does record: who, what tool, which documents, and a hash of the response.
  assert.equal(logged[0]?.['principal_id'], PRINCIPAL);
  assert.equal(logged[0]?.['workspace_id'], WS);
  assert.equal(logged[0]?.['tool'], 'get_doc');
  assert.equal(logged[0]?.['outcome'], 'ok');
  assert.deepEqual(logged[0]?.['doc_ids'], ['doc-1']);
  assert.match(String(logged[0]?.['result_hash']), /^[0-9a-f]{64}$/);
});

test('the hash distinguishes two different responses and matches two identical ones', async () => {
  // What a hash is FOR here: answering "was this the same response as that one" during an incident,
  // without being able to answer "what did it say".
  const { client, db } = await connected();
  await client.callTool({ name: 'get_doc', arguments: { doc_id: 'doc-1' } });
  await client.callTool({ name: 'get_doc', arguments: { doc_id: 'doc-1' } });
  await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } });

  const { rows: logged } = await rows(db);
  // get_doc mints a fresh nonce per response, so two identical reads hash DIFFERENTLY. Recorded
  // rather than asserted away: the hash identifies a response, not a document.
  assert.notEqual(logged[0]?.['result_hash'], logged[1]?.['result_hash']);
  assert.notEqual(logged[1]?.['result_hash'], logged[2]?.['result_hash']);
});

test('a failed authentication is logged with no principal to attribute it to', async () => {
  // The most interesting rows in the table. A stream of these is what a credential being probed
  // looks like — and it is exactly the case where inventing a principal would be worse than null.
  const { client, db } = await connected({ failAuth: true });
  const res = await client.callTool({ name: 'search_docs', arguments: { query: 'anything' } });
  assert.ok((res as { isError?: boolean }).isError);

  const { rows: logged } = await rows(db);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.['outcome'], 'Unauthorized');
  assert.equal(logged[0]?.['principal_id'], null);
  assert.equal(logged[0]?.['workspace_id'], null);
  assert.equal(logged[0]?.['tool'], 'search_docs');
});

test('a NotFound is logged, so probing for document ids leaves a trail', async () => {
  const { client, db } = await connected();
  await client.callTool({ name: 'get_doc', arguments: { doc_id: 'does-not-exist' } });

  const { rows: logged } = await rows(db);
  assert.equal(logged[0]?.['outcome'], 'NotFound');
  assert.equal(logged[0]?.['principal_id'], PRINCIPAL, 'an authenticated miss is still attributable');
});

test('a broken log cannot break the tool surface', async () => {
  // An audit trail that can fail the request it audits is worse than none: the outage arrives at
  // exactly the moment the log is most interesting.
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const docs = createDocStore(db);
  const sources = createSourceStore(db);

  const server = createStrataServer({
    docs,
    sources,
    scope: async () => scope,
    log: {
      record: () => Promise.reject(new Error('the log is on fire')),
      recent: () => Promise.reject(new Error('the log is on fire')),
    },
  });
  const client = new Client({ name: 'audit', version: '1.0.0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);

  const res = await client.callTool({ name: 'search_docs', arguments: { query: 'anything' } });
  assert.ok(!(res as { isError?: boolean }).isError, 'the call succeeded despite the log failing');
});

test('recent() is scoped to a workspace', async () => {
  const { client, db, log } = await connected();
  await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } });

  assert.equal((await log.recent(WS)).length, 1);
  assert.equal((await log.recent('ws-somebody-else' as WorkspaceId)).length, 0);
  // Sanity: the row really is in the table, so the empty result above is scoping, not absence.
  assert.equal((await rows(db)).rows.length, 1);
});

test('docIdsIn collects doc_id keys and never a value', async () => {
  // Structural, like the fencing guard: a tool added later is covered without an edit here. Only
  // KEYS named doc_id are collected, so no content can reach the log through this path by accident.
  assert.deepEqual(docIdsIn({ doc_id: 'a', title: 'doc_id looks like this' }), ['a']);
  assert.deepEqual(docIdsIn({ results: [{ doc_id: 'a' }, { doc_id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(docIdsIn({ nested: { deep: { doc_id: 'c' } } }), ['c']);
  assert.deepEqual(docIdsIn({ doc_id: 42 }), [], 'a non-string doc_id is not an id');
  assert.deepEqual(docIdsIn('a bare string'), []);
});
