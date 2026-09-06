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
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import pg from 'pg';
import { AuthError, createAuthenticator } from '@strata/auth';
import type { PrincipalId, Scope, SourceId, WorkspaceId } from '@strata/core';
import {
  createAccessLog,
  createAuthStore,
  createDocStore,
  createEventStore,
  createSourceStore,
  fromPoolLike,
  // The page size IS the store's ceiling, imported rather than restated. Two numbers that must agree
  // are two numbers that can disagree, and the failure would be a page that silently drops rows.
  MAX_RESULTS,
  requireConnectionString,
  type DocStore,
  type EventStore,
  type SourceStore,
} from '@strata/storage';
import { claimsFromCookies, LOCAL_ISSUER } from './session.ts';
import { PATH_HEADER } from '../proxy.ts';
import { redirectTarget } from './safe-path.ts';

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
 * `?next=<path>` for the sign-in redirect, or '' when there is nothing safe to carry.
 *
 * A Server Component cannot see its own URL, so every signed-out visit used to lose its destination:
 * open `/import` in a fresh browser and you signed in and landed on the Library. `proxy.ts` records
 * the requested path on a header; this turns it into a parameter.
 *
 * ONLY A SAME-ORIGIN PATH is carried, and the check is deliberately the same one `/auth/callback`
 * makes. A value starting `//` is a protocol-relative URL — `//evil.example` is absolute — so
 * accepting it would make the sign-in redirect an open redirect, which is the one place an open
 * redirect actually gets used: the domain in the address bar is genuinely ours right up to the
 * moment it is not.
 *
 * `/login` itself is refused as a destination, or a failed sign-in would bounce back to the form
 * carrying a `next` that points at the form.
 */
