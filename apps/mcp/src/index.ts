#!/usr/bin/env node
/**
 * Strata MCP server — stdio entrypoint.
 *
 * Read-only by decision (D5): search_docs, get_doc, list_sources. The tool surface and its
 * security properties live in ./tools.ts; ./server.ts is the SDK wiring. This file does nothing but
 * connect a real database and a stdio transport.
 *
 * Run:  DATABASE_URL=... STRATA_AGENT_TOKEN=... node apps/mcp/src/index.ts
 *
 * The caller is authenticated (ADR 0006 increment 1). `STRATA_AGENT_TOKEN` names a principal, its
 * workspace, and its grant; the scope is verified per tool call, so revoking the token or the agent
 * takes effect on the next call with nothing to invalidate.
 *
 * WHAT THAT DOES AND DOES NOT BUY, over stdio. It buys attribution (this agent, not "somebody"),
 * per-agent narrowing, and revocation. It does NOT buy confidentiality: this process reads
 * DATABASE_URL from the repo's .env — deliberately, so no client config holds a secret — which means
 * anything that can launch it can also connect to Postgres directly and bypass every check here.
 * Containment arrives with remote transport, where the server holds the credential and the client
 * does not. Saying otherwise would stop the next reader from looking.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAuthenticator } from '@strata/auth';
import {
  createAccessLog,
  createAuthStore,
  createDocStore,
  createSourceStore,
  fromPoolLike,
  loadDotEnv,
  requireConnectionString,
} from '@strata/storage';
import { createStrataServer } from './server.ts';

// An MCP client launches this process with a minimal environment, so the repo's .env is the only
// place credentials can come from. This is why the client config needs no secrets in it.
loadDotEnv(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));

const connectionString = requireConnectionString(process.env);

// No anonymous fallback, and no STRATA_WORKSPACE_ID here any more: the workspace comes from the
// token. Keeping both would be two sources of truth that can disagree, and the one that loses is
// always the one the operator was looking at.
const agentToken = process.env['STRATA_AGENT_TOKEN'];
if (!agentToken) {
  throw new Error(
    'STRATA_AGENT_TOKEN is not set. There is no default and no anonymous mode: a server that ' +
      'silently picks a principal is a server that silently serves the wrong one. Create one with ' +
      '`npm run agent:create -- "<name>"`.',
  );
}

const pool = new pg.Pool({ connectionString, max: 4 });
const db = fromPoolLike(pool);
const auth = createAuthenticator(createAuthStore(db));

const server = createStrataServer({
  docs: createDocStore(db),
  sources: createSourceStore(db),
  // ADR 0005 section 5. Fire-and-forget inside the server, so a logging outage is a missing row
  // rather than a dead tool surface.
  log: createAccessLog(db),
  // Verified per call, never captured. Over stdio the token is fixed for the process lifetime, but
  // the *scope* is not: re-resolving is what makes revocation immediate rather than
  // effective-next-restart, and it is the same code path a remote transport will use per request.
  scope: () => auth.scopeFromAgentToken(agentToken),
});

await server.connect(new StdioServerTransport());

// stdout is the MCP transport. Anything written there that is not a protocol message corrupts the
// stream, so diagnostics go to stderr.
process.stderr.write('strata mcp server ready (read-only)\n');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void pool.end().finally(() => process.exit(0));
  });
}
