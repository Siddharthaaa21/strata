/**
 * The structural guard on the fence: no MCP response may carry ingested content in a field nobody
 * declared as untrusted.
 *
 * This suite exists because an independent review found `get_doc` returning `title`, `folder`, and
 * `tags` with no preamble and no `untrustedFields`, while the single warning in the response sat
 * *below* them inside the body envelope, saying "the content below". Every metadata test that
 * existed went through `search_docs`, and the one `get_doc` test asserted on `content` alone — so it
 * passed while saying nothing about its four sibling keys.
 *
 * The lesson is that per-field tests only cover the fields somebody thought to name. These tests
 * are written the other way round: plant a marker in every content-derived input, serialize the
 * real response, and demand that EVERY occurrence of a marker is accounted for. A future tool that
 * returns a new ingested field fails here without anyone remembering to add a case.
 *
 * Why a test and not a type: `Untrusted<string>` is `string & {witness}`, which is assignable to
 * `string`. A handler that forgets to fence still compiles. The lint rule bans *constructing* the
 * witness, not *discharging* it, so enforcement has to inspect real output. See ADR 0005.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mintScope } from '@strata/core/scope-internal';
import { FENCE_PREAMBLE, UNTRUSTED_FIELDS } from '@strata/core';
import type { DocId, GrantId, PrincipalId, SourceId, WorkspaceId } from '@strata/core';
import { createDocStore, createSourceStore, migrate, type SqlDriver } from '@strata/storage';
import {
  persistIngest,
  runIngest,
  scanMarkdown,
  storeLookup,
  type FileEntry,
  type FileSystemPort,
  type FileStat,
} from '@strata/ingest';
import { createStrataServer } from './server.ts';

const WS = 'ws-target' as WorkspaceId;
const SRC = 'src-markdown' as SourceId;

const scope = mintScope(
  { id: 'p1' as PrincipalId, kind: 'agent', workspaceId: WS },
  {
    id: 'g1' as GrantId,
    workspaceId: WS,
    principalId: 'p1' as PrincipalId,
    createdAt: '2026-07-29T00:00:00.000Z',
  },
);

function port(files: Record<string, string>): FileSystemPort {
  return {
    async scan(): Promise<readonly FileEntry[]> {
      return Object.keys(files).map((path) => ({ path, isSymlink: false }));
    },
    async stat(_r, path): Promise<FileStat> {
      return {
        size: files[path]!.length,
        modifiedAt: '2026-07-28T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
      };
    },
    async readText(_r, path) {
      return files[path]!;
    },
  };
}

let n = 0;

async function ingestAndConnect(files: Record<string, string>) {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const docs = createDocStore(db);
  const sources = createSourceStore(db);

  const { pending, failures } = await scanMarkdown(port(files), '/vault', SRC);
  await persistIngest(
    scope,
    docs,
    await runIngest({
      scope,
      sourceId: SRC,
      pending,
      failures,
      lookup: storeLookup(scope, docs),
      newId: () => `doc-${++n}` as DocId,
      newEventId: () => `evt-${n}`,
      now: '2026-07-29T00:00:00.000Z',
    }),
  );

  const server = createStrataServer({ docs, sources, scope: () => scope });
  const client = new Client({ name: 'fencing', version: '1.0.0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const parse = (r: unknown) => JSON.parse(text(r)) as Record<string, unknown>;

/**
 * Every string in a payload, labelled with its nearest object key.
 *
 * Array elements inherit the array's key rather than an index, so a marker inside `tags` reports as
 * `tags` — which is what `untrustedFields` names.
 */
function stringLeaves(v: unknown, key = '', out: { key: string; value: string }[] = []) {
  if (typeof v === 'string') out.push({ key, value: v });
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, key, out);
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) stringLeaves(x, k, out);
  }
  return out;
}

// One marker per content-derived channel. Distinct so a failure names the channel that leaked.
const M = {
  title: 'ZQTITLEQZ',
  excerpt: 'ZQEXCERPTQZ',
  folder: 'ZQFOLDERQZ',
  tag: 'ZQTAGQZ',
  body: 'ZQBODYQZ',
};

const LOADED = {
  'loaded.md': [
    '---',
    `title: "Runbook ${M.title}"`,
    `description: "Summary ${M.excerpt}"`,
    `folder: "ops ${M.folder}"`,
    `tags: ["${M.tag}"]`,
    '---',
    '',
    `# Runbook`,
    '',
    `Deployment notes ${M.body} for the cluster.`,
  ].join('\n'),
};