async function nextParam(): Promise<string> {
  let requested: string | null = null;
  try {
    requested = (await headers()).get(PATH_HEADER);
  } catch {
    // No request context (a script, a test). Nothing to carry, which is not an error.
    return '';
  }
  const target = redirectTarget(requested);
  return target === undefined ? '' : `?next=${encodeURIComponent(target)}`;
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

  const jar = await cookies();
  const asMap = new Map(jar.getAll().map((c) => [c.name, c.value]));

  // No settings argument: `claimsFromCookies` picks the local issuer when it is explicitly enabled
  // on a non-deployed machine, and the real provider otherwise. Everything after this line is
  // identical either way.
  const claims = await claimsFromCookies(asMap);
  if (claims === undefined) throw new NotSignedIn('no valid session cookie');

  const db = fromPoolLike(pool());
  const auth = createAuthenticator(createAuthStore(db));

  let scope: Scope;
  try {
    // Membership, not the provider, decides whether this person gets a workspace. An authenticated
    // stranger is still a stranger, and being absent from the allowlist is the ordinary case.
    //
    // `bindIdentity: false` for a local-issuer session, and this line is the whole fix for a trap
    // that cost a magic link and an hour. `/auth/dev-login` mints a REAL session, so it wrote a real
    // identity binding — and D16 gives a member exactly one. Signing in through the dev shortcut
    // once therefore SPENT the binding, and the genuine Supabase identity was refused with
    // `no-membership` from then on. A development convenience that locks you out of production
    // authentication is a trap.
    //
    // This is the only place that can make the call: `resolveSession` is provider-agnostic by
    // construction (ADR 0006 §5) and must not learn the name of our dev issuer, while this function
    // already chose which branch produced these claims.
    scope = await auth.scopeFromSession(workspaceId, claims, {
      bindIdentity: claims.provider !== LOCAL_ISSUER,
    });
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
    if (e instanceof NotSignedIn) redirect(`/login${await nextParam()}`);
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

/**
 * Loads the Library screen's data. Returns plain objects safe to hand to a Client Component.
 *
 * `query` runs a real ranked search ACROSS THE WHOLE VAULT, not a filter over the loaded page.
 * That distinction is the entire point, and getting it wrong is this codebase's most-repeated bug:
 * the doc count and the folder pills were both, at different times, describing one clamped page as
 * though it were the vault. A client-side search box would have been the third instance and the
 * worst, because "no results" is indistinguishable from "not on this page" — the user would
 * conclude the document is not in Strata.
 *
 * It is also the first time `svc-search`'s provenance-weighted ranking (ADR 0004) is reachable by a
 * human. It has been implemented and tested since M4 and, until now, only agents could use it.
 */
export async function loadLibrary(query?: string, page = 1, folder?: string): Promise<{
  docs: DocListItem[];
  sources: SourceListItem[];
  /** The real number in scope, which is NOT `docs.length` — that is one clamped page. */
  total: number;
  /** Every folder in scope, not just those represented in the page above. */
  folders: string[];
  /** Echoed back so the view can render the search state without re-parsing the URL. */
  query: string;
  /** 1-based, already clamped into range. The view renders it; it never recomputes it. */
  page: number;
  pageCount: number;
  pageSize: number;
  /** Index of the first document on this page, 1-based. Zero when the vault is empty. */
  firstOnPage: number;
  lastOnPage: number;
  /** The active folder, echoed back. Empty string means every folder. */
  folder: string;
}> {
  const q = query?.trim() ?? '';
  const activeFolder = folder?.trim() ?? '';
  const { docs, sources, scope } = await requireVault();

  if (q !== '') {
    // Ranked, whole-vault, scope-filtered in SQL. `count` and `folders` still describe the WHOLE
    // workspace rather than the result set: they are the "you are searching within this" context,
    // and recomputing them from matches would make the subtitle change meaning between states.
    const [hits, srcs, total, folders] = await Promise.all([
      docs.search(scope, q),
      sources.list(scope),
      docs.count(scope),
      docs.folders(scope),
    ]);

    return {
      query: q,
      total,
      folders: [...folders],
      // Search returns ONE ranked page and says so, rather than offering paging it does not have.
      // Offsetting a relevance ordering is a different feature — the interesting hits are at the
      // top by construction, and a Next button under them would imply an ordering that keeps
      // mattering as you walk down it.
      page: 1,
      pageCount: 1,
      pageSize: hits.length,
      // Echoed, not applied. A search is deliberately whole-vault; narrowing it by a folder pill
      // left over from browsing is the bug the `key={q}` remount was added to prevent.
      folder: '',
      firstOnPage: hits.length === 0 ? 0 : 1,
      lastOnPage: hits.length,
      docs: hits.map((d) => ({
        id: d.id,
        sourceId: d.sourceId,
        title: d.title,
        excerpt: d.excerpt,
        folder: d.folder,
        updatedAt: d.updatedAt,
      })),
      sources: srcs.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        description: s.description,
        status: s.status,
      })),
    };
  }

  // Count and folders are queried separately and deliberately. `list` is clamped to MAX_RESULTS, so
  // deriving either from its result describes the page rather than the vault — which is how the
  // Library came to report "50 docs" for a 312-document workspace and to hide any folder whose
  // documents all fell outside the newest fifty.
  //
  // The COUNT comes first, alone, because the page number has to be clamped against something real
  // before it can be turned into an OFFSET. Asking for page 900 of a 2-page vault must render the
  // last page, not an empty grid that looks exactly like an empty workspace.
  //
  // The folder is applied in SQL, not in the browser. It used to be a `useState` in the view
  // filtering the page that had already been fetched — which meant a pill selected the documents in
  // that folder *on this page*, so a folder whose documents all sat beyond the newest fifty rendered
  // an empty grid. Paging makes that failure ordinary rather than rare, and the store has taken a
  // `folder` option the whole time.
  const folderOption = activeFolder === '' ? {} : { folder: activeFolder };

  const total = await docs.count(scope, folderOption);
  const pageCount = Math.max(1, Math.ceil(total / MAX_RESULTS));
  const safePage = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), pageCount) : 1;

  const [rows, srcs, folders] = await Promise.all([
    docs.list(scope, { ...folderOption, offset: (safePage - 1) * MAX_RESULTS }),
    sources.list(scope),
    // EVERY folder in scope, never just the active one — these are the pills, and deriving them
    // from a filtered read would leave you inside a folder with no way back out.
    docs.folders(scope),
  ]);

  return {
    query: '',
    total,
    folder: activeFolder,
    folders: [...folders],
    page: safePage,
    pageCount,
    pageSize: MAX_RESULTS,
    firstOnPage: total === 0 ? 0 : (safePage - 1) * MAX_RESULTS + 1,
    lastOnPage: (safePage - 1) * MAX_RESULTS + rows.length,
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

export interface AgentAccessRow {
  readonly principalId: string;
  readonly kind: string;
  readonly name: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly revokedAt?: string;
  /** `undefined` means EVERY source. Never collapse it to `[]` — see `reach` below. */
  readonly sourceIds?: readonly string[];
  readonly lastUsedAt?: string;
  readonly activeTokens: number;
  readonly last4: string[];
}

/**
 * Loads the Agent Access screen: every non-human credential in the workspace and what it reaches.
 *
 * Source ids are resolved to NAMES here rather than in the view. `src-markdown` is an identifier;
 * "Local Markdown" is the thing the operator recognises, and this screen's only job is to let
 * someone decide whether a credential should keep existing.
 */
export async function loadAgentAccess(): Promise<{
  agents: (AgentAccessRow & { readonly reach: string })[];
  sources: SourceListItem[];
}> {
  const { scope, sources: sourceStore } = await requireVault();
  loadRootEnv();
  const workspaceId = process.env['STRATA_WORKSPACE_ID'] as WorkspaceId;

  const store = createAuthStore(fromPoolLike(pool()));
  const [agents, srcs] = await Promise.all([store.listAgents(workspaceId), sourceStore.list(scope)]);
  const nameOf = new Map(srcs.map((s) => [s.id, s.name]));

  return {
    sources: srcs.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      description: s.description,
      status: s.status,
    })),
    agents: agents.map((a) => {
      const live = a.tokens.filter((t) => t.revokedAt === undefined);
      // The most recent use across the agent's tokens. An agent is what gets revoked, so "when was
      // this last used" is a question about the agent, not about one of its credentials.
      const lastUsed = a.tokens
        .map((t) => t.lastUsedAt)
        .filter((v): v is string => v !== undefined)
        .sort()
        .at(-1);

      return {
        principalId: a.principalId,
        kind: a.kind,
        name: a.name,
        createdAt: a.createdAt,
        ...(a.createdBy === undefined ? {} : { createdBy: a.createdBy }),
        ...(a.revokedAt === undefined ? {} : { revokedAt: a.revokedAt }),
        ...(a.sourceIds === undefined ? {} : { sourceIds: a.sourceIds }),
        ...(lastUsed === undefined ? {} : { lastUsedAt: lastUsed }),
        activeTokens: live.length,
        last4: live.map((t) => t.last4),
        // The sentence the whole screen exists to show. Three cases, and conflating any two of them
        // is the failure mode: `undefined` is unnarrowed (everything), `[]` is deny-all (nothing),
        // and a populated list is the narrowing. A `?? []` anywhere upstream would render the most
        // powerful credential in the workspace as the most harmless.
        reach:
          a.sourceIds === undefined
            ? 'Every source in this workspace'
            : a.sourceIds.length === 0
              ? 'Nothing — this grant denies every source'
              // Falls back to the raw id when a grant names a source that no longer exists — which
              // is worth SEEING, not hiding: it means an agent is narrowed to something deleted,
              // and rendering nothing there would read as "reaches nothing" instead.
              : a.sourceIds.map((id) => nameOf.get(id as SourceId) ?? id).join(', '),
      };
    }),
  };
}

