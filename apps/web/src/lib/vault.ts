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
import pg from 'pg';
import { localDevScope } from '@strata/auth';
import type { Scope, WorkspaceId } from '@strata/core';
import {
  createDocStore,
  createEventStore,
  createSourceStore,
  fromPoolLike,
  requireConnectionString,
  type DocStore,
  type EventStore,
  type SourceStore,
} from '@strata/storage';

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

function pool(): pg.Pool {
  loadRootEnv();
  globalForPool.strataPool ??= new pg.Pool({
    connectionString: requireConnectionString(process.env),
    max: 4,
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
 * Call per request, never module-scope.
 *
 * The `Scope` must not outlive a request — a cached one is a `Grant` revocation that silently does
 * not take effect. Today it comes from `localDevScope`, which is a labelled development stub and
 * NOT authentication (R7/M7); when real auth lands, only this function changes.
 */
export function vault(): Vault {
  loadRootEnv();
  const workspaceId = process.env['STRATA_WORKSPACE_ID'] as WorkspaceId | undefined;
  if (!workspaceId) {
    throw new Error('STRATA_WORKSPACE_ID is not set. See .env.example.');
  }

  const db = fromPoolLike(pool());
  return {
    docs: createDocStore(db),
    sources: createSourceStore(db),
    events: createEventStore(db),
    scope: localDevScope({ workspaceId }),
  };
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
}> {
  const { docs, sources, scope } = vault();
  const [rows, srcs] = await Promise.all([docs.list(scope), sources.list(scope)]);

  return {
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
  const { sources, events, docs, scope } = vault();
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
