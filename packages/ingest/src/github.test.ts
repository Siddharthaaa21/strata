/**
 * The GitHub adapter.
 *
 * Every interesting case here is a FAILURE — a truncated tree, a rate limit, a binary file wearing a
 * `.md` extension, a repository large enough to exhaust an hour of API budget. None of them is
 * reachable from a test that talks to api.github.com, which is the entire reason `GitHubPort`
 * exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepoRef,
  scanGitHubRepo,
  createGitHubHttpPort,
  GitHubError,
  type GitHubPort,
  type GitHubTreeEntry,
} from './github.ts';
import type { SourceId } from '@strata/core';

const SRC = 'src-github' as SourceId;
const REF = { owner: 'acme', repo: 'handbook' };
const PUSHED = '2026-08-01T12:00:00.000Z';

interface FakeFile {
  readonly path: string;
  readonly text?: string;
  readonly size?: number;
  readonly throws?: GitHubError;
  readonly type?: string;
}

function fakePort(files: readonly FakeFile[], over: { truncated?: boolean } = {}): GitHubPort {
  const bySha = new Map(files.map((f, i) => [`sha${i}`, f]));
  const entries: GitHubTreeEntry[] = files.map((f, i) => ({
    path: f.path,
    type: f.type ?? 'blob',
    sha: `sha${i}`,
    ...(f.size === undefined ? {} : { size: f.size }),
  }));

  return {
    async repo() {
      return { defaultBranch: 'main', pushedAt: PUSHED };
    },
    async tree() {
      return { entries, truncated: over.truncated ?? false };
    },
    async blob(_ref, sha) {
      const f = bySha.get(sha);
      if (f === undefined) throw new GitHubError('not-found');
      if (f.throws) throw f.throws;
      return f.text ?? '';
    },
  };
}

// --- repo references ---------------------------------------------------------------------------

test('accepts the forms someone would actually paste', () => {
  for (const input of [
    'acme/handbook',
    ' acme/handbook ',
    'https://github.com/acme/handbook',
    'https://www.github.com/acme/handbook/',
    'git@github.com:acme/handbook.git',
    'acme/handbook.git',
  ]) {
    assert.deepEqual(parseRepoRef(input), REF, `failed on ${input}`);
  }
});

test('a repo reference cannot address a different endpoint', () => {
  // This string is spliced into a request path. A traversal or an extra segment must be refused
  // here, not discovered when the request comes back with something unexpected.
  for (const bad of [
    '',
    'acme',
    'acme/handbook/extra',
    '../../etc',
    'acme/../../../users',
    '/acme/handbook',
    'acme/',
    'a b/c d',
    'acme/repo?x=1',
  ]) {
    assert.throws(() => parseRepoRef(bad), GitHubError, `accepted ${JSON.stringify(bad)}`);
  }
});

// --- scanning ----------------------------------------------------------------------------------

test('imports Markdown and skips everything else', async () => {
  const port = fakePort([
    { path: 'README.md', text: '# Handbook\n\nHow we work.\n' },
    { path: 'docs/adr/0001-stack.md', text: '# ADR 0001\n\nWe chose Postgres.\n' },
    { path: 'src/index.ts', text: 'export const x = 1;' },
    { path: 'assets/logo.png', text: 'binary-ish' },
    { path: 'docs', type: 'tree' },
  ]);

  const result = await scanGitHubRepo(port, REF, SRC);

  assert.equal(result.found, 2, 'only the two Markdown blobs are candidates');
  assert.equal(result.pending.length, 2);
  assert.equal(result.incomplete, false);
  assert.equal(result.branch, 'main');
});

test('the path is the identity, unprefixed by the repo name', async () => {
  // One Source is one repository, so the source id already carries the repo. Prefixing here would
  // change every externalId the moment a repo were renamed, re-importing the whole vault as new.
  const port = fakePort([{ path: 'docs/adr/0001-stack.md', text: '# ADR 0001\n\nBody.\n' }]);
  const { pending } = await scanGitHubRepo(port, REF, SRC);
  assert.equal(pending[0]!.externalId, 'docs/adr/0001-stack.md');
});

test('a root README is filed under the repository, not under nothing', async () => {
  const port = fakePort([{ path: 'README.md', text: '# Handbook\n\nBody.\n' }]);
  const { pending } = await scanGitHubRepo(port, REF, SRC);
  assert.equal(pending[0]!.folder.value, 'handbook');
});

test('frontmatter, titles and tags come from the Markdown adapter, not from here', async () => {
  // The point of the design: this file fetches, `scanMarkdown` interprets. If these ever diverge,
  // there are two parsers and one of them is wrong.
  const port = fakePort([
    {
      path: 'docs/guide.md',
      text: '---\ntitle: Declared Title\ntags: [alpha, beta]\n---\n\n# Ignored H1\n\nBody text.\n',
    },
  ]);
  const { pending } = await scanGitHubRepo(port, REF, SRC);
  assert.equal(pending[0]!.title, 'Declared Title');
  assert.deepEqual([...pending[0]!.tags.value], ['alpha', 'beta']);
});

test('every file carries the repository push time', async () => {
  // A deliberate compromise: per-file commit dates cost one request each, which the unauthenticated
  // budget cannot pay. Documented on `scanGitHubRepo`, and the reason D28's id tiebreak matters.
  const port = fakePort([
    { path: 'a.md', text: '# A\n\nBody.\n' },
    { path: 'b.md', text: '# B\n\nBody.\n' },
  ]);
  const { pending } = await scanGitHubRepo(port, REF, SRC);
  assert.deepEqual(pending.map((p) => p.updatedAt), [PUSHED, PUSHED]);
});

// --- the failures that matter ------------------------------------------------------------------

test('an oversized file is refused WITHOUT being fetched', async () => {
  // The tree listing already carries sizes. Downloading 40 MB to reject it afterwards spends the
  // rate-limit budget the rest of the repository needs.
  let blobCalls = 0;
  const base = fakePort([{ path: 'huge.md', size: 50 * 1024 * 1024, text: 'x' }]);
  const port: GitHubPort = {
    ...base,
    async blob(ref, sha) {
      blobCalls += 1;
      return base.blob(ref, sha);
    },
  };

  const result = await scanGitHubRepo(port, REF, SRC);
  assert.equal(blobCalls, 0, 'the oversized blob was downloaded anyway');
  assert.deepEqual(result.failures, [{ externalId: 'huge.md', code: 'too-large' }]);
});

test('one unreadable file does not lose the rest', async () => {
  const port = fakePort([
    { path: 'good.md', text: '# Good\n\nBody.\n' },
    { path: 'bad.md', throws: new GitHubError('unreadable') },
    { path: 'also-good.md', text: '# Also\n\nBody.\n' },
  ]);

  const result = await scanGitHubRepo(port, REF, SRC);
  assert.equal(result.pending.length, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]!.externalId, 'bad.md');
});

test('a rate limit stops the run instead of failing every remaining file', async () => {
  // Continuing would turn one honest error into hundreds of misleading ones, and the Import screen
  // would report "197 failed" for what is a single condition with a single fix: wait, or add a token.
  const port = fakePort([
    { path: 'a.md', throws: new GitHubError('rate-limited') },
    { path: 'b.md', text: '# B\n\nBody.\n' },
  ]);

  await assert.rejects(() => scanGitHubRepo(port, REF, SRC), (e: unknown) => {
    assert.ok(e instanceof GitHubError);
    assert.equal((e as GitHubError).code, 'rate-limited');
    return true;
  });
});

test('a truncated tree reports incomplete rather than a clean partial import', async () => {
  // The failure this adapter is most exposed to: a partial import that presents itself as complete.
  const port = fakePort([{ path: 'a.md', text: '# A\n\nBody.\n' }], { truncated: true });
  const result = await scanGitHubRepo(port, REF, SRC);
  assert.equal(result.incomplete, true);
  assert.equal(result.pending.length, 1, 'what WAS fetched is still kept');
});

test('maxFiles stops the run and says so', async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({
    path: `doc-${i}.md`,
    text: `# Doc ${i}\n\nBody.\n`,
  }));
  const result = await scanGitHubRepo(fakePort(files), REF, SRC, { maxFiles: 4 });

  assert.equal(result.pending.length, 4);
  assert.equal(result.found, 10);
  assert.equal(result.incomplete, true, 'four of ten imported must never look like a full import');
});

test('an explicit branch overrides the default', async () => {
  const port = fakePort([{ path: 'a.md', text: '# A\n\nBody.\n' }]);
  assert.equal((await scanGitHubRepo(port, REF, SRC, { branch: 'develop' })).branch, 'develop');
  // Whitespace-only is not a branch; fall back rather than requesting `/git/trees/%20`.
  assert.equal((await scanGitHubRepo(port, REF, SRC, { branch: '   ' })).branch, 'main');
});

// --- the HTTP port -----------------------------------------------------------------------------

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test('403 with no remaining quota is a rate limit, not an auth failure', async () => {
  // Distinguished ONLY by the header. Reporting a rate limit as `unauthorized` sends someone off to
  // regenerate a token that was working perfectly.
  const port = createGitHubHttpPort(undefined, async () =>
    response(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0' }),
  );
  await assert.rejects(() => port.repo(REF), (e: unknown) => (e as GitHubError).code === 'rate-limited');

  const forbidden = createGitHubHttpPort(undefined, async () =>
    response(403, { message: 'forbidden' }, { 'x-ratelimit-remaining': '57' }),
  );
  await assert.rejects(() => forbidden.repo(REF), (e: unknown) => (e as GitHubError).code === 'unauthorized');
});

test('a network failure never carries the underlying message', async () => {
  // The caught error can name a proxy host, and this string reaches an ImportEvent (ADR 0003).
  const port = createGitHubHttpPort(undefined, async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.1:443 via corp-proxy.internal');
  });
  await assert.rejects(() => port.repo(REF), (e: unknown) => {
    const err = e as GitHubError;
    assert.equal(err.code, 'network');
    assert.ok(!err.message.includes('corp-proxy'), 'the proxy host leaked into the error');
    return true;
  });
});

test('the token is sent as a bearer header and appears nowhere else', async () => {
  let seen: Request | undefined;
  let url = '';
  const port = createGitHubHttpPort('ghp_secret_value', async (input, init) => {
    url = String(input);
    seen = new Request(String(input), init as RequestInit);
    return response(200, { default_branch: 'main', pushed_at: PUSHED });
  });

  await port.repo(REF);
  assert.equal(seen!.headers.get('authorization'), 'Bearer ghp_secret_value');
  // Never in the URL: query strings reach access logs, proxies, and referrers.
  assert.ok(!url.includes('ghp_secret_value'));
});

test('no token still works — that is the unauthenticated path', async () => {
  const port = createGitHubHttpPort(undefined, async (input, init) => {
    const req = new Request(String(input), init as RequestInit);
    assert.equal(req.headers.get('authorization'), null);
    return response(200, { default_branch: 'trunk', pushed_at: PUSHED });
  });
  assert.equal((await port.repo(REF)).defaultBranch, 'trunk');
});

test('a binary file with a .md extension is a failure, not a document of replacement characters', async () => {
  const port = createGitHubHttpPort(undefined, async () =>
    response(200, { encoding: 'base64', content: Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString('base64') }),
  );
  await assert.rejects(() => port.blob(REF, 'sha'), (e: unknown) => (e as GitHubError).code === 'unreadable');
});

test('an empty repository still yields a usable timestamp', async () => {
  // `pushed_at` is null on a repository with no commits. An invalid date would be rejected by the
  // store on write, turning an empty repo into a crash.
  const port = createGitHubHttpPort(undefined, async () =>
    response(200, { default_branch: 'main', pushed_at: null }),
  );
  const info = await port.repo(REF);
  assert.ok(!Number.isNaN(Date.parse(info.pushedAt)));
});

test('a 404 is not found, and is distinguishable from unreadable', async () => {
  const port = createGitHubHttpPort(undefined, async () => response(404, { message: 'Not Found' }));
  await assert.rejects(() => port.repo(REF), (e: unknown) => (e as GitHubError).code === 'not-found');
});

test('the tree parser ignores malformed entries rather than throwing', async () => {
  const port = createGitHubHttpPort(undefined, async () =>
    response(200, {
      tree: [
        { path: 'a.md', type: 'blob', sha: 'x', size: 10 },
        { path: 'no-sha.md', type: 'blob' },
        null,
        'not an object',
        { sha: 'no-path' },
      ],
      truncated: false,
    }),
  );
  const tree = await port.tree(REF, 'main');
  assert.equal(tree.entries.length, 1);
  assert.equal(tree.entries[0]!.path, 'a.md');
});
