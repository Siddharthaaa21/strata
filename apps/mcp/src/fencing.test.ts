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

  const server = createStrataServer({ docs, sources, scope: async () => scope });
  const client = new Client({ name: 'fencing', version: '1.0.0' }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const parse = (r: unknown) => JSON.parse(text(r)) as Record<string, unknown>;

/**
 * EVERY payload a tool result can carry, not just the first one.
 *
 * Three separate holes lived in the previous single-payload version, and a reviewer walked a tool
 * through each of them:
 *
 *   - `content[0]` only, so a tool putting raw metadata in `content[1]` was invisible.
 *   - `structuredContent` (MCP 2025-06-18) never inspected at all.
 *   - non-JSON entries silently skipped, so a plain-text leak read as "nothing to check".
 *
 * A guard that inspects one of three channels is not a guard, and the header of this file claims it
 * catches any future tool. That claim only becomes true here.
 */
const NONCE_OPEN = /<untrusted-document nonce="([0-9a-f]{16})">/;

/**
 * Is EVERY occurrence of `marker` inside a matched nonce envelope?
 *
 * The previous version asked only whether an envelope existed *somewhere* in the string, which is a
 * different question and a much weaker one. A tool returning
 * `"Title: <title>\nFolder: <folder>\n" + fence(body)` satisfied it while leaking two fields in
 * plain text above the envelope — the exact shape the guard was written to stop, re-opened by
 * appending a correctly-fenced body after it.
 */
function everyOccurrenceIsFenced(value: string, marker: string): boolean {
  const match = NONCE_OPEN.exec(value);
  if (match === null) return false;

  const openAt = value.indexOf(match[0]) + match[0].length;
  const closeAt = value.indexOf(`</untrusted-document nonce="${match[1]}">`);
  if (closeAt < 0) return false;

  for (let i = value.indexOf(marker); i !== -1; i = value.indexOf(marker, i + 1)) {
    if (i < openAt || i >= closeAt) return false;
  }
  return true;
}

/**
 * Every string in a payload, labelled with its nearest object key.
 *
 * Array elements inherit the array's key rather than an index, so a marker inside `tags` reports as
 * `tags` — which is what `untrustedFields` names.
 */
function stringLeaves(v: unknown, key = '', out: { key: string; value: string }[] = []) {
  if (typeof v === 'string') {
    // A string that parses as JSON is a CONTAINER, not a leaf. Tools serialize their payload into
    // `content[].text`, so the raw string legitimately contains every field — checking it as a leaf
    // would report the whole response as leaking under the key "text". Its contents are the
    // channels; recurse into them and drop the wrapper.
    const trimmed = v.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        stringLeaves(JSON.parse(trimmed), key, out);
        return out;
      } catch {
        /* not JSON after all — fall through and treat it as a leaf */
      }
    }
    out.push({ key, value: v });
  } else if (Array.isArray(v)) {
    for (const x of v) stringLeaves(x, key, out);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      // KEYS are a channel too. A tool returning `{"<title>": 1}` puts ingested content in the key
      // position, where a values-only walk never looks.
      out.push({ key: k, value: k });
      stringLeaves(x, k, out);
    }
  }
  return out;
}

// One marker per content-derived channel. Distinct so a failure names the channel that leaked.
const M = {
  path: 'ZQPATHQZ',
  title: 'ZQTITLEQZ',
  excerpt: 'ZQEXCERPTQZ',
  folder: 'ZQFOLDERQZ',
  tag: 'ZQTAGQZ',
  body: 'ZQBODYQZ',
};

