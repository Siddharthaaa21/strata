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
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createAuthStore,
  fromPoolLike,
  loadDotEnv,
  migrate,
  requireConnectionString,
} from '@strata/storage';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(ROOT);

// The smoke test mints its own throwaway agent rather than borrowing one from .env. Two reasons:
// it runs on a machine that has never created a token, and a test that depends on a long-lived
// credential is a test that quietly stops covering the auth path the day that credential expires.
const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 2 });
const adminDb = fromPoolLike(pool);
await migrate(adminDb);

const authStore = createAuthStore(adminDb);

// A fresh principal per run, named for what it is. It is NOT deleted afterwards — see the cleanup
// at the foot of this file for why that mattered.
const smokeAgent = await authStore.createAgent({
  workspaceId: process.env['STRATA_WORKSPACE_ID'],
  displayName: `mcp:smoke ${new Date().toISOString().slice(0, 10)}`,
  kind: 'service',
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(ROOT, 'apps/mcp/src/index.ts')],
  cwd: ROOT,
  stderr: 'pipe',
  // The server still reads DATABASE_URL from .env itself; only the credential is injected here.
  env: { ...process.env, STRATA_AGENT_TOKEN: smokeAgent.presented },
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
  await check('a revoked token stops working with no restart', async () => {
    // The property the Agent Access screen sells, proven against the live database rather than
    // asserted: revoke, then call again on the SAME connection. There is no cache to invalidate,
    // so the next tool call is already unauthorized.
    await adminDb.query('UPDATE agent_tokens SET revoked_at = now() WHERE token_id = $1', [
      smokeAgent.presented.split('_')[2],
    ]);
    const res = await client.callTool({ name: 'search_docs', arguments: { query: 'tenancy' } });
    if (!res.isError || text(res) !== 'Unauthorized') {
      throw new Error(`expected Unauthorized on the same live connection, got: ${text(res)}`);
    }
    return 'Unauthorized on the next call, same connection';
  });
} finally {
  await client.close().catch(() => {});

  // REVOKED, not deleted. This used to delete the principal, its grant and its tokens outright.
  //
  // The stated reason was that repeated runs would otherwise accumulate dead agents in the Agent
  // Access list. Real concern, wrong fix: it broke an invariant the store states in `removeMember`
  // — *never delete, the access log has to stay attributable*. Every call this test made was logged
  // against a principal id the cleanup then removed, so Recent activity showed a column of
  // `unknown` actors. An audit trail losing attribution retroactively is the one thing it must
  // never do, and the deletion was doing it on every run.
  //
  // What accumulates now is a dated, revoked row per run, in a section of the screen that exists to
  // show exactly that. Honest history reads better than a clean list that quietly erased it.
  await adminDb
    .query('UPDATE agent_tokens SET revoked_at = now() WHERE principal_id = $1 AND revoked_at IS NULL', [
      smokeAgent.principalId,
    ])
    .catch(() => {});
  await adminDb
    .query('UPDATE principals SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
      smokeAgent.principalId,
    ])
    .catch(() => {});
  await pool.end().catch(() => {});
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nMCP server verified against the live database.');
