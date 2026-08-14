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
    .scopeFromSession(WS, claims('nobody@example.com'))
    .then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'no-membership');
});

test('an allowlisted address gets a principal on first sign-in, and the same one after', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  const first = await auth.scopeFromSession(WS, claims('priya@example.com'));
  assert.equal(first.workspaceId, WS);
  assert.equal(first.principal.kind, 'user');
  assert.equal(scopeFilter(first).sourceIds, undefined, 'a member reaches the whole workspace');

  const second = await auth.scopeFromSession(WS, claims('priya@example.com'));
  assert.equal(second.principal.id, first.principal.id, 'a second sign-in must not mint a second account');
});

test('the provider subject is never the PrincipalId', async () => {
  // ADR 0006 §5 rule 1. Using the provider's id directly would make a provider change rewrite every
  // foreign key and every access-log row instead of one table.
  const { db, store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const scope = await auth.scopeFromSession(WS, claims('priya@example.com', 'google-oauth2|1234567890'));

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

  const scope = await auth.scopeFromSession(WS, claims('priya@example.com'));
  assert.equal(scope.workspaceId, WS);
});

test('removing a member kills their agent tokens in the same breath', async () => {
  // A membership revoked while its tokens keep working is not revoked — the person stops using the
  // web app and keeps their MCP access, which is the worse half.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  await auth.scopeFromSession(WS, claims('priya@example.com'));

  // That member creates an agent, as any member may (Membership is flat by ADR 0002).
  const member = await auth.scopeFromSession(WS, claims('priya@example.com'));
  const { presented } = await store.createAgent(
    agent({ displayName: "Priya's laptop", createdBy: member.principal.id }),
  );
  assert.ok(await auth.scopeFromAgentToken(presented), 'the agent works while they are a member');

  await store.removeMember(WS, 'PRIYA@example.com');

  const session = await auth
    .scopeFromSession(WS, claims('priya@example.com'))
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

  const a = await auth.scopeFromSession(WS, claims('a@example.com', 'sub-a'));
  const b = await auth.scopeFromSession(WS, claims('b@example.com', 'sub-b'));

  assert.notEqual(a.principal.id, b.principal.id);
  assert.equal(a.workspaceId, b.workspaceId, 'one shared workspace — no switcher needed');
});

test('re-inviting a removed member restores access', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const before = await auth.scopeFromSession(WS, claims('priya@example.com'));
  await store.removeMember(WS, 'priya@example.com');

  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  // Remove-then-re-add must round trip. Restoring the membership row alone left the principal
  // revoked, so a returning member hit Unauthorized while the operator saw them listed as a member
  // — an asymmetry that is invisible from both sides.
  const restored = await auth.scopeFromSession(WS, claims('priya@example.com'));
  assert.equal(restored.workspaceId, WS);
  assert.equal(restored.principal.id, before.principal.id, 'and it is the same account, not a new one');
});

test('re-inviting does NOT reanimate revoked agent tokens', async () => {
  // Deliberate asymmetry, and the opposite one to the bug above: a credential that was revoked
  // should need a deliberate re-issue. Silently bringing one back because someone was re-invited is
  // the opposite of what revocation means.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const member = await auth.scopeFromSession(WS, claims('priya@example.com'));
  const { presented } = await store.createAgent(agent({ createdBy: member.principal.id }));

  await store.removeMember(WS, 'priya@example.com');
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  assert.ok(await auth.scopeFromSession(WS, claims('priya@example.com')), 'the person is back');
  const tokenKind = await auth
    .scopeFromAgentToken(presented)
    .then(() => null, (e: AuthError) => e.kind);
  assert.equal(tokenKind, 'revoked', 'their old agent token is not silently reanimated');
});

test('listMembers shows the allowlist including who has not signed in yet', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'joined@example.com' });
  await store.addMember({ workspaceId: WS, email: 'pending@example.com' });
  await auth.scopeFromSession(WS, claims('joined@example.com'));

  const members = await store.listMembers(WS);
  assert.equal(members.length, 2);
  assert.ok(members.find((m) => m.email === 'joined@example.com')?.joinedAt);
  assert.equal(members.find((m) => m.email === 'pending@example.com')?.joinedAt, undefined);
});