export interface AccessEvent {
  readonly id: string;
  readonly at: string;
  /** The agent's display name, or `undefined` when the call authenticated as nobody. */
  readonly actor?: string;
  readonly tool: string;
  readonly outcome: string;
  readonly documents: number;
}

/** How far back the activity view looks. */
const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Recent MCP activity, for the Agent Access screen.
 *
 * This is ADR 0005 §5's compensating control finally reaching a human. The ADR admits fencing
 * reduces injection's likelihood and blast radius without eliminating it, and names logging as what
 * covers the remainder — so an injection that SUCCEEDS is discovered here or not at all. It has
 * been collected since M6 and, until now, read by nobody.
 *
 * Principal ids are resolved to agent names, because a UUID cannot be recognised as "the thing on
 * my laptop" by the person deciding whether to revoke it.
 *
 * `unattributedFailures` is returned separately and counted rather than listed — those rows have no
 * workspace, so there is no honest answer to whose they are. See the store method.
 */
export async function loadActivity(limit = 50): Promise<{
  events: AccessEvent[];
  unattributedFailures: number;
  windowDays: number;
}> {
  await requireVault();
  loadRootEnv();
  const workspaceId = process.env['STRATA_WORKSPACE_ID'] as WorkspaceId;

  const db = fromPoolLike(pool());
  const log = createAccessLog(db);
  const auth = createAuthStore(db);

  const since = new Date(Date.now() - ACTIVITY_WINDOW_MS).toISOString();
  const [rows, agents, unattributedFailures] = await Promise.all([
    log.recent(workspaceId, limit),
    auth.listAgents(workspaceId),
    log.unattributedFailures(since),
  ]);

  const nameOf = new Map(agents.map((a) => [a.principalId as string, a.name]));

  return {
    windowDays: Math.round(ACTIVITY_WINDOW_MS / (24 * 60 * 60 * 1000)),
    unattributedFailures,
    events: rows.map((r) => ({
      id: r.id,
      at: r.occurredAt,
      // A principal we cannot name is left unnamed rather than shown as its id. The id means
      // nothing to a reader, and a revoked-and-deleted principal legitimately has no name.
      ...(r.principalId === undefined || !nameOf.has(r.principalId)
        ? {}
        : { actor: nameOf.get(r.principalId)! }),
      tool: r.tool,
      outcome: r.outcome,
      // A COUNT, never the ids or the titles. The log's first rule is that it never holds content,
      // and a screen that resolves logged doc ids back to titles would reconstruct, in a view built
      // for incident response, exactly what the table refuses to store.
      documents: r.docIds.length,
    })),
  };
}

