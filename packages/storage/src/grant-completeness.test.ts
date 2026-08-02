/**
 * `Grant.sourceIds` must gate EVERY store method that takes a `Scope` — reads and writes alike
 * (ADR 0006 section 6).
 *
 * This suite is written to enumerate the live surface rather than a list of method names, and that
 * is the whole point of it. An independent review found the narrowing applied by `search`, `list`,
 * `get`, and `sources.list` and silently ignored by five others. Patching those five would be
 * correct today and silent about the method somebody adds next quarter — which is exactly the
 * failure mode that produced the gap in the first place.
 *
 * So: reflect over each store, and fail loudly on any method with no entry in the argument table.
 * Adding a store method without deciding how it treats a narrowed grant is a red suite, not a
 * quiet hole.
 *
 * The claim "this catches a method added later" was verified the way D13 says such claims must be:
 * by adding a deliberately-leaking store method and confirming this suite fails naming it, before
 * the claim was written down anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mintScope } from '@strata/core/scope-internal';
import type {
  Derived,
  DocId,
  Grant,
  GrantId,
  ImportEvent,
  Principal,
  PrincipalId,
  Scope,
  SourceId,
  WorkspaceId,
} from '@strata/core';
import { createDocStore, migrate, type SqlDriver, type UpsertDocInput } from './index.ts';
import { createSourceStore } from './sources.ts';
import { createEventStore } from './events.ts';

const WS = 'ws-alpha' as WorkspaceId;
/** The source everything is seeded into, and that every scope below is narrowed AWAY from. */
const SECRET = 'src-secret' as SourceId;
const ALLOWED = 'src-allowed' as SourceId;

function scopeFor(sourceIds?: readonly SourceId[]): Scope {
  const principal: Principal = { id: 'p1' as PrincipalId, kind: 'agent', workspaceId: WS };
  const base = {
    id: 'g1' as GrantId,
    workspaceId: WS,
    principalId: 'p1' as PrincipalId,
    createdAt: '2026-08-02T00:00:00.000Z',
  };
  const grant: Grant = sourceIds === undefined ? base : { ...base, sourceIds };
  return mintScope(principal, grant);
}

const authored = <T>(value: T): Derived<T> => ({
  value,
  provenance: 'user',
  derivedAt: '2026-08-02T00:00:00.000Z',
});

function doc(sourceId: SourceId, id: string): UpsertDocInput {
  return {
    id: id as DocId,
    sourceId,
    externalId: `notes/${id}.md`,
    contentHash: `sha256:${id}`,
    title: `Document ${id}`,
    excerpt: authored('an excerpt'),
    folder: authored('Architecture'),
    tags: authored(['ledger']),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    body: 'body text',
  };
}

function event(sourceId: SourceId, id: string): ImportEvent {
  return {
    id,
    workspaceId: WS,
    sourceId,
    docId: 'doc-secret' as DocId,
    status: 'imported',
    occurredAt: '2026-08-02T00:00:00.000Z',
  };
}

async function seeded() {
  const db = new PGlite() as unknown as SqlDriver;
  await migrate(db);
  const docs = createDocStore(db);
  const sources = createSourceStore(db);
  const events = createEventStore(db);

  // Seeded by an UNNARROWED scope, which is the only way this data legitimately exists.
  const god = scopeFor();
  await sources.upsert(god, {
    id: SECRET,
    kind: 'github',
    name: 'Private repo',
    description: 'not for the narrowed principal',
    status: 'connected',
    credentialRef: 'vault://oauth/gh/9f21',
  });
  await docs.upsert(god, doc(SECRET, 'doc-secret'));
  await events.append(god, [event(SECRET, 'evt-secret')]);

  return { db, docs, sources, events };
}

type Stores = Awaited<ReturnType<typeof seeded>>;

/**
 * How each method is invoked, and what a narrowed grant must do to it.
 *
 * `throws` — the call is a write, or a keyed read whose denial is an error. Always bare
 * `'NotFound'`: a distinct `'Forbidden'` would confirm the row exists, which is the enumeration
 * oracle the MCP surface exists to avoid.
 *
 * `empty` — the call is a list or an unkeyed lookup; denial is an absent result, never an error.
 */
const CALLS: Record<
  string,
  Record<string, { readonly expect: 'throws' | 'empty'; call(s: Stores, scope: Scope): Promise<unknown> }>