// --- round-five findings: the session path, which nothing in production reached yet ------------

const WS2 = 'ws-beta' as WorkspaceId;

test('a session resolves in the workspace the caller names, not one the store picks', async () => {
  // The lookup was `WHERE email = $1` with no workspace predicate and no ORDER BY, then took
  // rows[0]. One person in two workspaces landed in whichever the planner happened to return
  // first, and that is free to change between two identical requests.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  await store.addMember({ workspaceId: WS2, email: 'priya@example.com' });

  const a = await auth.scopeFromSession(WS, claims('priya@example.com'));
  const b = await auth.scopeFromSession(WS2, claims('priya@example.com', 'sub-2'));

  assert.equal(a.workspaceId, WS);
  assert.equal(b.workspaceId, WS2);
  assert.notEqual(a.principal.id, b.principal.id, 'two workspaces means two principals');

  // And repeated calls are stable, which is the part an unordered rows[0] could not promise.
  for (let i = 0; i < 5; i++) {
    assert.equal((await auth.scopeFromSession(WS, claims('priya@example.com'))).workspaceId, WS);
  }
});

test('a membership revoked in one workspace does not lock the member out of another', async () => {
  // The failure the missing predicate produced: with no ORDER BY, a revoked row could sort first
  // and the `revoked_at != null` check would reject a member who was perfectly active elsewhere.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  await store.addMember({ workspaceId: WS2, email: 'priya@example.com' });
  await auth.scopeFromSession(WS, claims('priya@example.com'));
  await auth.scopeFromSession(WS2, claims('priya@example.com', 'sub-2'));

  await store.removeMember(WS2, 'priya@example.com');

  const still = await auth.scopeFromSession(WS, claims('priya@example.com'));
  assert.equal(still.workspaceId, WS, 'removal from one workspace is not removal from all');

  const gone = await auth
    .scopeFromSession(WS2, claims('priya@example.com', 'sub-2'))
    .then(() => null, (e: AuthError) => e.kind);
  assert.equal(gone, 'no-membership');
});

test('an invitation is claimed by ONE provider credential, and not by a second', async () => {
  // `user_identities` was written on first sign-in and then never read, so resolution ran purely on
  // email. A different provider subject presenting the same address inherited the first person's
  // principal, their grant, and their history — and the address is the part an attacker chooses.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  const priya = await auth.scopeFromSession(WS, claims('priya@example.com', 'subject-priya'));

  const impostor = await auth
    .scopeFromSession(WS, claims('priya@example.com', 'subject-somebody-else'))
    .then(() => 'INHERITED THE ACCOUNT', (e: AuthError) => e.kind);
  assert.equal(impostor, 'no-membership', 'a second subject must not claim a taken invitation');

  // The real one still works, and is still the same account.
  const again = await auth.scopeFromSession(WS, claims('priya@example.com', 'subject-priya'));
  assert.equal(again.principal.id, priya.principal.id);
});

test('the same subject arriving from a different provider is also refused', async () => {
  // Subject ids are only unique WITHIN a provider, so the pair is the identity. Matching on
  // subject alone would hand an account to anyone whose provider happens to number users the same
  // way — and "1234" is a plausible subject at more than one provider.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  await auth.scopeFromSession(WS, claims('priya@example.com', '1234', 'provider-a'));

  const kind = await auth
    .scopeFromSession(WS, claims('priya@example.com', '1234', 'provider-b'))
    .then(() => null, (e: AuthError) => e.kind);
  assert.equal(kind, 'no-membership');
});