/**
 * Revokes one agent. Called only from a POST.
 *
 * The scope is re-derived from the caller's session inside this function rather than passed in.
 * Anything a form submits is attacker-controlled, including a `principalId` — and `revokeAgent` is
 * scoped by the workspace resolved here, so a form naming another workspace's agent changes
 * nothing. Membership is the authorization: this workspace is flat, so any member may revoke any
 * agent in it, which is honest for a shared team vault and would need a role model the day it is
 * not.
 */
export async function revokeAgentAction(principalId: string): Promise<{ tokensRevoked: number }> {
  await requireVault();
  loadRootEnv();
  const workspaceId = process.env['STRATA_WORKSPACE_ID'] as WorkspaceId;

  const store = createAuthStore(fromPoolLike(pool()));
  const report = await store.revokeAgent(workspaceId, principalId as PrincipalId, new Date().toISOString());
  return { tokensRevoked: report.tokensRevoked };
}

/**
 * Changes what one agent reaches. Called only from a POST.
 *
 * Same authorization shape as `revokeAgentAction`, and for the same reason: the workspace is
 * re-derived from the caller's session, never taken from the form, so a crafted `principalId`
 * belonging to another workspace matches no row.
 *
 * `sourceIds` is validated against the sources this caller can actually SEE, not merely against the
 * sources table. Their `Scope` already narrows `sources.list`, so an id they cannot see is rejected
 * rather than written — otherwise this action would be a way to widen an agent onto a source the
 * person granting it has no access to, using nothing but a guessed id.
 *
 * `undefined` means every source and `[]` means deny-all. They are opposites the whole way down;
 * anything that collapses them here would silently rewrite the most consequential field on the
 * screen.
 */
