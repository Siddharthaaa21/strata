/**
 * The GitHub adapter — READMEs, ADRs and any other Markdown in a repository.
 *
 * **The GitHub-specific code here is fetching, and nothing else.** Once a file's text is in hand it
 * is Markdown, and Markdown already has an adapter: identity, frontmatter rules, title/excerpt/
 * folder/tag derivation, the fencing in `normalizeIngested`, the NUL check and the failure taxonomy
 * are all `scanMarkdown`'s, reached through the same in-memory port an upload uses. A second parser
 * that happened to agree with the first would be a second thing to review, and the one nobody
 * reviews is the one that ships a bug.
 *
 * That is also what `packages/ingest/src/index.ts` means by "adapters are the ONLY source-specific
 * code": if this file grew a `deriveTitle` of its own, the abstraction would be wrong.
 *
 * NETWORK ACCESS LIVES BEHIND A PORT (`GitHubPort`), for the reason `FileSystemPort` exists — every
 * interesting case here is a failure (truncated trees, rate limits, a moved default branch, a file
 * that is 40 MB of generated changelog), and none of them is reachable from a test that has to hit
 * api.github.com.
 */

import { createMemoryFileSystemPort, type MemoryFile } from './fs-port.ts';
import { scanMarkdown, type ScanResult } from './markdown.ts';
import type { SourceId } from '@strata/core';

/** `owner/repo`, already split. */
export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubTreeEntry {
  readonly path: string;
  /** `blob` is a file. Trees (directories) and commits (submodules) are skipped by the caller. */
  readonly type: string;
  readonly sha: string;
  /** Absent on some entries; treated as unknown rather than as zero. */
  readonly size?: number;
}

export interface GitHubTree {
  readonly entries: readonly GitHubTreeEntry[];
  /**
   * GitHub caps a recursive tree response and sets this rather than paginating.
   *
   * Surfaced all the way to the caller instead of being swallowed, because the failure it causes is
   * silent by nature: a partial import that looks exactly like a complete one. A repository with
   * more than ~100k entries would otherwise report success having skipped whatever fell off the end.
   */
  readonly truncated: boolean;
}

export interface GitHubRepoInfo {
  readonly defaultBranch: string;
  /**
   * When the repository was last pushed to. Used as the timestamp for **every** file — see
   * `scanGitHubRepo` for why per-file commit dates are not fetched.
   */
  readonly pushedAt: string;
}

/**
 * What this adapter needs from GitHub, and nothing more.
 *
 * Three calls. Deliberately not "a GitHub client": a port that could open issues or push commits is
 * a port that can be misused from a code path that only ever needed to read Markdown, and D5's
 * "no mutating tool exists" is easier to keep true when the mutation is unreachable by type.
 */
export interface GitHubPort {
  repo(ref: RepoRef): Promise<GitHubRepoInfo>;
  tree(ref: RepoRef, branch: string): Promise<GitHubTree>;
  /** UTF-8 text of one blob. Throws `GitHubError` for anything that is not decodable text. */
  blob(ref: RepoRef, sha: string): Promise<string>;
}

export type GitHubErrorCode =
  | 'repo-invalid'
  | 'not-found'
  | 'unauthorized'
  | 'rate-limited'
  | 'network'
  | 'tree-truncated'
  | 'too-large'
  | 'unreadable';

/**
 * A failure with a code, never a caught error's message.
 *
 * GitHub's error bodies quote request URLs and, on a private repository, path names. ADR 0003's
 * sanitized-message rule applies to anything that reaches an ImportEvent, and a path from a private
 * repo is exactly the kind of content that must not leak into one.
 */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  constructor(code: GitHubErrorCode) {
    super(`github: ${code}`);
    this.name = 'GitHubError';
    this.code = code;
  }
}