test('re-inviting a narrowed member does not silently widen their grant', async () => {
  // addMember mints a replacement grant, and it used to mint it with source_ids = NULL, which means
  // every source. Re-adding someone deliberately restricted to one source handed them the whole
  // vault — a privilege escalation performed by an operator doing something purely administrative,
  // and invisible afterwards because listMembers reports membership, not scope.
  const { db, store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const before = await auth.scopeFromSession(WS, claims('priya@example.com'));

  // Narrow them the way an operator would: revoke the open grant, issue a restricted one.
  //
  // Timestamps are pinned rather than left to now(). The original grant's `created_at` comes from
  // this package's JS clock and an operator's comes from Postgres, so leaving both to chance let
  // them collide inside one millisecond — and the assertion below then depended on how a tie was
  // broken. That made this test pass in isolation and fail in a full run, which reads as flakiness
  // and was actually the defect.
  await db.query(
    `UPDATE grants SET revoked_at = TIMESTAMPTZ '2026-01-01T00:00:01Z' WHERE principal_id = $1`,
    [before.principal.id],
  );
  await db.query(
    `INSERT INTO grants (workspace_id, id, principal_id, source_ids, created_at)
     VALUES ($1, 'g-narrow', $2, ARRAY[$3], TIMESTAMPTZ '2026-01-01T00:00:02Z')`,
    [WS, before.principal.id, SRC],
  );
  const narrowed = await auth.scopeFromSession(WS, claims('priya@example.com'));
  assert.deepEqual(scopeFilter(narrowed).sourceIds, [SRC], 'precondition: they are narrowed');

  await store.removeMember(WS, 'priya@example.com');

  // Suspend their authority as well as their membership. This step is the one that makes the test
  // real: `removeMember` revokes the membership, the principal and its tokens, but NOT grants — so
  // without this the narrowed grant stays active, addMember's insert is skipped by its own
  // NOT EXISTS guard, and the assertion below passes while never reaching the line under test.
  // An earlier version of this test did exactly that and survived a mutation that reintroduced the
  // bug.
  await db.query(
    `UPDATE grants SET revoked_at = TIMESTAMPTZ '2026-01-01T00:00:03Z'
      WHERE principal_id = $1 AND revoked_at IS NULL`,
    [before.principal.id],
  );

  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  const restored = await auth.scopeFromSession(WS, claims('priya@example.com'));
  assert.deepEqual(
    scopeFilter(restored).sourceIds,
    [SRC],
    're-inviting must restore the scope they had, not grant the whole workspace',
  );
});

test('the inherited scope is chosen deterministically when grants share a timestamp', async () => {
  // The tie the version above hid. Two grants with IDENTICAL created_at — reachable because this
  // package and a hand-written SQL statement stamp grants from different clocks — must not resolve
  // to "whichever the planner felt like", because one of the two answers is the entire workspace.
  const { db, store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const before = await auth.scopeFromSession(WS, claims('priya@example.com'));
  const SAME = `TIMESTAMPTZ '2026-01-01T00:00:00Z'`;

  await db.query(`UPDATE grants SET created_at = ${SAME}, revoked_at = ${SAME} WHERE principal_id = $1`, [
    before.principal.id,
  ]);
  // Same created_at as the unnarrowed one, but revoked LATER — so it is the one they last held.
  await db.query(
    `INSERT INTO grants (workspace_id, id, principal_id, source_ids, created_at, revoked_at)
     VALUES ($1,'g-tie',$2,ARRAY[$3], ${SAME}, TIMESTAMPTZ '2026-01-01T00:00:05Z')`,
    [WS, before.principal.id, SRC],
  );

  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });

  // Repeated to catch an ordering that is merely usually right.
  for (let i = 0; i < 3; i++) {
    const s = await auth.scopeFromSession(WS, claims('priya@example.com'));
    assert.deepEqual(scopeFilter(s).sourceIds, [SRC], `iteration ${i} inherited the wrong grant`);
  }
});

test('removeMember reports what it actually revoked', async () => {
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  const member = await auth.scopeFromSession(WS, claims('priya@example.com'));
  await store.createAgent(agent({ displayName: 'hers', createdBy: member.principal.id }));

  const report = await store.removeMember(WS, 'priya@example.com');
  assert.equal(report.principalsRevoked, 2, 'the person and the agent they created');
  assert.equal(report.tokensRevoked, 1);
  assert.equal(report.unattributedAgents, 0);
});