export async function rescopeAgentAction(
  principalId: string,
  sourceIds: readonly string[] | undefined,
): Promise<{ grantsReplaced: number; tokensRepointed: number }> {
  const { scope, sources: sourceStore } = await requireVault();
  loadRootEnv();
  const workspaceId = process.env['STRATA_WORKSPACE_ID'] as WorkspaceId;

  let requested: readonly SourceId[] | undefined;
  if (sourceIds !== undefined) {
    const visible = new Set((await sourceStore.list(scope)).map((s) => s.id as string));
    const unknown = sourceIds.filter((id) => !visible.has(id));
    if (unknown.length > 0) {
      // Names no id back. The message says how many, not which — echoing an unrecognised id turns
      // this action into a probe for what exists in workspaces the caller cannot see.
      throw new Error(`${unknown.length} of those sources are not available in this workspace.`);
    }
    requested = sourceIds as readonly SourceId[];
  }

  const store = createAuthStore(fromPoolLike(pool()));
  return store.rescopeAgent(
    workspaceId,
    principalId as PrincipalId,
    requested,
    new Date().toISOString(),
  );
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
  failures: ImportFailure[];
}> {
  const { sources, events, docs, scope } = await requireVault();
  // 40 rather than 20: failures and successes now come out of one list and are split below, so a
  // single bad import could otherwise push every success off the end of the page.
  const [srcs, evts] = await Promise.all([sources.list(scope), events.recent(scope, 40)]);

  const titles = new Map((await docs.list(scope, { limit: MAX_RESULTS })).map((d) => [d.id, d.title]));

  return {
    sources: srcs.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      description: s.description,
      status: s.status,
    })),

    recent: evts
      .filter((e) => e.status !== 'failed')
      .map((e) => ({
        id: e.id,
        // FALLS BACK to the file path instead of dropping the row.
        //
        // The title map is the newest `MAX_RESULTS` documents, so an event about anything older
        // matched nothing and the row silently vanished — Recent imports quietly stopped being a
        // record of what happened and became a record of what is currently near the top. The
        // `externalId` is always present for a per-file event and identifies the same thing.
        title: (e.docId !== undefined ? titles.get(e.docId) : undefined) ?? e.externalId ?? 'Untitled',
        occurredAt: e.occurredAt,
      })),

    /**
     * Failures, which this screen has never shown.
     *
     * Carried out of M3 and open ever since: failed events were filtered out because the Recent
     * Imports list has no status indicator by design (README:24), so a failed row would read as a
     * success. That was a correct reason not to put them in THAT list, and it was mistaken for a
     * reason not to show them at all — so a file that failed to import was simply absent, with
     * nothing anywhere to say why. ADR 0003 records failures precisely so a user can find out why a
     * document did not appear; until now nothing served that purpose.
     *
     * It matters more since the upload buttons shipped (D24): a person can now cause a failure from
     * the browser, and the browser was the one place that could not tell them.
     */
    failures: evts
      .filter((e) => e.status === 'failed')
      .map((e) => ({
        id: e.id,
        // The path, not a doc title — `docId` is absent precisely in the failure case.
        externalId: e.externalId ?? 'unknown file',
        // The sanitized message by contract (ADR 0003): a fixed per-code template, never a caught
        // exception's text and never document content.
        code: e.error?.code ?? 'unknown',
        message: e.error?.message ?? '',
        occurredAt: e.occurredAt,
      })),
  };
}

export interface ImportFailure {
  readonly id: string;
  readonly externalId: string;
  readonly code: string;
  readonly message: string;
  readonly occurredAt: string;
}