/** The whole point of the suite. Applies to any tool, present or future. */
function assertEveryMarkerIsDeclared(payload: Record<string, unknown>, where: string) {
  const declared = payload['untrustedFields'];
  assert.ok(Array.isArray(declared), `${where}: response declares untrustedFields`);

  const markers = Object.values(M);
  for (const leaf of stringLeaves(payload)) {
    // `untrustedFields` itself lists field NAMES, never values; skip it or it matches its own list.
    if (leaf.key === 'untrustedFields') continue;
    for (const marker of markers) {
      if (!leaf.value.includes(marker)) continue;
      const ok = (declared as string[]).includes(leaf.key) || leaf.key === 'content';
      assert.ok(
        ok,
        `${where}: ingested content (${marker}) surfaced in "${leaf.key}", which is neither ` +
          `declared in untrustedFields (${(declared as string[]).join(', ')}) nor the fenced body`,
      );
    }
  }
}

test('search_docs surfaces no ingested content in an undeclared field', async () => {
  const client = await ingestAndConnect(LOADED);
  const res = parse(await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } }));

  const results = res['results'] as Record<string, unknown>[];
  assert.equal(results.length, 1, 'the planted document is found');
  assertEveryMarkerIsDeclared(res, 'search_docs');
});

test('get_doc surfaces no ingested content in an undeclared field', async () => {
  const client = await ingestAndConnect(LOADED);
  const hits = parse(await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } }));
  const docId = (hits['results'] as { doc_id: string }[])[0]!.doc_id;

  const doc = parse(await client.callTool({ name: 'get_doc', arguments: { doc_id: docId } }));

  // The regression itself: before the fix, title/folder/tags arrived here undeclared.
  assertEveryMarkerIsDeclared(doc, 'get_doc');
  for (const field of ['title', 'folder', 'tags']) {
    assert.ok(
      (doc['untrustedFields'] as string[]).includes(field),
      `get_doc declares ${field} as untrusted`,
    );
  }
});

test('the warning precedes the payload it describes, in key order', async () => {
  const client = await ingestAndConnect(LOADED);
  const hits = parse(await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } }));
  const docId = (hits['results'] as { doc_id: string }[])[0]!.doc_id;

  // Serialized key order is the only thing that makes "read the warning first" true for a reader
  // consuming the response as a stream. The old get_doc put `title` above the only preamble.
  for (const [tool, args] of [
    ['search_docs', { query: 'runbook' }],
    ['get_doc', { doc_id: docId }],
  ] as const) {
    const raw = text(await client.callTool({ name: tool, arguments: args }));
    assert.equal(Object.keys(JSON.parse(raw))[0], 'notice', `${tool}: notice is the first key`);
    assert.ok(raw.indexOf(FENCE_PREAMBLE) < raw.indexOf(M.title), `${tool}: warning precedes content`);
  }
});

test('a declared field list never claims a field the payload does not carry', async () => {
  const client = await ingestAndConnect(LOADED);
  const hits = parse(await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } }));
  const docId = (hits['results'] as { doc_id: string }[])[0]!.doc_id;
  const doc = parse(await client.callTool({ name: 'get_doc', arguments: { doc_id: docId } }));

  // get_doc has no excerpt. Declaring one would teach a reader to discount a field that is not
  // there, and — worse — imply the list is boilerplate rather than computed from the payload.
  assert.ok(!(doc['untrustedFields'] as string[]).includes('excerpt'));
  for (const field of doc['untrustedFields'] as string[]) {
    assert.ok(field in doc, `untrustedFields names "${field}", which the payload carries`);
    assert.ok(
      (UNTRUSTED_FIELDS as readonly string[]).includes(field),
      `"${field}" comes from the shared list, not a hand-written one`,
    );
  }
});

test('an empty result set still carries the notice', async () => {
  const client = await ingestAndConnect(LOADED);
  const res = parse(
    await client.callTool({ name: 'search_docs', arguments: { query: 'nothingmatchesthis' } }),
  );

  assert.equal((res['results'] as unknown[]).length, 0);
  assert.equal(res['notice'], FENCE_PREAMBLE, 'the warning is not conditional on having results');
});
