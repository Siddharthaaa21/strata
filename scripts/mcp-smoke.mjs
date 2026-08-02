#!/usr/bin/env node
// Drives the REAL stdio MCP server as a subprocess, against the REAL database.
//
//   npm run mcp:smoke
//
// The in-repo tests use a linked in-memory transport, which proves the handlers but not the
// entrypoint: process spawn, env loading, pool creation, stdio framing, shutdown. This exercises
// exactly the path an MCP client takes.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(ROOT, 'apps/mcp/src/index.ts')],
  cwd: ROOT,
  stderr: 'pipe',
});

const client = new Client({ name: 'strata-smoke', version: '1.0.0' }, { capabilities: {} });

let failures = 0;
const check = async (label, fn) => {
  try {
    console.log(`  OK    ${label} -> ${await fn()}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL  ${label}: ${e.message}`);
  }
};

const text = (r) => r.content?.[0]?.text ?? '';

try {
  await client.connect(transport);
  console.log('Connected to the Strata MCP server over stdio\n');

  await check('tools/list', async () => {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort().join(', ');
  });

  let firstDocId;
  await check('search_docs finds real documents', async () => {
    const res = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'tenancy workspace' },
    });
    const body = JSON.parse(text(res));
    if (!body.results?.length) throw new Error('no results — is the vault empty?');
    firstDocId = body.results[0].doc_id;
    return `${body.results.length} hit(s), top: "${body.results[0].title}"`;
  });

  await check('search results are fenced and carry no bodies', async () => {
    const res = await client.callTool({ name: 'search_docs', arguments: { query: 'tenancy' } });
    const raw = text(res);
    const body = JSON.parse(raw);
    if (!body.notice) throw new Error('missing fence preamble');
    if (raw.includes('workspace_id') || raw.includes('ws-')) throw new Error('workspace id leaked');
    if (body.results.some((r) => 'body' in r || 'content' in r)) throw new Error('body leaked into search');
    return 'notice present, no workspace id, no bodies';
  });

  await check('get_doc returns a nonce-fenced body', async () => {
    const res = await client.callTool({ name: 'get_doc', arguments: { doc_id: firstDocId } });
    const body = JSON.parse(text(res));
    const nonce = /<untrusted-document nonce="([0-9a-f]{16})">/.exec(body.content)?.[1];
    if (!nonce) throw new Error('body was not fenced');
    if (!body.content.includes(`</untrusted-document nonce="${nonce}">`)) {
      throw new Error('fence not closed with the same nonce');
    }
    return `fenced with nonce ${nonce}, ${body.content.length} chars`;
  });

  await check('list_sources exposes no credentials', async () => {
    const raw = text(await client.callTool({ name: 'list_sources', arguments: {} }));
    if (raw.includes('credential') || raw.includes('workspace')) throw new Error('leak');
    return `${JSON.parse(raw).sources.length} source(s), no credentials`;
  });

  await check('an unknown doc id is indistinguishable from a forbidden one', async () => {
    const res = await client.callTool({ name: 'get_doc', arguments: { doc_id: 'does-not-exist' } });
    if (!res.isError || text(res) !== 'NotFound') throw new Error(`got: ${text(res)}`);
    return 'NotFound';
  });

  await check('no mutating tool is exposed', async () => {
    const { tools } = await client.listTools();
    const bad = tools.filter((t) => /create|update|delete|write|sync/.test(t.name));
    if (bad.length) throw new Error(`found ${bad.map((t) => t.name).join(', ')}`);
    return 'read-only surface confirmed';
  });
} finally {
  await client.close().catch(() => {});
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nMCP server verified against the live database.');
