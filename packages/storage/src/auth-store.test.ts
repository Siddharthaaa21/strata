/**
 * Agent-token authentication, end to end against real Postgres (PGlite).
 *
 * Deliberately not a unit test of `createAuthenticator` against a fake store. The properties that
 * matter here are joint: the secret must never reach a column, revocation must take effect on the
 * next call with no cache to invalidate, and a narrowed grant must survive the round trip into a
 * `Scope`. All three are claims about storage and the authenticator together, and a fake store is
 * exactly where a bug would hide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createAuthenticator, mintAgentToken, parseAgentToken, AuthError } from '@strata/auth';
import { scopeFilter, type SourceId, type WorkspaceId } from '@strata/core';
import { createAuthStore, createDocStore, migrate, type SqlDriver } from './index.ts';

const WS = 'ws-alpha' as WorkspaceId;
const SRC = 'src-markdown' as SourceId;

async function fresh() {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const store = createAuthStore(db);
  return { db, store, auth: createAuthenticator(store) };
}

const agent = (over: Partial<Parameters<ReturnType<typeof createAuthStore>['createAgent']>[0]> = {}) => ({
  workspaceId: WS,
  displayName: 'Claude Code — laptop',
  kind: 'agent' as const,
  ...over,
});

test('a minted token authenticates and yields a scope for its own workspace', async () => {
  const { store, auth } = await fresh();
  const { principalId, presented } = await store.createAgent(agent());

  const scope = await auth.scopeFromAgentToken(presented);
  assert.equal(scope.workspaceId, WS);
  assert.equal(scope.principal.id, principalId);
  assert.equal(scope.principal.kind, 'agent');
  assert.equal(scopeFilter(scope).sourceIds, undefined, 'an unnarrowed grant reaches every source');
});

test('the secret is never stored — a database dump is not a set of working credentials', async () => {
  // The single most important property here. If this fails, a backup, a replica, a log, or a
  // support session hands someone every agent's credential.
  const { db, store } = await fresh();
  const { presented } = await store.createAgent(agent());
  const secret = parseAgentToken(presented)!.secret;

  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM agent_tokens');
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(secret), 'the secret appeared in a stored column');
  assert.ok(!dump.includes(presented), 'the full token appeared in a stored column');
  // The public half IS stored — that is what makes verification a primary-key lookup.
  assert.ok(dump.includes(parseAgentToken(presented)!.tokenId));
});

test('a wrong secret is indistinguishable from an unknown token', async () => {
  // Both must be `unknown`. A distinct failure for "right tokenId, wrong secret" would confirm which
  // tokenIds exist — the same enumeration oracle NotFound exists to close for document ids.
  const { store, auth } = await fresh();
  const { presented } = await store.createAgent(agent());
  const { tokenId } = parseAgentToken(presented)!;

  const wrongSecret = await auth
    .scopeFromAgentToken(`stra_at_${tokenId}_${mintAgentToken().presented.split('_').pop()}`)
    .then(() => null, (e: AuthError) => e.kind);
  const noSuchToken = await auth
    .scopeFromAgentToken(mintAgentToken().presented)
    .then(() => null, (e: AuthError) => e.kind);

  assert.equal(wrongSecret, 'unknown');
  assert.equal(noSuchToken, 'unknown');
});

test('malformed input fails without a database round trip', async () => {
  const { auth } = await fresh();
  for (const bad of ['', 'nonsense', 'stra_at_', 'stra_at_xyz_secret', 'stra_at_' + 'a'.repeat(16)]) {
    const kind = await auth.scopeFromAgentToken(bad).then(() => null, (e: AuthError) => e.kind);
    assert.equal(kind, 'malformed', `"${bad}" should be malformed`);
  }
});

test('a secret containing underscores survives parsing', async () => {
  // base64url's alphabet includes '_'. Splitting on every underscore instead of the first would
  // corrupt roughly half of all generated secrets — a bug that reproduces only sometimes.
  const minted = mintAgentToken();
  const parsed = parseAgentToken(minted.presented);
  assert.ok(parsed);
  assert.equal(`stra_at_${parsed.tokenId}_${parsed.secret}`, minted.presented);
});

test('revoking the token kills it on the very next call — there is no cache to wait for', async () => {
  const { db, store, auth } = await fresh();
  const { presented } = await store.createAgent(agent());
  await auth.scopeFromAgentToken(presented);

  await db.query('UPDATE agent_tokens SET revoked_at = now()');

  const kind = await auth.scopeFromAgentToken(presented).then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'revoked', 'the Agent Access screen promises immediate; this is that promise');
});

test('revoking the principal kills every token it owns', async () => {
  const { db, store, auth } = await fresh();
  const { presented } = await store.createAgent(agent());

  await db.query('UPDATE principals SET revoked_at = now()');
  const kind = await auth.scopeFromAgentToken(presented).then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'revoked');
});

test('revoking the grant fails as `revoked`, not as an internal error', async () => {
  // Belt and braces on purpose: the lookup returns revoked grants and mintScope refuses them, so the
  // invariant lives in the one function permitted to create authority rather than in a WHERE clause
  // somebody could later "simplify".
  //
  // But mintScope throws a BARE Error, which used to fall through the MCP server's catch to
  // `InternalError` — so the third revocation lever behaved differently from the other two. That
  // both leaked a distinction ("every failure collapses to one word" was false) and showed an
  // operator who had just revoked a grant the message the server emits for bugs.
  const { db, store, auth } = await fresh();
  const { presented } = await store.createAgent(agent());

  await db.query('UPDATE grants SET revoked_at = now()');
  const kind = await auth.scopeFromAgentToken(presented).then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'revoked');
});

test('all three revocation levers are indistinguishable to the caller', async () => {
  // Token, principal, and grant. The wire message must be identical for all three; only our own
  // logs get to know which one fired.
  const levers = [
    'UPDATE agent_tokens SET revoked_at = now()',
    'UPDATE principals SET revoked_at = now()',
    'UPDATE grants SET revoked_at = now()',
  ];

  for (const sql of levers) {
    const { db, store, auth } = await fresh();
    const { presented } = await store.createAgent(agent());
    await db.query(sql);

    const err = await auth.scopeFromAgentToken(presented).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof AuthError, `${sql} produced ${(err as Error)?.name}, not an AuthError`);
    assert.equal((err as AuthError).kind, 'revoked');
  }
});

test('an expired token is rejected, and the clock is injected', async () => {
  const { db, store } = await fresh();
  const { presented } = await store.createAgent(agent());
  await db.query(`UPDATE agent_tokens SET expires_at = '2026-01-01T00:00:00Z'`);

  const before = createAuthenticator(store, () => new Date('2025-12-31T00:00:00Z'));
  const after = createAuthenticator(store, () => new Date('2026-01-02T00:00:00Z'));

  assert.ok(await before.scopeFromAgentToken(presented));
  const kind = await after.scopeFromAgentToken(presented).then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'expired');
});

test('a narrowed grant survives into the Scope, and deny-all stays deny-all', async () => {
  const { store, auth } = await fresh();
  const narrowed = await store.createAgent(agent({ sourceIds: [SRC] }));
  const denyAll = await store.createAgent(agent({ sourceIds: [] }));

  assert.deepEqual(scopeFilter(await auth.scopeFromAgentToken(narrowed.presented)).sourceIds, [SRC]);
  // The distinction NULL-vs-'{}' has to survive Postgres, the driver, and the row mapping. Flatten
  // it anywhere and deny-all silently becomes allow-all.
  assert.deepEqual(scopeFilter(await auth.scopeFromAgentToken(denyAll.presented)).sourceIds, []);
});

test('a token authenticates only its own workspace, and the scope actually filters', async () => {
  const { db, store, auth } = await fresh();
  const mine = await store.createAgent(agent());
  const theirs = await store.createAgent(agent({ workspaceId: 'ws-beta' as WorkspaceId }));

  const docs = createDocStore(db);
  await docs.upsert(await auth.scopeFromAgentToken(mine.presented), {
    id: 'doc-1' as never,
    sourceId: SRC,
    externalId: 'a.md',
    contentHash: 'sha256:a',
    title: 'Alpha workspace document',
    excerpt: { value: 'x', provenance: 'user', derivedAt: '2026-08-02T00:00:00.000Z' },
    folder: { value: 'f', provenance: 'user', derivedAt: '2026-08-02T00:00:00.000Z' },
    tags: { value: [], provenance: 'user', derivedAt: '2026-08-02T00:00:00.000Z' },
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    body: 'body',
  });

  const otherScope = await auth.scopeFromAgentToken(theirs.presented);
  assert.equal(otherScope.workspaceId, 'ws-beta');
  assert.equal((await docs.list(otherScope)).length, 0, 'a valid credential is still only its own workspace');
});

test('one principal cannot hold two active grants', async () => {
  // Enforced by a partial unique index rather than application discipline: two active grants would
  // need a union at mint time, and union is the one operation that can widen a Grant.
  const { db, store } = await fresh();
  const { principalId } = await store.createAgent(agent());

  await assert.rejects(() =>
    db.query(
      `INSERT INTO grants (workspace_id, id, principal_id, source_ids, created_at)
       VALUES ($1,$2,$3,NULL,now())`,
      [WS, 'second-grant', principalId],
    ),
  );
});

test('use is recorded, and rate-limited rather than written per call', async () => {
  const { db, store, auth } = await fresh();
  const { presented } = await store.createAgent(agent());

  await auth.scopeFromAgentToken(presented);
  // touchToken is fire-and-forget by design — the write must never fail the request it records —
  // so settle the microtask queue before reading it back.
  await new Promise((r) => setTimeout(r, 50));

  const first = await db.query<{ last_used_at: string | null }>('SELECT last_used_at FROM agent_tokens');
  assert.ok(first.rows[0]?.last_used_at, 'first use is recorded');

  await auth.scopeFromAgentToken(presented);
  await new Promise((r) => setTimeout(r, 50));
  const second = await db.query<{ last_used_at: string | null }>('SELECT last_used_at FROM agent_tokens');
  assert.deepEqual(
    new Date(second.rows[0]!.last_used_at!).getTime(),
    new Date(first.rows[0]!.last_used_at!).getTime(),
    'a second call inside the interval must not rewrite the row',
  );
});

test('creating an agent is atomic — no principal without a grant and a token', async () => {
  const { db, store } = await fresh();
  await store.createAgent(agent());

  const counts = await Promise.all(
    ['principals', 'grants', 'agent_tokens'].map((t) =>
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`),
    ),
  );
  assert.deepEqual(counts.map((c) => c.rows[0]?.n), [1, 1, 1]);
});

test('a token cannot point at another principal grant — the database refuses the row', async () => {
  // This was a privilege-escalation primitive. The token row and the grant row each carry a
  // principal_id, and mintScope exists partly to check they agree — but lookupToken built the Grant
  // with the TOKEN's value, so the check compared a value with itself and could never fire. A token
  // for a narrowed principal, re-pointed at an unnarrowed grant, reached the whole workspace.
  //
  // The write is one an operator is led toward: grants_one_active forces revoke-then-insert to
  // re-scope an agent, which leaves grant_id pointing at a revoked row, and the obvious manual fix
  // is to repoint it. So detection was not enough — the row is now unwritable.
  const { db, store } = await fresh();
  const narrowed = await store.createAgent(agent({ sourceIds: [SRC] }));
  const unnarrowed = await store.createAgent(agent({ displayName: 'wide open' }));

  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM grants WHERE principal_id = $1',
    [unnarrowed.principalId],
  );
  const foreignGrant = rows[0]!.id;

  await assert.rejects(
    () =>
      db.query('UPDATE agent_tokens SET grant_id = $1 WHERE principal_id = $2', [
        foreignGrant,
        narrowed.principalId,
      ]),
    'repointing a token at a foreign grant must violate the composite foreign key',
  );
});

test('the scope carries the GRANT own principal, so mintScope is a live check', async () => {
  // Even with the constraint in place, lookupToken must read g.principal_id rather than
  // t.principal_id — otherwise mintScope's comparison is documentation of a check, not a check.
  const { store, auth } = await fresh();
  const { principalId, presented } = await store.createAgent(agent({ sourceIds: [SRC] }));

  const scope = await auth.scopeFromAgentToken(presented);
  assert.equal(scope.grant.principalId, principalId, 'the grant names the principal it belongs to');
  assert.equal(scope.principal.id, principalId);
  assert.deepEqual([...(scope.grant.sourceIds ?? [])], [SRC], 'and the narrowing is the grant own');
});

test('an unrepresentable expiry fails closed as Unauthorized, not InternalError', async () => {
  // Postgres has infinity and -infinity. new Date(±Infinity).toISOString() throws a RangeError,
  // which escaped lookupToken as neither AuthError nor ToolError and surfaced as InternalError —
  // a credential-rejection path that did not collapse to one word, which is the property this
  // layer claims. Unparseable is treated as expired: a value we cannot read is not evidence of
  // validity.
  const { db, store, auth } = await fresh();
  const { presented } = await store.createAgent(agent());
  await db.query("UPDATE agent_tokens SET expires_at = 'infinity'");

  const kind = await auth.scopeFromAgentToken(presented).then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'expired');
});

// --- membership: the gate that makes "a few teammates" safe -----------------------------------

const claims = (email: string, subject = 'sub-1', provider = 'supabase') => ({
  provider,
  subject,
  email,
});

test('an authenticated stranger is still a stranger', async () => {
  // The provider will happily sign in anyone with a Google account. Membership decides whether that
  // person gets a workspace, and that decision is ours, not the provider's.
  const { auth } = await fresh();
  const kind = await auth
    .scopeFromSession(claims('nobody@example.com'))
    .then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'no-membership');
});

test('an allowlisted address gets a principal on first sign-in, and the same one after', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  const first = await auth.scopeFromSession(claims('priya@example.com'));
  assert.equal(first.workspaceId, WS);
  assert.equal(first.principal.kind, 'user');
  assert.equal(scopeFilter(first).sourceIds, undefined, 'a member reaches the whole workspace');

  const second = await auth.scopeFromSession(claims('priya@example.com'));
  assert.equal(second.principal.id, first.principal.id, 'a second sign-in must not mint a second account');
});

test('the provider subject is never the PrincipalId', async () => {
  // ADR 0006 §5 rule 1. Using the provider's id directly would make a provider change rewrite every
  // foreign key and every access-log row instead of one table.
  const { db, store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const scope = await auth.scopeFromSession(claims('priya@example.com', 'google-oauth2|1234567890'));

  assert.notEqual(scope.principal.id, 'google-oauth2|1234567890');
  const { rows } = await db.query<{ principal_id: string; subject: string }>(
    'SELECT principal_id, subject FROM user_identities',
  );
  assert.equal(rows[0]?.subject, 'google-oauth2|1234567890', 'the subject is recorded');
  assert.equal(rows[0]?.principal_id, scope.principal.id, 'and linked, not used as the id');
});

test('email matching ignores case and surrounding whitespace', async () => {
  // An allowlist that misses on capitalisation locks out exactly the person it was written for.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: '  Priya@Example.COM ' });

  const scope = await auth.scopeFromSession(claims('priya@example.com'));
  assert.equal(scope.workspaceId, WS);
});

test('removing a member kills their agent tokens in the same breath', async () => {
  // A membership revoked while its tokens keep working is not revoked — the person stops using the
  // web app and keeps their MCP access, which is the worse half.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  await auth.scopeFromSession(claims('priya@example.com'));

  // That member creates an agent, as any member may (Membership is flat by ADR 0002).
  const member = await auth.scopeFromSession(claims('priya@example.com'));
  const { presented } = await store.createAgent(
    agent({ displayName: "Priya's laptop", createdBy: member.principal.id }),
  );
  assert.ok(await auth.scopeFromAgentToken(presented), 'the agent works while they are a member');

  await store.removeMember(WS, 'PRIYA@example.com');

  const session = await auth
    .scopeFromSession(claims('priya@example.com'))
    .then(() => null, (e: AuthError) => e.kind);
  assert.equal(session, 'no-membership', 'the person can no longer sign in');

  // The half that actually matters, and that the earlier version of this test did NOT check despite
  // its name: a departing teammate must not keep an MCP token that reads the whole vault.
  const token = await auth
    .scopeFromAgentToken(presented)
    .then(() => 'STILL WORKS', (e: AuthError) => e.kind);
  assert.equal(token, 'revoked', 'their agents die with them');
});

test('two members share one workspace and get separate principals', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'a@example.com' });
  await store.addMember({ workspaceId: WS, email: 'b@example.com' });

  const a = await auth.scopeFromSession(claims('a@example.com', 'sub-a'));
  const b = await auth.scopeFromSession(claims('b@example.com', 'sub-b'));

  assert.notEqual(a.principal.id, b.principal.id);
  assert.equal(a.workspaceId, b.workspaceId, 'one shared workspace — no switcher needed');
});

test('re-inviting a removed member restores access', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const before = await auth.scopeFromSession(claims('priya@example.com'));
  await store.removeMember(WS, 'priya@example.com');

  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  // Remove-then-re-add must round trip. Restoring the membership row alone left the principal
  // revoked, so a returning member hit Unauthorized while the operator saw them listed as a member
  // — an asymmetry that is invisible from both sides.
  const restored = await auth.scopeFromSession(claims('priya@example.com'));
  assert.equal(restored.workspaceId, WS);
  assert.equal(restored.principal.id, before.principal.id, 'and it is the same account, not a new one');
});

test('re-inviting does NOT reanimate revoked agent tokens', async () => {
  // Deliberate asymmetry, and the opposite one to the bug above: a credential that was revoked
  // should need a deliberate re-issue. Silently bringing one back because someone was re-invited is
  // the opposite of what revocation means.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const member = await auth.scopeFromSession(claims('priya@example.com'));
  const { presented } = await store.createAgent(agent({ createdBy: member.principal.id }));

  await store.removeMember(WS, 'priya@example.com');
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  assert.ok(await auth.scopeFromSession(claims('priya@example.com')), 'the person is back');
  const tokenKind = await auth
    .scopeFromAgentToken(presented)
    .then(() => null, (e: AuthError) => e.kind);
  assert.equal(tokenKind, 'revoked', 'their old agent token is not silently reanimated');
});

test('listMembers shows the allowlist including who has not signed in yet', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'joined@example.com' });
  await store.addMember({ workspaceId: WS, email: 'pending@example.com' });
  await auth.scopeFromSession(claims('joined@example.com'));

  const members = await store.listMembers(WS);
  assert.equal(members.length, 2);
  assert.ok(members.find((m) => m.email === 'joined@example.com')?.joinedAt);
  assert.equal(members.find((m) => m.email === 'pending@example.com')?.joinedAt, undefined);
});

test('malformed claims are rejected without a database round trip', async () => {
  const { auth } = await fresh();
  for (const bad of [
    { provider: 'supabase', subject: 's', email: '' },
    { provider: 'supabase', subject: '', email: 'a@b.c' },
    {} as never,
  ]) {
    const kind = await auth.scopeFromSession(bad as never).then(() => null, (e: AuthError) => e.kind);
    assert.equal(kind, 'malformed');
  }
});
