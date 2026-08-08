#!/usr/bin/env node
// Creates an agent principal, its grant, and its first token.
//
//   npm run agent:create -- "Claude Code — my laptop" --by priya@example.com
//   npm run agent:create -- "Read-only bot" --by priya@example.com --sources src-markdown
//   npm run agent:create -- "Locked out" --by priya@example.com --sources ''   # deny-all
//   npm run agent:create -- "Bootstrap" --unattributed                          # see below
//
// `--by` is REQUIRED, and that is a deliberate change rather than ceremony. `removeMember` sweeps
// up agents by `created_by`, and SQL's `NULL IN (...)` is never true — so every agent this script
// used to create was invisible to removal, while the member CLI printed "their agents and agent
// tokens are revoked too". An agent nobody can attribute is an agent nobody can revoke by removing
// the person who owns it, which is the one moment revocation actually matters.
//
// `--unattributed` still exists for the bootstrap case, where no member has signed in yet and there
// is nobody to attribute to. It says so loudly, because the resulting credential outlives every
// removal.
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
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

// The first bare argument, not merely the first non-flag one: `--by x@y.z "Name"` would otherwise
// take the flag's VALUE as the display name and then create an agent called "x@y.z".
const flagValues = new Set(['--by', '--sources', '--kind'].map(flagValue).filter(Boolean));
const displayName = args.find((a) => !a.startsWith('--') && !flagValues.has(a));

if (!displayName) {
  console.error(
    'Usage: npm run agent:create -- "<display name>" --by <member email>\n' +
      '                            [--sources a,b] [--kind agent|service] [--unattributed]',
  );
  process.exit(1);
}

const byEmail = flagValue('--by');
const unattributed = args.includes('--unattributed');
if (!byEmail && !unattributed) {
  console.error(
    'Refusing to create an agent nobody owns.\n\n' +
      '  --by <member email>   attribute it to a member, so removing them revokes it\n' +
      '  --unattributed        create it anyway (bootstrap only — see below)\n\n' +
      'An agent with no creator is skipped by `npm run member -- remove`, because SQL\n' +
      'NULL IN (...) is never true. It would keep working after the person who made it is\n' +
      'gone, and nothing in the CLI or the UI would show that.',
  );
  process.exit(1);
}
if (byEmail && unattributed) {
  console.error('--by and --unattributed contradict each other. Pick one.');
  process.exit(1);
}

const workspaceId = process.env['STRATA_WORKSPACE_ID'];
if (!workspaceId) {
  console.error('STRATA_WORKSPACE_ID is not set. See docs/SETUP.md.');
  process.exit(1);
}

const kind = flagValue('--kind') ?? 'agent';
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
const store = createAuthStore(db);

// Resolve the owner BEFORE minting anything. A token that exists but is attributed to nobody is
// exactly the state this flag was added to prevent, so failing here has to happen first.
let createdBy;
if (byEmail) {
  const wanted = byEmail.trim().toLowerCase();
  const members = await store.listMembers(workspaceId);
  const owner = members.find((m) => m.email === wanted);

  if (!owner) {
    console.error(`"${byEmail}" is not a member of ${workspaceId}.`);
    console.error('Add them first:  npm run member -- add ' + byEmail);
    await pool.end();
    process.exit(1);
  }
  if (owner.revokedAt) {
    console.error(`"${byEmail}" was removed from ${workspaceId}. An agent owned by a removed`);
    console.error('member would be created already-revoked. Re-add them first.');
    await pool.end();
    process.exit(1);
  }
  if (!owner.principalId) {
    console.error(`"${byEmail}" is invited but has never signed in, so they have no principal yet.`);
    console.error('Have them sign in once, then create the agent.');
    await pool.end();
    process.exit(1);
  }
  createdBy = owner.principalId;
}

const { principalId, presented } = await store.createAgent({
  workspaceId,
  displayName,
  kind,
  ...(sourceIds === undefined ? {} : { sourceIds }),
  ...(createdBy === undefined ? {} : { createdBy }),
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
console.log(`  owned by  ${byEmail ?? 'NOBODY — see the warning below'}`);

if (!byEmail) {
  console.log('\n  ! UNATTRIBUTED. `npm run member -- remove` will never revoke this agent,');
  console.log('    whoever leaves. Revoking it is a manual step you have to remember:');
  console.log(`    UPDATE agent_tokens SET revoked_at = now() WHERE principal_id = '${principalId}';`);
}
console.log(`\n  STRATA_AGENT_TOKEN=${presented}\n`);
console.log('Shown once — the secret is not stored and cannot be recovered.');
console.log('Add the line above to .env, then restart any MCP client.');
console.log('To revoke: UPDATE agent_tokens SET revoked_at = now() WHERE principal_id =');
console.log(`  '${principalId}';   -- takes effect on the next call, no restart needed.`);

await pool.end();