test('an agent with no creator survives every removal, and the report says so', async () => {
  // The defect the CLI message hid: `created_by IN (...)` never matches NULL, so an agent created
  // without an owner is untouched by removing anyone — while the CLI printed "their agents and
  // agent tokens are revoked too". This asserts the limitation AND that it is now reported, rather
  // than asserting a sweep that cannot happen.
  const { store, auth } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'priya@example.com' });
  await auth.scopeFromSession(WS, claims('priya@example.com'));
  const { presented } = await store.createAgent(agent({ displayName: 'nobody owns me' }));

  const report = await store.removeMember(WS, 'priya@example.com');
  assert.equal(report.unattributedAgents, 1, 'the operator is told an unownable agent exists');

  assert.ok(
    await auth.scopeFromAgentToken(presented),
    'and it does still work — which is exactly why the count has to be surfaced',
  );
});

test('malformed claims are rejected without a database round trip', async () => {
  const { auth } = await fresh();
  for (const bad of [
    { provider: 'supabase', subject: 's', email: '' },
    { provider: 'supabase', subject: '', email: 'a@b.c' },
    {} as never,
  ]) {
    const kind = await auth.scopeFromSession(WS, bad as never).then(() => null, (e: AuthError) => e.kind);
    assert.equal(kind, 'malformed');
  }
});

test('a non-binding session never spends the member\'s one identity binding', async () => {
  // The trap this option exists to close. `/auth/dev-login` mints a REAL session, so it wrote a
  // real identity row — and D16 gives a member exactly one binding. Using the dev shortcut once
  // therefore locked the genuine provider out with `no-membership`, permanently. It cost a magic
  // link and an hour to find, on the one task that was blocked.
  const { db, store } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'dev@example.com' });

  const local = {
    provider: 'strata-local-dev',
    subject: 'local|abc',
    email: 'dev@example.com',
  };
  const real = {
    provider: 'https://project.supabase.co/auth/v1',
    subject: 'supabase-uuid-1',
    email: 'dev@example.com',
  };

  const devSession = await store.resolveSession(WS, local, { bindIdentity: false });
  assert.ok(devSession, 'the development session still resolves and still gets a scope');

  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM user_identities');
  assert.equal(rows[0]?.n, 0, 'and it claimed nothing');

  // The whole point: the real credential still gets in afterwards.
  const realSession = await store.resolveSession(WS, real);
  assert.ok(realSession, 'the genuine provider is not locked out');
  assert.equal(realSession.principalId, devSession.principalId, 'and it is the same person');
});

test('a binding session still refuses a second credential — D16 is intact', async () => {
  // The guard must keep working. If this passes with `bindIdentity: false` anywhere near it, the
  // fix has quietly disabled the protection instead of narrowing it.
  const { store } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'alice@example.com' });

  const first = await store.resolveSession(WS, {
    provider: 'https://project.supabase.co/auth/v1',
    subject: 'alice-google',
    email: 'alice@example.com',
  });
  assert.ok(first);

  const second = await store.resolveSession(WS, {
    provider: 'https://project.supabase.co/auth/v1',
    subject: 'someone-else-claiming-alice',
    email: 'alice@example.com',
  });
  assert.equal(second, undefined, 'a second credential at a claimed invitation is still refused');
});

test('a non-binding FIRST sign-in still creates the principal and grant', async () => {
  // The first-sign-in path used the identity insert as its concurrency arbiter. Removing that write
  // must not remove the principal, the grant, or the membership update with it — a principal
  // without a grant is an account that exists and cannot be used.
  const { db, store } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'brandnew@example.com' });

  const session = await store.resolveSession(
    WS,
    { provider: 'strata-local-dev', subject: 'local|new', email: 'brandnew@example.com' },
    { bindIdentity: false },
  );

  assert.ok(session, 'first sign-in worked without writing an identity');
  assert.ok(session.grant, 'and it has a grant');
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM user_identities');
  assert.equal(rows[0]?.n, 0);

  const members = await store.listMembers(WS);
  assert.ok(members.find((m) => m.email === 'brandnew@example.com')?.joinedAt, 'membership was updated');
});