/** Matches GitHub's own rules: 1-39 chars of alphanumerics and hyphens for an owner. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Parses `owner/repo`, `owner/repo.git`, or a full GitHub URL.
 *
 * Validated rather than interpolated hopefully: this string comes from a text input and is spliced
 * into a request path. A `..` or a leading `/` in either half would let it address a different
 * endpoint entirely.
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();
  if (trimmed === '') throw new GitHubError('repo-invalid');

  // Accept what someone would actually paste: the address bar, or the clone URL.
  const withoutUrl = trimmed
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  const parts = withoutUrl.split('/');
  if (parts.length !== 2) throw new GitHubError('repo-invalid');

  const [owner, repo] = parts as [string, string];
  if (!OWNER.test(owner) || !REPO.test(repo)) throw new GitHubError('repo-invalid');
  return { owner, repo };
}

export interface GitHubScanOptions {
  /** Defaults to the repository's default branch. */
  readonly branch?: string;
  /** Extensions treated as Markdown. Matches `scanMarkdown`'s default. */
  readonly extensions?: readonly string[];
  /**
   * Skip a blob larger than this WITHOUT fetching it, using the size the tree already reported.
   *
   * The tree listing is one request and carries sizes, so an oversized file costs nothing to refuse.
   * Downloading a 40 MB generated changelog only to reject it afterwards spends the rate-limit
   * budget that the rest of the repository needs.
   */
  readonly maxBytes?: number;
  /** Hard ceiling on files fetched in one run, so one enormous repo cannot exhaust the API budget. */
  readonly maxFiles?: number;
}

const DEFAULT_EXTENSIONS = ['.md', '.markdown'] as const;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 300;

export interface GitHubScanResult extends ScanResult {
  readonly branch: string;
  /** Markdown files seen in the tree, before any size or count limit was applied. */
  readonly found: number;
  /**
   * True when files were left unfetched because `maxFiles` was reached, or the tree was truncated.
   *
   * The caller must not report a clean import when this is set. A partial import that presents
   * itself as complete is the failure this whole adapter is most exposed to.
   */
  readonly incomplete: boolean;
}

/**
 * Fetches a repository's Markdown and runs it through `scanMarkdown`.
 *
 * ## Identity
 *
 * `externalId` is the path within the repository, which is what `scanMarkdown` already uses and what
 * makes re-import idempotent and renames detectable (R5/D20). It is NOT prefixed with the repo name:
 * one `Source` is one repository, and the source id already carries that.
 *
 * ## Timestamps, and the compromise being made
 *
 * Every document gets the repository's `pushed_at`. Per-file commit dates would be accurate and cost
 * **one API request per file** — on the unauthenticated budget of 60 requests an hour, a 40-file
 * repository would fail halfway through, and reporting a partial import is worse than reporting a
 * coarse date.
 *
 * The consequence is that every file from one repository shares a timestamp, which makes recency
 * ordering within a repo meaningless and makes the `ORDER BY ... id DESC` tiebreak (D28) do real
 * work rather than decorative work. Stated here rather than discovered later.
 */
export async function scanGitHubRepo(
  port: GitHubPort,
  ref: RepoRef,
  sourceId: SourceId,
  options: GitHubScanOptions = {},
): Promise<GitHubScanResult> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const info = await port.repo(ref);
  const branch = options.branch?.trim() || info.defaultBranch;
  const tree = await port.tree(ref, branch);

  const markdown = tree.entries.filter(
    (e) => e.type === 'blob' && extensions.some((ext) => e.path.toLowerCase().endsWith(ext)),
  );

  const files: MemoryFile[] = [];
  const failures: { externalId: string; code: 'too-large' | 'unreadable' }[] = [];
  let fetched = 0;
  let hitFileLimit = false;

  for (const entry of markdown) {
    if (fetched >= maxFiles) {
      hitFileLimit = true;
      break;
    }
    // Refused from the tree listing, before spending a request on it.
    if (entry.size !== undefined && entry.size > maxBytes) {
      failures.push({ externalId: entry.path, code: 'too-large' });
      continue;
    }

    try {
      const text = await port.blob(ref, entry.sha);
      fetched += 1;
      files.push({ path: entry.path, text, modifiedAt: info.pushedAt });
    } catch (e) {
      // ONE file failing must not lose the rest — the same rule `scanMarkdown` follows for a folder
      // of two hundred. A rate limit is the exception: every subsequent request would fail too, so
      // continuing would turn one honest error into hundreds of misleading ones.
      if (e instanceof GitHubError && e.code === 'rate-limited') throw e;
      failures.push({ externalId: entry.path, code: 'unreadable' });
    }
  }

  // The root name feeds `deriveFolder`'s fallback for a file at the top level, so a README.md in the
  // repository root is filed under the repository rather than under a bare slash.
  const scanned = await scanMarkdown(createMemoryFileSystemPort(files), `/${ref.repo}`, sourceId, {
    extensions: [...extensions],
    maxBytes,
  });

  return {
    branch,
    found: markdown.length,
    incomplete: tree.truncated || hitFileLimit,
    pending: scanned.pending,
    // Fetch failures and parse failures are one list, because they are one thing to the person
    // reading the Import screen: files that did not arrive.
    failures: [...failures, ...scanned.failures],
  };
}

