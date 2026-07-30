#!/usr/bin/env node
/**
 * Strata MCP server — stdio entrypoint.
 *
 * Read-only by decision (D5): search_docs, get_doc, list_sources. The tool surface and its
 * security properties live in ./tools.ts; ./server.ts is the SDK wiring. This file does nothing but
 * connect a real database and a stdio transport.
 *
 * Run:  DATABASE_URL=... STRATA_WORKSPACE_ID=... node apps/mcp/src/index.ts
 *
 * TEMPORARY — the scope below is a single fixed workspace read from STRATA_WORKSPACE_ID. There is
 * no authentication yet (R7 / M7): anything that can start this process gets that workspace. That
 * is acceptable for local single-user use and is NOT acceptable for a shared or hosted deployment.
 * Replacing this with a per-connection authenticated principal is the M7 Agent Access work.
 */

import pg from 'pg';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { localDevScope } from '@strata/auth';
import type { WorkspaceId } from '@strata/core';
import {
  createDocStore,
  createSourceStore,
  fromPoolLike,
  requireConnectionString,
} from '@strata/storage';
import { createStrataServer } from './server.ts';

const connectionString = requireConnectionString(process.env);

const workspaceId = process.env['STRATA_WORKSPACE_ID'] as WorkspaceId | undefined;
if (!workspaceId) {
  throw new Error(
    'STRATA_WORKSPACE_ID is not set. There is no default: a server that silently picks a ' +
      'workspace is a server that silently serves the wrong one.',
  );
}

const pool = new pg.Pool({ connectionString, max: 4 });
const db = fromPoolLike(pool);

const server = createStrataServer({
  docs: createDocStore(db),
  sources: createSourceStore(db),
  // Re-resolved per call rather than captured, so this becomes a real auth lookup in M7 without
  // changing the server. A cached Scope is a Grant revocation that never takes effect.
  scope: () => localDevScope({ workspaceId }),
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
