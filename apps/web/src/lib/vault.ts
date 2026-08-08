import 'server-only';

/**
 * Server-side access to the vault. Imported only by Server Components.
 *
 * `server-only` makes an accidental client import a build error rather than a runtime surprise —
 * a bundled connection string would be a credential shipped to the browser.
 *
 * Everything here takes a `Scope` minted by `@strata/auth`. The web app has no more privilege than
 * the MCP server: same store, same scope filter, same tenancy boundary.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import pg from 'pg';
import { AuthError, createAuthenticator } from '@strata/auth';
import type { Scope, WorkspaceId } from '@strata/core';
import {
  createAuthStore,
  createDocStore,
  createEventStore,
  createSourceStore,
  fromPoolLike,
  requireConnectionString,
  type DocStore,
  type EventStore,
  type SourceStore,
} from '@strata/storage';
import { claimsFromCookies, supabaseSettings } from './session.ts';

/**
 * Next loads `.env` from the app directory; ours lives at the monorepo root so the CLI scripts and
 * the web app read one file. Reading it here keeps that single source of truth rather than
 * duplicating secrets into `apps/web/.env`.
 */
function loadRootEnv() {
  if (process.env['DATABASE_URL']) return;
  try {
    const raw = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
      if (m && process.env[m[1]!] === undefined) {
        process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* env may be supplied by the platform instead */
  }
}

/**
 * One pool per process. Cached on `globalThis` because Next's dev server re-evaluates modules on
 * every hot reload — without this each edit would leak a pool and eventually exhaust Supabase's
 * connection limit.
 */
const globalForPool = globalThis as unknown as { strataPool?: pg.Pool };

/**
 * Pool size is a function of where this runs, and the serverless answer is small.
 *
 * `max: 4` is right for one long-lived server. On Vercel it is wrong in a way that only shows up
 * under load: every serverless instance gets its OWN pool, so the real ceiling is
 * `max × concurrent instances`, and a platform that scales out on demand will happily create more
 * instances than a free-tier pooler has connections. The failure is not a slow page — it is
 * `remaining connection slots are reserved`, which looks like the database being down.
 *
 * One connection per instance, because a single request handled by one instance cannot use two.
 * Throughput comes from the platform running more instances, which is the model Vercel is built
 * around; holding spare connections open per instance buys nothing and costs the shared budget.
 *
 * The transaction-mode pooler (Supabase port 6543) is what makes this safe — it multiplexes many
 * short-lived client connections onto few Postgres backends. Pointing this at the direct port 5432
 * instead would exhaust the database's own limit no matter what this number says.
 *
 * `idleTimeoutMillis` matters for the same reason: an instance frozen between requests should not
 * hold a connection it is not using.
 */
const SERVERLESS = process.env['VERCEL'] === '1' || process.env['AWS_LAMBDA_FUNCTION_NAME'] !== undefined;

function pool(): pg.Pool {
  loadRootEnv();
  globalForPool.strataPool ??= new pg.Pool({
    connectionString: requireConnectionString(process.env),
    max: SERVERLESS ? 1 : 4,
    idleTimeoutMillis: SERVERLESS ? 10_000 : 30_000,
    // A hung connect should fail the request rather than hold the instance open until the platform
    // kills it — on a paused free-tier project, that is the difference between a fast error and a
    // timeout.
    connectionTimeoutMillis: 10_000,
  });
  return globalForPool.strataPool;
}

export interface Vault {
  readonly docs: DocStore;
  readonly sources: SourceStore;
  readonly events: EventStore;
  readonly scope: Scope;
}

/**
 * Thrown when the caller has no usable session.
 *
 * A distinct type because the page's response is a redirect, not an error page, and catching
 * `Error` broadly to decide that would also swallow real failures — turning a database outage into
 * a login prompt, which is the single most confusing thing this app could do.
 */
export class NotSignedIn extends Error {
  /** For our logs only. Every value produces the same redirect; see ADR 0006 §5. */
  readonly reason: string;

  constructor(reason: string) {
    super(`not signed in: ${reason}`);
    this.name = 'NotSignedIn';
    this.reason = reason;
  }
}

/**
 * Call per request, never module-scope.
 *
 * The `Scope` must not outlive a request — a cached one is a `Grant` revocation that silently does
 * not take effect. It is now minted from the caller's REAL session through the real code path:
 * cookie -> verified claims -> membership -> `Scope`. `localDevScope` is no longer reachable from
 * the web app, which was the point of increment 2. A development stub that mints authority is a
 * second path, and a second path is one nobody tests until it is the one running.
 *
 * Async because verification may need the provider's public keys. Every caller was already async.
 */
export async function vault(): Promise<Vault> {
  loadRootEnv();
  const workspaceId = process.env['STRATA_WORKSPACE_ID'] as WorkspaceId | undefined;
  if (!workspaceId) {
    throw new Error('STRATA_WORKSPACE_ID is not set. See docs/SETUP.md.');
  }

  const settings = supabaseSettings();
  const jar = await cookies();
  const asMap = new Map(jar.getAll().map((c) => [c.name, c.value]));

  const claims = await claimsFromCookies(asMap, settings);
  if (claims === undefined) throw new NotSignedIn('no valid session cookie');

  const db = fromPoolLike(pool());
  const auth = createAuthenticator(createAuthStore(db));

  let scope: Scope;
  try {
    // Membership, not the provider, decides whether this person gets a workspace. An authenticated
    // stranger is still a stranger, and being absent from the allowlist is the ordinary case.
    scope = await auth.scopeFromSession(workspaceId, claims);
  } catch (e) {
    throw new NotSignedIn(e instanceof AuthError ? e.kind : 'unknown');
  }

  return {
    docs: createDocStore(db),
    sources: createSourceStore(db),
    events: createEventStore(db),
    scope,
  };
}

/**
 * `vault()`, but "not signed in" becomes a redirect instead of an exception.
 *
 * Every screen wants exactly this, so it is one function rather than a try/catch each page has to
 * remember. `vault()` stays redirect-free underneath so it can be reasoned about — and tested —
 * without a router.
 *
 * Only `NotSignedIn` is converted. A database outage must stay an error: rendering a login page
 * because Postgres is unreachable would send everyone to re-authenticate, which fixes nothing and
 * hides the actual failure behind the most reassuring screen in the app.
 */
export async function requireVault(): Promise<Vault> {
  try {
    return await vault();
  } catch (e) {
    if (e instanceof NotSignedIn) redirect('/login');
    throw e;
  }
}

/** What a card needs. Deliberately no workspaceId, no body — same projection the MCP tools use. */
export interface DocListItem {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly folder: string;
  readonly updatedAt: string;
}

export interface SourceListItem {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
}

/** Loads the Library screen's data. Returns plain objects safe to hand to a Client Component. */
export async function loadLibrary(): Promise<{
  docs: DocListItem[];
  sources: SourceListItem[];
  /** The real number in scope, which is NOT `docs.length` — that is one clamped page. */
  total: number;
  /** Every folder in scope, not just those represented in the page above. */
  folders: string[];
}> {
  const { docs, sources, scope } = await requireVault();
  // Count and folders are queried separately and deliberately. `list` is clamped to MAX_RESULTS, so
  // deriving either from its result describes the page rather than the vault — which is how the
  // Library came to report "50 docs" for a 312-document workspace and to hide any folder whose
  // documents all fell outside the newest fifty.
  const [rows, srcs, total, folders] = await Promise.all([
    docs.list(scope),
    sources.list(scope),
    docs.count(scope),
    docs.folders(scope),
  ]);

  return {
    total,
    folders: [...folders],
    docs: rows.map((d) => ({
      id: d.id,
      sourceId: d.sourceId,
      title: d.title,
      excerpt: d.excerpt,
      folder: d.folder,
      updatedAt: d.updatedAt,
    })),
    // credentialRef and workspaceId are dropped here, not filtered downstream: a projection that
    // never carries them cannot leak them by omission of a later check.
    sources: srcs.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      description: s.description,
      status: s.status,
    })),
  };
}

export interface RecentImport {
  readonly id: string;
  readonly title: string;
  readonly occurredAt: string;
}

/**
 * Loads the Import screen's data.
 *
 * Failed events are excluded from this list, not from storage. The list has no status indicator by
 * design (README:24), so a failed row would read as a success. Where failures DO surface to the
 * user is still unresolved — carried out of M3 and recorded in the milestone plan.
 */
export async function loadImport(): Promise<{
  sources: SourceListItem[];
  recent: RecentImport[];
}> {
  const { sources, events, docs, scope } = await requireVault();
  const [srcs, evts] = await Promise.all([sources.list(scope), events.recent(scope, 20)]);

  const titles = new Map((await docs.list(scope, { limit: 50 })).map((d) => [d.id, d.title]));

  return {
    sources: srcs.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      description: s.description,
      status: s.status,
    })),
    recent: evts
      .filter((e) => e.status !== 'failed' && e.docId !== undefined && titles.has(e.docId))
      .map((e) => ({ id: e.id, title: titles.get(e.docId!)!, occurredAt: e.occurredAt })),
  };
}
