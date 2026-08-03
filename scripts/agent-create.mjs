#!/usr/bin/env node
// Creates an agent principal, its grant, and its first token.
//
//   npm run agent:create -- "Claude Code — my laptop"
//   npm run agent:create -- "Read-only bot" --sources src-markdown
//   npm run agent:create -- "Locked out" --sources ''      # deny-all, for testing the gate
//
// The token is printed ONCE and cannot be recovered. It is never written to a file by this script:
// putting a live credential into .env is your decision to make, not a side effect of running a
// command. Copy it yourself.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createAuthStore,
  fromPoolLike,
  loadDotEnv,
  migrate,
  requireConnectionString,
} from '@strata/storage';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(ROOT);

const args = process.argv.slice(2);
const displayName = args.find((a) => !a.startsWith('--'));
if (!displayName) {
  console.error('Usage: npm run agent:create -- "<display name>" [--sources a,b] [--kind agent|service]');
  process.exit(1);
}

const workspaceId = process.env['STRATA_WORKSPACE_ID'];
if (!workspaceId) {
  console.error('STRATA_WORKSPACE_ID is not set. See docs/SETUP.md.');
  process.exit(1);
}

const kindFlag = args.indexOf('--kind');
const kind = kindFlag === -1 ? 'agent' : args[kindFlag + 1];
if (!['agent', 'service', 'user'].includes(kind)) {
  console.error(`--kind must be agent, service, or user (got "${kind}")`);
  process.exit(1);
}

// Absent flag  -> undefined -> every source in the workspace.
// --sources ''  -> []       -> deny-all. These are different, deliberately (ADR 0006 §3).
const sourcesFlag = args.indexOf('--sources');
const sourceIds =
  sourcesFlag === -1
    ? undefined
    : (args[sourcesFlag + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 2 });
const db = fromPoolLike(pool);
await migrate(db);

const { principalId, presented } = await createAuthStore(db).createAgent({
  workspaceId,
  displayName,
  kind,
  ...(sourceIds === undefined ? {} : { sourceIds }),
});

const reach =
  sourceIds === undefined
    ? 'every source in the workspace'
    : sourceIds.length === 0
      ? 'NOTHING (deny-all grant)'
      : sourceIds.join(', ');

console.log(`\nCreated ${kind} principal ${principalId}`);
console.log(`  name      ${displayName}`);
console.log(`  workspace ${workspaceId}`);
console.log(`  can reach ${reach}`);
console.log(`\n  STRATA_AGENT_TOKEN=${presented}\n`);
console.log('Shown once — the secret is not stored and cannot be recovered.');
console.log('Add the line above to .env, then restart any MCP client.');
console.log('To revoke: UPDATE agent_tokens SET revoked_at = now() WHERE principal_id =');
console.log(`  '${principalId}';   -- takes effect on the next call, no restart needed.`);

await pool.end();
