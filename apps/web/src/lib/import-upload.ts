import 'server-only';

/**
 * Turning an uploaded file into ingested documents.
 *
 * This is the Import screen's `Import` and `Upload` controls finally doing something. They have been
 * inert since M3 — inherited from the handoff, where README:75-76 marks them as visual endpoints —
 * while both backends worked perfectly from a terminal. A control that names a capability the system
 * genuinely has, and does not provide it, is the same defect as the Agent Access nav item that
 * returned a 404 and the `Connect` label on a source with no API. Third instance this week.
 *
 * **The path is the CLI's path.** Same adapters, same pipeline, same `persistIngest`, same
 * `Scope` minted from the caller's real session. No web-only ingest route, because a second way to
 * write into the vault is a second thing to review and the one nobody reviews is the one that ships
 * a bug.
 */

import { normalizeIngested, type Scope, type SourceId } from '@strata/core';
import {
  createGitHubHttpPort,
  createMemoryFileSystemPort,
  persistIngest,
  runIngest,
  parseRepoRef,
  scanClaudeExport,
  scanGitHubRepo,
  scanMarkdown,
  storeLookup,
  type MemoryFile,
  type PendingDoc,
} from '@strata/ingest';
import { requireVault } from './vault.ts';

/**
 * Upper bound on one upload.
 *
 * Generous for a Claude export (they are large) and still far below what would let a browser tab
 * exhaust a serverless instance's memory. The CLI has no equivalent because a local operator
 * reading their own disk is not the same threat as an authenticated form post.
 */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export interface ImportReport {
  readonly sourceName: string;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly failed: number;
  /** Stored documents with no counterpart in this upload. Reported, never acted on — see below. */
  readonly missing: number;
}

/**
 * Runs the shared tail of every upload: decide, persist, record events.
 *
 * **`prune` is not passed and there is no way to pass it.** A browser upload is the single worst
 * place to allow deletion: the user picked one file, and for Markdown they may have dragged one
 * folder of a larger vault, so almost every stored document is legitimately absent. The CLI keeps
 * `--prune` because an operator typed a sentence naming the whole source. Here the count is
 * reported so nothing is hidden, and acting on it stays a deliberate act at a terminal.
 */
async function ingestPending(
  scope: Scope,
  sourceId: SourceId,
  sourceName: string,
  sourceKind: 'markdown' | 'claude' | 'github',
  description: string,
  pending: readonly PendingDoc[],
  failures: readonly { readonly externalId: string; readonly code: string }[],
): Promise<ImportReport> {
  const { docs, sources, events } = await requireVault();
  const now = new Date().toISOString();

  await sources.upsert(scope, {
    id: sourceId,
    kind: sourceKind,
    name: sourceName,
    description,
    status: 'connected',
    lastSyncAt: now,
  });

  const result = await persistIngest(
    scope,
    docs,
    await runIngest({
      scope,
      sourceId,
      pending,
      // The scan's own failures are carried through unchanged so they reach `import_events` — the
      // Import screen's whole reason for recording failures is that a user can find out why a
      // document did not appear.
      failures: failures as never,
      lookup: storeLookup(scope, docs),
      known: await docs.listKnown(scope, sourceId),
      now,
    }),
    now,
  );

  await events.append(scope, result.events);

  return {
    sourceName,
    created: result.counts.new,
    updated: result.counts.changed + result.counts.renamed,
    unchanged: result.counts.unchanged,
    failed: result.counts.failed,
    missing: result.deletions.length,
  };
}

/**
 * Imports a Claude `conversations.json`.
 *
 * The adapter already takes text rather than a filesystem port — deliberately, because this is one
 * file a user hands us rather than a tree to walk (D22). That decision is what makes this function
 * six lines instead of a port shim.
 */
export async function importClaudeExport(raw: string): Promise<ImportReport> {
  const { scope } = await requireVault();
  const { pending, failures } = scanClaudeExport(raw, 'src-claude' as SourceId);

  return ingestPending(
    scope,
    'src-claude' as SourceId,
    'Claude',
    'claude',
    'Conversations imported from a Claude data export',
    pending,
    failures,
  );
}

/**
 * Imports uploaded Markdown files.
 *
 * Goes through **`scanMarkdown` itself**, over an in-memory port, rather than through a
 * browser-shaped reimplementation. Identity, canonicalization, frontmatter rules, the failure
 * taxonomy, the NUL check — all of it applies to an upload because it is literally the same code. A
 * second implementation that merely agreed with the first would be a second thing to review, and
 * the one nobody reviews is the one that ships a bug.
 *
 * The root name matters: `deriveFolder` falls back to the scan root's basename for a file sitting at
 * the top level, so a browser upload needs one. `Uploaded` is honest — the browser gives us
 * `webkitRelativePath` for a folder drop, and nothing at all for loose files.
 */
export async function importMarkdownFiles(files: readonly MemoryFile[]): Promise<ImportReport> {
  const { scope } = await requireVault();
  const { pending, failures } = await scanMarkdown(
    createMemoryFileSystemPort(files),
    '/Uploaded',
    'src-markdown' as SourceId,
  );

  return ingestPending(
    scope,
    'src-markdown' as SourceId,
    'Local Markdown',
    'markdown',
    'Markdown uploaded through the Import screen',
    pending,
    failures,
  );
}

/**
 * Indexes a GitHub repository's Markdown.
 *
 * **One Source per repository**, id `src-github-<owner>-<repo>`. Not a single shared `src-github`,
 * because `externalId` is the path WITHIN a repo and `README.md` exists in almost all of them — two
 * repositories sharing one source would silently overwrite each other's documents on every import.
 * The consequence is that the Import screen has to render sources beyond its four fixed slots, which
 * `screen-import` had already flagged as a gap waiting for its first real cause. This is it.
 *
 * NO PRUNE, like every other browser import: a partial scan is indistinguishable in shape from a
 * complete one, and pruning against a partial listing tombstones every document that merely fell
 * outside the ceiling. `npm run ingest:github -- <repo> --prune` refuses on an incomplete scan for
 * the same reason.
 */
export async function importGitHubRepo(input: string): Promise<ImportReport & { incomplete: boolean }> {
  const { scope } = await requireVault();

  // Throws `GitHubError('repo-invalid')` on anything that is not owner/repo. Validated before it is
  // spliced into a request path — a `..` in either half would address a different endpoint.
  const ref = parseRepoRef(input);
  const sourceId = `src-github-${ref.owner}-${ref.repo}`.toLowerCase() as SourceId;

  // Optional. Absent means public repositories only, at GitHub's unauthenticated 60/hour.
  const token = process.env['GITHUB_TOKEN']?.trim();

  const repoFolder = `${ref.owner}/${ref.repo}`;

  const scanned = await scanGitHubRepo(
    createGitHubHttpPort(token === '' ? undefined : token),
    ref,
    sourceId,
    // Lower than the CLI's 300. A browser request should not sit open for the minutes a large
    // repository takes, and `incomplete` says plainly when the ceiling was reached.
    { maxFiles: 150 },
  );

  const pendingWithFolder = scanned.pending.map((p) => ({
    ...p,
    folder: {
      ...p.folder,
      value: normalizeIngested(repoFolder),
      provenance: 'source' as const,
    },
  }));

  const report = await ingestPending(
    scope,
    sourceId,
    repoFolder,
    'github',
    `Markdown indexed from github.com/${repoFolder}`,
    pendingWithFolder,
    scanned.failures,
  );

  return { ...report, incomplete: scanned.incomplete };
}
