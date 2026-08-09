/**
 * What the Agent Access screen is allowed to see, and what pressing Revoke actually does.
 *
 * Against real Postgres via PGlite, because both claims are about rows: that no column capable of
 * authenticating leaves the store, and that a revocation reaches the principal AND its tokens in
 * one statement rather than in two that can half-fail.
 *
 * The load-bearing test here is the NULL-versus-empty one. `source_ids` NULL means every source and
 * `'{}'` means none; they are opposites, and a `?? []` anywhere on this path renders the most
 * powerful credential in the workspace as the most harmless. That is not a display bug — it is a
 * screen telling an operator not to bother revoking the thing they most need to revoke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { parseAgentToken } from '@strata/auth';
import type { PrincipalId, SourceId, WorkspaceId } from '@strata/core';
import { createAuthStore, migrate, type SqlDriver } from './index.ts';

const WS = 'ws-alpha' as WorkspaceId;
const OTHER = 'ws-beta' as WorkspaceId;
const SRC = 'src-markdown' as SourceId;
const NOW = '2026-08-09T12:00:00.000Z';

async function fresh() {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  return { db, store: createAuthStore(db) };
}

const agent = (over: Record<string, unknown> = {}) =>
  ({ workspaceId: WS, displayName: 'Claude Code — laptop', kind: 'agent' as const, ...over }) as Parameters<
    ReturnType<typeof createAuthStore>['createAgent']
  >[0];

test('listAgents shows agents and never people', async () => {
  const { db, store } = await fresh();
  await store.createAgent(agent());
  await db.query(
    `INSERT INTO principals (workspace_id, id, kind, display_name, created_at)
     VALUES ($1, 'human-1', 'user', 'Priya', $2)`,
    [WS, NOW],
  );

  const agents = await store.listAgents(WS);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.name, 'Claude Code — laptop');
  assert.ok(!agents.some((a) => a.kind === 'user'), 'a person is not a credential to revoke here');
});

test('an unnarrowed grant and a deny-all grant are never conflated', async () => {
  const { db, store } = await fresh();
  await store.createAgent(agent({ displayName: 'reaches everything' }));
  await store.createAgent(agent({ displayName: 'reaches nothing', sourceIds: [] }));
  await store.createAgent(agent({ displayName: 'reaches one', sourceIds: [SRC] }));

  const by = new Map((await store.listAgents(WS)).map((a) => [a.name, a]));

  // NULL in the column must surface as `undefined`, not `[]`.
  assert.equal(by.get('reaches everything')!.sourceIds, undefined);
  assert.deepEqual(by.get('reaches nothing')!.sourceIds, []);
  assert.deepEqual(by.get('reaches one')!.sourceIds, [SRC]);

  // And the distinction has to survive from the actual column, not from a lucky default: prove the
  // three rows really are stored as NULL, '{}', and a populated array.
  const { rows } = await db.query<{ display_name: string; source_ids: string[] | null }>(
    `SELECT p.display_name, g.source_ids FROM principals p
       JOIN grants g ON g.workspace_id = p.workspace_id AND g.principal_id = p.id
      WHERE p.workspace_id = $1 ORDER BY p.display_name`,
    [WS],
  );
  const stored = new Map(rows.map((r) => [r.display_name, r.source_ids]));
  assert.equal(stored.get('reaches everything'), null);
  assert.deepEqual(stored.get('reaches nothing'), []);
});

test('nothing that could authenticate reaches the screen', async () => {
  const { store } = await fresh();
  const { presented } = await store.createAgent(agent());
  const parsed = parseAgentToken(presented)!;

  const serialised = JSON.stringify(await store.listAgents(WS));
  assert.ok(!serialised.includes(parsed.secret), 'the secret reached the screen payload');
  assert.ok(!serialised.includes(parsed.tokenId), 'the token id reached the screen payload');
  assert.ok(!serialised.includes('token_hash') && !serialised.includes('tokenHash'));
  // last4 is the whole point — it is what an operator matches against the string they were shown
  // once, and it authenticates nothing.
  assert.ok(serialised.includes(presented.slice(-4)));
});

test('listAgents does not reach across workspaces', async () => {
  const { store } = await fresh();
  await store.createAgent(agent({ displayName: 'ours' }));
  await store.createAgent(agent({ workspaceId: OTHER, displayName: 'theirs' }));

  const names = (await store.listAgents(WS)).map((a) => a.name);
  assert.deepEqual(names, ['ours']);
});

test('revoking an agent revokes its tokens too, and says how many', async () => {
  const { store } = await fresh();
  const { principalId } = await store.createAgent(agent());

  const report = await store.revokeAgent(WS, principalId, NOW);
  assert.deepEqual(report, { principalsRevoked: 1, tokensRevoked: 1 });

  const [a] = await store.listAgents(WS);
  assert.ok(a!.revokedAt, 'the agent shows as revoked');
  assert.ok(a!.tokens.every((t) => t.revokedAt !== undefined), 'no token survived the revocation');
});

test('revoking twice reports zero rather than restamping', async () => {
  const { db, store } = await fresh();
  const { principalId } = await store.createAgent(agent());
  await store.revokeAgent(WS, principalId, NOW);

  const again = await store.revokeAgent(WS, principalId, '2026-08-10T00:00:00.000Z');
  assert.deepEqual(again, { principalsRevoked: 0, tokensRevoked: 0 });

  // Idempotent in the column too: "when did this lose access" must survive a second click.
  const { rows } = await db.query<{ revoked_at: Date | string }>(
    'SELECT revoked_at FROM principals WHERE workspace_id = $1 AND id = $2',
    [WS, principalId],
  );
  assert.equal(new Date(rows[0]!.revoked_at).toISOString(), NOW);
});

test('a token that survived an earlier partial revocation is swept on the next attempt', async () => {
  const { db, store } = await fresh();
  const { principalId } = await store.createAgent(agent());

  // The repair case. Revoke the principal alone — the state a crash between two statements would
  // leave, and the reason the token update is NOT gated on the principal update returning a row.
  await db.query('UPDATE principals SET revoked_at = $3 WHERE workspace_id = $1 AND id = $2', [
    WS,
    principalId,
    NOW,
  ]);

  const report = await store.revokeAgent(WS, principalId, NOW);
  assert.equal(report.principalsRevoked, 0, 'the principal was already revoked');
  assert.equal(report.tokensRevoked, 1, 'and the live token was still swept up');
});

test('a person cannot be revoked through the agent endpoint', async () => {
  const { db, store } = await fresh();
  await db.query(
    `INSERT INTO principals (workspace_id, id, kind, display_name, created_at)
     VALUES ($1, 'human-1', 'user', 'Priya', $2)`,
    [WS, NOW],
  );

  // People leave through membership, which also sweeps up the agents they created. A second,
  // partial path to the same thing would skip the membership row and leave the allowlist saying
  // they may still sign in.
  const report = await store.revokeAgent(WS, 'human-1' as PrincipalId, NOW);
  assert.equal(report.principalsRevoked, 0);

  const { rows } = await db.query<{ revoked_at: unknown }>(
    'SELECT revoked_at FROM principals WHERE id = $1',
    ['human-1'],
  );
  assert.equal(rows[0]!.revoked_at, null);
});

test('an agent id from another workspace revokes nothing', async () => {
  const { store } = await fresh();
  const { principalId } = await store.createAgent(agent({ workspaceId: OTHER }));

  // The form field is a selector, never an authorization: the workspace comes from the session.
  const report = await store.revokeAgent(WS, principalId, NOW);
  assert.deepEqual(report, { principalsRevoked: 0, tokensRevoked: 0 });
  assert.equal((await store.listAgents(OTHER))[0]!.revokedAt, undefined);
});