> = {
  docs: {
    upsert: { expect: 'throws', call: (s, sc) => s.docs.upsert(sc, doc(SECRET, 'doc-injected')) },
    findKnown: { expect: 'empty', call: (s, sc) => s.docs.findKnown(sc, SECRET, 'notes/doc-secret.md') },
    search: { expect: 'empty', call: (s, sc) => s.docs.search(sc, 'document') },
    list: { expect: 'empty', call: (s, sc) => s.docs.list(sc) },
    get: { expect: 'throws', call: (s, sc) => s.docs.get(sc, 'doc-secret' as DocId) },
  },
  sources: {
    upsert: {
      expect: 'throws',
      call: (s, sc) =>
        s.sources.upsert(sc, {
          id: SECRET,
          kind: 'markdown',
          name: 'hijacked',
          description: 'rewritten by a narrowed principal',
          status: 'connected',
        }),
    },
    list: { expect: 'empty', call: (s, sc) => s.sources.list(sc) },
  },
  events: {
    append: { expect: 'throws', call: (s, sc) => s.events.append(sc, [event(SECRET, 'evt-injected')]) },
    recent: { expect: 'empty', call: (s, sc) => s.events.recent(sc) },
  },
};

/** Denial-shaped: undefined, an empty array, or a result mentioning nothing from SECRET. */
function assertNothingSecret(result: unknown, where: string) {
  if (result === undefined) return;
  const serialized = JSON.stringify(result ?? null);
  assert.ok(
    !serialized.includes(SECRET) && !serialized.includes('doc-secret') && !serialized.includes('vault://'),
    `${where}: a narrowed grant received out-of-grant data: ${serialized.slice(0, 200)}`,
  );
}

for (const narrowing of [
  { label: 'deny-all grant (sourceIds: [])', sourceIds: [] as readonly SourceId[] },
  { label: 'grant naming only a foreign source', sourceIds: [ALLOWED] },
]) {
  test(`every store method honors a ${narrowing.label}`, async () => {
    const stores = await seeded();
    const scope = scopeFor(narrowing.sourceIds);

    for (const [storeName, store] of Object.entries({
      docs: stores.docs,
      sources: stores.sources,
      events: stores.events,
    })) {
      // Reflection over the real object, not a hand-written list. This is what makes a method added
      // later fail the suite rather than slip through it.
      const methods = Object.entries(store)
        .filter(([, v]) => typeof v === 'function')
        .map(([k]) => k);
      assert.ok(methods.length > 0, `${storeName}: reflection found methods`);

      for (const method of methods) {
        const entry = CALLS[storeName]?.[method];
        assert.ok(
          entry,
          `${storeName}.${method} has no entry in this suite's argument table. A store method that ` +
            `takes a Scope must declare how it treats a narrowed grant — add it to CALLS.`,
        );

        if (entry.expect === 'throws') {
          await assert.rejects(
            () => entry.call(stores, scope),
            (e: Error) => e.message === 'NotFound',
            `${storeName}.${method} must reject a narrowed grant with a bare NotFound`,
          );
        } else {
          assertNothingSecret(await entry.call(stores, scope), `${storeName}.${method}`);
        }
      }
    }

    // The database is the authority on whether a write got through — a method could return
    // innocently and still have written. Counts are exactly what `seeded()` put there.
    const counts = await Promise.all(
      ['docs', 'sources', 'import_events'].map((t) =>
        stores.db
          .query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE source_id = $1`, [SECRET])
          .catch(() =>
            stores.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE id = $1`, [SECRET]),
          ),
      ),
    );
    assert.deepEqual(
      counts.map((c) => c.rows[0]?.n),
      [1, 1, 1],
      'a narrowed grant wrote to, or removed from, a source outside its grant',
    );

    // The seeded source must still say what it said — sources.upsert overwrites every column, so a
    // denial that "failed" after the write would show up as a renamed connector.
    const { rows } = await stores.db.query<{ name: string; credential_ref: string | null }>(
      'SELECT name, credential_ref FROM sources WHERE workspace_id = $1 AND id = $2',
      [WS, SECRET],
    );
    assert.equal(rows[0]?.name, 'Private repo');
    assert.equal(rows[0]?.credential_ref, 'vault://oauth/gh/9f21');
  });
}

test('an unnarrowed grant still reaches everything — the gate is not a wall', async () => {
  // The failure mode opposite to the one above: over-tightening until the product does not work.
  const stores = await seeded();
  const scope = scopeFor();

  assert.equal((await stores.docs.list(scope)).length, 1);
  assert.equal((await stores.sources.list(scope)).length, 1);
  assert.equal((await stores.events.recent(scope)).length, 1);
  assert.ok(await stores.docs.findKnown(scope, SECRET, 'notes/doc-secret.md'));
  assert.equal((await stores.docs.get(scope, 'doc-secret' as DocId)).body, 'body text');
});

test('a grant naming the source reaches exactly that source and no other', async () => {
  const stores = await seeded();
  const scope = scopeFor([SECRET]);

  assert.equal((await stores.docs.list(scope)).length, 1);
  assert.equal((await stores.events.recent(scope)).length, 1);
  // And a write into the granted source succeeds, which is the half a read-only reading would break.
  const id = await stores.docs.upsert(scope, doc(SECRET, 'doc-second'));
  assert.equal(id, 'doc-second');
});