// --- re-scoping an agent from the UI (#31) ---------------------------------------------------
//
// The whole reason this is one statement: `grants_one_active` forces revoke-then-insert, and
// `agent_tokens_grant_belongs_to_principal` means the token has to move in the same breath. Each
// test below fails for a DIFFERENT structural reason if the CTE chain is broken, which is what
// makes them worth having over one happy-path assertion.

test('re-scoping narrows what the SAME token can reach, with no new token issued', async () => {
  const { store, auth } = await fresh();
  const { principalId, presented } = await store.createAgent(agent());

  // Starts unrestricted: source_ids NULL means every source in the workspace.
  const before = await auth.scopeFromAgentToken(presented);
  assert.equal(before.grant.sourceIds, undefined);

  const report = await store.rescopeAgent(WS, principalId, [SRC], new Date().toISOString());
  assert.deepEqual(report, { grantsReplaced: 1, tokensRepointed: 1 });

  // The SAME presented string now yields a narrowed scope. Re-scoping that required re-issuing a
  // credential would be a rotation, not a re-scope, and every operator would have to redeploy an
  // agent to change what it reads.
  const after = await auth.scopeFromAgentToken(presented);
  assert.deepEqual(after.grant.sourceIds, [SRC]);
});

test('re-scoping leaves exactly one active grant — the partial index is not violated', async () => {
  const { db, store } = await fresh();
  const { principalId } = await store.createAgent(agent());

  await store.rescopeAgent(WS, principalId, [SRC], new Date().toISOString());
  await store.rescopeAgent(WS, principalId, [], new Date().toISOString());

  const live = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM grants WHERE workspace_id = $1 AND principal_id = $2 AND revoked_at IS NULL`,
    [WS, principalId],
  );
  assert.equal(Number(live.rows[0]!.n), 1);

  // History is KEPT, not overwritten in place. "What could this agent reach last Tuesday" is a
  // question an incident review asks, and an UPDATE of source_ids would have destroyed the answer.
  const all = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM grants WHERE workspace_id = $1 AND principal_id = $2`,
    [WS, principalId],
  );
  assert.equal(Number(all.rows[0]!.n), 3);
});

test('no live token is ever left pointing at a revoked grant', async () => {
  // The failure this whole design exists to prevent: the token authenticates, then mintScope throws
  // `revoked`, and the agent is dead while the UI has just reported a successful re-scope.
  const { db, store, auth } = await fresh();
  const { principalId, presented } = await store.createAgent(agent());

  await store.rescopeAgent(WS, principalId, [SRC], new Date().toISOString());

  const orphaned = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n
       FROM agent_tokens t JOIN grants g
         ON g.workspace_id = t.workspace_id AND g.id = t.grant_id
      WHERE t.workspace_id = $1 AND t.revoked_at IS NULL AND g.revoked_at IS NOT NULL`,
    [WS],
  );
  assert.equal(Number(orphaned.rows[0]!.n), 0);
  await assert.doesNotReject(() => auth.scopeFromAgentToken(presented));
});

test('deny-all and every-source stay opposites through a re-scope', async () => {
  const { store, auth } = await fresh();
  const { principalId, presented } = await store.createAgent(agent({ sourceIds: [SRC] }));

  // [] is deny-all, and must NOT come back as undefined.
  await store.rescopeAgent(WS, principalId, [], new Date().toISOString());
  assert.deepEqual((await auth.scopeFromAgentToken(presented)).grant.sourceIds, []);

  // undefined is every-source, and must NOT come back as [].
  await store.rescopeAgent(WS, principalId, undefined, new Date().toISOString());
  assert.equal((await auth.scopeFromAgentToken(presented)).grant.sourceIds, undefined);
});

test('re-scoping a REVOKED agent does nothing — no live grant appears on a dead principal', async () => {
  const { db, store } = await fresh();
  const { principalId } = await store.createAgent(agent());
  await store.revokeAgent(WS, principalId, new Date().toISOString());

  const report = await store.rescopeAgent(WS, principalId, [SRC], new Date().toISOString());
  assert.deepEqual(report, { grantsReplaced: 0, tokensRepointed: 0 });

  // NOTE what `revokeAgent` does and does not touch: it revokes the PRINCIPAL and its TOKENS, and
  // deliberately leaves the grant row alone — killing the principal is sufficient, and `mintScope`
  // checks it. So the original grant is still `revoked_at IS NULL` here, and asserting zero live
  // grants would be asserting a property this codebase never had.
  //
  // The property that matters is that re-scoping minted NOTHING: no second grant, live or dead, on
  // a principal the operator believes they already shut off.
  const all = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM grants WHERE workspace_id = $1 AND principal_id = $2`,
    [WS, principalId],
  );
  assert.equal(Number(all.rows[0]!.n), 1);
});