const API = 'https://api.github.com';

/**
 * The real port.
 *
 * `token` is optional and everything works without one against a public repository — at 60 requests
 * an hour rather than 5,000, which is the difference between one small repo and a working habit.
 * It is read from the environment by the caller and never logged, never included in an error, and
 * never returned.
 */
export function createGitHubHttpPort(token?: string, fetchImpl: typeof fetch = fetch): GitHubPort {
  async function call(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${API}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          // A User-Agent is required by the API; an absent one is rejected outright.
          'user-agent': 'strata-ingest',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      // The caught error is discarded. A DNS or TLS message can carry a proxy host, and this string
      // ends up in an ImportEvent.
      throw new GitHubError('network');
    }

    if (res.status === 401 || res.status === 403) {
      // 403 is BOTH "forbidden" and "rate limited" on this API, distinguished only by the remaining
      // count. Reporting a rate limit as an auth failure sends someone to regenerate a working token.
      const remaining = res.headers.get('x-ratelimit-remaining');
      throw new GitHubError(remaining === '0' ? 'rate-limited' : 'unauthorized');
    }
    if (res.status === 404) throw new GitHubError('not-found');
    if (!res.ok) throw new GitHubError('unreadable');

    try {
      return await res.json();
    } catch {
      throw new GitHubError('unreadable');
    }
  }

  const enc = encodeURIComponent;

  return {
    async repo(ref) {
      const body = (await call(`/repos/${enc(ref.owner)}/${enc(ref.repo)}`)) as Record<string, unknown>;
      const defaultBranch = typeof body['default_branch'] === 'string' ? body['default_branch'] : '';
      if (defaultBranch === '') throw new GitHubError('unreadable');
      const pushedAt = typeof body['pushed_at'] === 'string' ? body['pushed_at'] : '';
      return {
        defaultBranch,
        // An empty repository has a null `pushed_at`. Falling back to now keeps the document
        // orderable rather than emitting an invalid timestamp the store would reject.
        pushedAt: pushedAt === '' ? new Date().toISOString() : new Date(pushedAt).toISOString(),
      };
    },

    async tree(ref, branch) {
      // ONE request for the whole listing. Walking directories would be a request per directory,
      // which is how a 60-per-hour budget disappears before a single file has been read.
      const body = (await call(
        `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/trees/${enc(branch)}?recursive=1`,
      )) as Record<string, unknown>;

      const raw = Array.isArray(body['tree']) ? body['tree'] : [];
      const entries: GitHubTreeEntry[] = [];
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue;
        const e = item as Record<string, unknown>;
        if (typeof e['path'] !== 'string' || typeof e['sha'] !== 'string') continue;
        entries.push({
          path: e['path'],
          type: typeof e['type'] === 'string' ? e['type'] : '',
          sha: e['sha'],
          ...(typeof e['size'] === 'number' ? { size: e['size'] } : {}),
        });
      }
      return { entries, truncated: body['truncated'] === true };
    },

    async blob(ref, sha) {
      const body = (await call(
        `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/blobs/${enc(sha)}`,
      )) as Record<string, unknown>;

      const content = typeof body['content'] === 'string' ? body['content'] : '';
      const encoding = body['encoding'];
      if (encoding !== 'base64' || content === '') throw new GitHubError('unreadable');

      const buf = Buffer.from(content, 'base64');
      const text = buf.toString('utf8');
      // A binary file with a .md extension decodes to replacement characters rather than throwing.
      // Treated as unreadable so it becomes a reported failure instead of a document full of U+FFFD.
      if (text.includes('�')) throw new GitHubError('unreadable');
      return text;
    },
  };
}