const LOADED = {
  // The filename carries a marker too: external_id is attacker-supplied and a tool returning
  // it would leak a path the marker sweep previously could not see.
  'loaded-ZQPATHQZ.md': [
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

/**
 * The invariant is "no ingested content in an undeclared field", so a response carrying no ingested
 * content satisfies it trivially. `list_sources` returns operator config — connector name, kind,
 * status — none of it ingested, and demanding an `untrustedFields` on a payload with nothing
 * untrusted in it would teach a reader the field is boilerplate.
 *
 * The gap that leaves, recorded because this suite cannot see it: if a connector ever writes a
 * REMOTE-supplied source name, `list_sources` becomes a content channel with no fence and no marker
 * planted here to catch it. That is an M5 problem — no connector exists yet — and it belongs in the
 * risk register rather than behind an assertion that would pass today for the wrong reason.
 */
/**
 * Applies the invariant to the ENTIRE result object.
 *
 * Not to an enumerated set of channels. The previous version listed `content[].text` and
 * `structuredContent`, and a reviewer walked four tool shapes through the gaps: an embedded
 * `resource` block (no top-level `.text`, so it was skipped), a `resource_link`, `_meta`, and
 * content placed in JSON *keys*.
 *
 * Listing channels is the same mistake as listing Unicode carriers, one layer up — and it failed
 * the same way, twice. The result is one object; walk all of it. A channel invented by a future MCP
 * revision is covered without an edit here, which is the only version of this claim worth making.
 *
 * `untrustedFields` is read from wherever it appears, since the declaration and the data it
 * describes travel together in whichever payload carries them.
 */
function assertResultIsClean(res: unknown, where: string) {
  const leaves = stringLeaves(res);
  assert.ok(leaves.length > 0, `${where}: returned no inspectable payload`);

  // Only names appearing inside an actual `untrustedFields` array count as declared — a field is
  // not excused by a string that merely happens to equal its name.
  const declared = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'untrustedFields' && Array.isArray(x)) {
          for (const name of x) if (typeof name === 'string') declared.add(name);
        } else {
          walk(x);
        }
      }
    } else if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          walk(JSON.parse(t));
        } catch {
          /* not JSON */
        }
      }
    }
  };
  walk(res);

  for (const leaf of leaves) {
    if (leaf.key === 'untrustedFields') continue;
    for (const marker of Object.values(M)) {
      if (!leaf.value.includes(marker)) continue;
      const fencedBody = leaf.key === 'content' && everyOccurrenceIsFenced(leaf.value, marker);
      assert.ok(
        declared.has(leaf.key) || fencedBody,
        `${where}: ingested content (${marker}) surfaced in "${leaf.key}", which is neither ` +
          `declared untrusted (${[...declared].join(', ') || 'nothing declared'}) nor inside a ` +
          `nonce envelope`,
      );
    }
  }
}

/**
 * Calls EVERY tool the server advertises, not a hardcoded list.
 *
 * This is the difference between a suite that generalizes and one that only appears to. The first
 * version of this file named `search_docs` and `get_doc` directly; a reviewer added a fourth tool
 * that returned the raw body, title, folder and tags with no fencing at all, and the suite passed
 * 5/5. A guard that cannot see a new tool cannot protect against one.
 *
 * Arguments are derived from each tool's own `inputSchema`, so a tool added tomorrow is exercised
 * without editing this file — which is the only version of the claim worth making.
 */
async function callEveryTool(client: Client, docId: string) {
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0, 'the server advertises at least one tool');

  const out: { name: string; res: unknown }[] = [];
  for (const tool of tools) {
    const props = (tool.inputSchema?.['properties'] ?? {}) as Record<string, unknown>;
    const args: Record<string, unknown> = {};
    // Values chosen to actually reach the planted document — a tool called with arguments that
    // return nothing would pass this suite while proving nothing.
    if ('query' in props) args['query'] = 'runbook';
    if ('doc_id' in props) args['doc_id'] = docId;

    const res = await client.callTool({ name: tool.name, arguments: args });
    assert.ok(!(res as { isError?: boolean }).isError, `${tool.name} returned a usable response`);
    out.push({ name: tool.name, res });
  }
  return out;
}

test('no advertised tool surfaces ingested content in an undeclared field', async () => {
  const client = await ingestAndConnect(LOADED);
  const hits = parse(await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } }));
  const docId = (hits['results'] as { doc_id: string }[])[0]!.doc_id;

  const responses = await callEveryTool(client, docId);
  assert.ok(
    responses.some((r) => r.name === 'get_doc') && responses.some((r) => r.name === 'search_docs'),
    'the enumeration actually reached the content-bearing tools',
  );

  for (const { name, res } of responses) {
    assertResultIsClean(res, name);
  }
});

test('get_doc declares the three fields that were leaking', async () => {
  const client = await ingestAndConnect(LOADED);
  const hits = parse(await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } }));
  const docId = (hits['results'] as { doc_id: string }[])[0]!.doc_id;
  const doc = parse(await client.callTool({ name: 'get_doc', arguments: { doc_id: docId } }));

  // The original regression, kept as a named case so a failure says which field came back.
  for (const field of ['title', 'folder', 'tags']) {
    assert.ok(
      (doc['untrustedFields'] as string[]).includes(field),
      `get_doc declares ${field} as untrusted`,
    );
  }
});

test('search_docs finds the planted document at all', async () => {
  const client = await ingestAndConnect(LOADED);
  const res = parse(await client.callTool({ name: 'search_docs', arguments: { query: 'runbook' } }));
  assert.equal((res['results'] as unknown[]).length, 1);
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