test('re-scoping refuses a person, and refuses another workspace agent', async () => {
  const { store } = await fresh();
  await store.addMember({ workspaceId: WS, email: 'alice@example.com' });
  const person = await store.resolveSession(WS, claims('alice@example.com'));
  assert.ok(person);

  // kind 'user': membership decides what a person reaches, not the agent screen.
  assert.deepEqual(await store.rescopeAgent(WS, person.principalId, [SRC], new Date().toISOString()), {
    grantsReplaced: 0,
    tokensRepointed: 0,
  });

  // Cross-workspace: the id is real, the workspace is not the caller's.
  const { principalId } = await store.createAgent(agent());
  assert.deepEqual(await store.rescopeAgent(WS2, principalId, [SRC], new Date().toISOString()), {
    grantsReplaced: 0,
    tokensRepointed: 0,
  });
});

test('an already-revoked token is not dragged back onto the new grant', async () => {
  const { db, store } = await fresh();
  const { principalId } = await store.createAgent(agent());
  await db.query(`UPDATE agent_tokens SET revoked_at = $1 WHERE workspace_id = $2`, [
    new Date().toISOString(),
    WS,
  ]);

  const report = await store.rescopeAgent(WS, principalId, [SRC], new Date().toISOString());
  // The grant is still replaced -- the agent may hold a token issued later -- but a revoked token
  // stays on the old grant, which is the honest record of what it could reach while it was live.
  assert.equal(report.grantsReplaced, 1);
  assert.equal(report.tokensRepointed, 0);
});

test('a refused re-scope does not strand live tokens on a grant that was never created', async () => {
  // The case the `EXISTS (SELECT 1 FROM inserted)` guard on the token UPDATE actually covers, and
  // the one every other refusal test misses: a principal that is revoked while its tokens are still
  // live. `revokeAgent` sweeps the tokens too, so it cannot produce this state — an operator
  // revoking the principal directly, or a partially-applied earlier revocation, can.
  //
  // Without the guard the UPDATE repoints those live tokens at a grant id that was never inserted,
  // and the foreign key rejects the whole statement. The re-scope then fails loudly for an agent it
  // was only ever going to refuse quietly.
  const { db, store } = await fresh();
  const { principalId } = await store.createAgent(agent());
  await db.query(`UPDATE principals SET revoked_at = $1 WHERE workspace_id = $2 AND id = $3`, [
    new Date().toISOString(),
    WS,
    principalId,
  ]);

  const report = await store.rescopeAgent(WS, principalId, [SRC], new Date().toISOString());
  assert.deepEqual(report, { grantsReplaced: 0, tokensRepointed: 0 });

  // And the token still points at a grant that exists.
  const dangling = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM agent_tokens t
      WHERE t.workspace_id = $1
        AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.workspace_id = t.workspace_id AND g.id = t.grant_id)`,
    [WS],
  );
  assert.equal(Number(dangling.rows[0]!.n), 0);
});
