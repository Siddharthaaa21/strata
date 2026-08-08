#!/usr/bin/env node
// Manages who may sign in to the workspace.
//
//   npm run member -- list
//   npm run member -- add priya@example.com
//   npm run member -- remove priya@example.com
//
// The allowlist is the invite. An address is added here first; the person signs in with the
// identity provider afterwards and their account is created on first success. Nobody who is not on
// this list can sign in, however valid their Google account is.
//
// `remove` also revokes their principal, every agent RECORDED as created by them, and those
// agents' tokens. A teammate who keeps an MCP token after losing the web app has not actually been
// removed.
//
// "Recorded as" is load-bearing: an agent created without `--by` has no owner, and nothing here
// can attribute it after the fact. `remove` reports how many of those exist rather than pretending
// they were handled.

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

const [command, email] = process.argv.slice(2);
const workspaceId = process.env['STRATA_WORKSPACE_ID'];

if (!workspaceId) {
  console.error('STRATA_WORKSPACE_ID is not set. See docs/SETUP.md.');
  process.exit(1);
}
if (!['list', 'add', 'remove'].includes(command ?? '')) {
  console.error('Usage: npm run member -- <list|add|remove> [email]');
  process.exit(1);
}
if (command !== 'list' && !email) {
  console.error(`Usage: npm run member -- ${command} <email>`);
  process.exit(1);
}
// Not validation of deliverability — just enough to catch a typo'd argument before it becomes a
// row nobody can sign in as.
if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`"${email}" does not look like an email address.`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: requireConnectionString(process.env), max: 2 });
const db = fromPoolLike(pool);
await migrate(db);
const store = createAuthStore(db);

if (command === 'add') {
  await store.addMember({ workspaceId, email });
  console.log(`\n${email} may now sign in to ${workspaceId}.`);
  console.log('Their account is created the first time they do — nothing to send them but the URL.');
} else if (command === 'remove') {
  // Report what happened, not what is supposed to happen. This printed "their agents and agent
  // tokens are revoked too" unconditionally, including when it had revoked nothing at all — every
  // agent made by `agent:create` had a NULL created_by and matched none of them. An operator
  // reading a confident message stops looking, which is the worst possible outcome for a line
  // about revocation.
  const report = await store.removeMember(workspaceId, email);
  console.log(`\n${email} can no longer sign in to ${workspaceId}.`);
  console.log(
    `Revoked ${report.principalsRevoked} principal(s) and ${report.tokensRevoked} agent token(s), ` +
      'effective on the next call.',
  );
  console.log('Re-adding them restores access; their old agent tokens stay revoked.');

  if (report.unattributedAgents > 0) {
    console.log(
      `\n! ${report.unattributedAgents} live agent(s) in this workspace have no recorded creator,`,
    );
    console.log('  so no removal can sweep them up — including this one. If any belonged to');
    console.log(`  ${email}, revoke it by hand:`);
    console.log('    SELECT id, display_name FROM principals');
    console.log(`     WHERE workspace_id = '${workspaceId}' AND created_by IS NULL`);
    console.log("       AND kind <> 'user' AND revoked_at IS NULL;");
    console.log('  Create future agents with `--by <email>` so this stops happening.');
  }
}

const members = await store.listMembers(workspaceId);
if (members.length === 0) {
  console.log(`\nNo members in ${workspaceId}.`);
} else {
  console.log(`\nMembers of ${workspaceId}:\n`);
  for (const m of members) {
    const state = m.revokedAt ? 'removed' : m.joinedAt ? 'active' : 'invited, not signed in yet';
    console.log(`  ${m.email.padEnd(34)} ${state}`);
  }
}

await pool.end();
