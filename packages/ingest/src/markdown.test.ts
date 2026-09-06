/**
 * Local Markdown adapter tests (ADR 0003).
 *
 * Uses a fake filesystem port rather than temp directories — that is the whole reason ADR 0003
 * chose a port: EACCES, a broken symlink, and invalid UTF-8 cannot be produced portably on disk,
 * and those are exactly the paths that most need testing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mintScope } from '@strata/core/scope-internal';
import type { DocId, GrantId, PrincipalId, SourceId, WorkspaceId } from '@strata/core';
import {
  PortError,
  createMemoryFileSystemPort,
  createNodeFileSystemPort,
  type FileEntry,
  type FileSystemPort,
  type FileStat,
} from './fs-port.ts';
import {
  canonicalize,
  contentHash,
  scanMarkdown,
  toExternalId,
  MarkdownError,
  MAX_EXCERPT,
  MAX_TITLE,
  MAX_FOLDER,
  MAX_TAG,
  deriveTitle,
  deriveFolder,
  deriveExcerpt,
} from './markdown.ts';
import { runIngest, type KnownDoc } from './pipeline.ts';

const SRC = 'src-markdown' as SourceId;
const WS = 'ws-alpha' as WorkspaceId;
const NUL = String.fromCharCode(0);

const scope = mintScope(
  { id: 'p1' as PrincipalId, kind: 'user', workspaceId: WS },
  { id: 'g1' as GrantId, workspaceId: WS, principalId: 'p1' as PrincipalId, createdAt: '2026-07-29T00:00:00.000Z' },
);

interface FakeFile {
  readonly text?: string;
  readonly size?: number;
  readonly isSymlink?: boolean;
  readonly throws?: 'unreadable' | 'invalid-encoding';
  readonly modifiedAt?: string;
  readonly createdAt?: string;
}

function fakePort(files: Record<string, FakeFile>): FileSystemPort {
  return {
    async scan(): Promise<readonly FileEntry[]> {
      return Object.entries(files).map(([path, f]) => ({ path, isSymlink: f.isSymlink ?? false }));
    },
    async stat(_root, path): Promise<FileStat> {
      const f = files[path];
      if (!f) throw new PortError('not-found');
      return {
        size: f.size ?? (f.text?.length ?? 0),
        modifiedAt: f.modifiedAt ?? '2026-07-28T00:00:00.000Z',
        createdAt: f.createdAt ?? '2026-07-01T00:00:00.000Z',
      };
    },
    async readText(_root, path) {
      const f = files[path];
      if (!f) throw new PortError('not-found');
      if (f.throws) throw new PortError(f.throws);
      return f.text ?? '';
    },
  };
}

const scan = (files: Record<string, FakeFile>) => scanMarkdown(fakePort(files), '/vault', SRC);

// --- identity ------------------------------------------------------------------

test('canonicalize makes a Windows checkout hash identically to a Unix one', () => {
  assert.equal(contentHash('a\r\nb\r\n'), contentHash('a\nb\n'));
  assert.equal(contentHash('﻿a\nb'), contentHash('a\nb'));
  assert.equal(contentHash('a\nb\n\n\n   \n'), contentHash('a\nb\n'));
});

test('canonicalize does not collapse content differences', () => {
  assert.notEqual(contentHash('a\nb\n'), contentHash('a\nc\n'));
  assert.equal(canonicalize('x'), 'x\n');
});

test('externalId is NFC-normalized', () => {
  assert.equal(toExternalId('caf' + String.fromCharCode(0x65, 0x301) + '.md'), 'café.md');
  assert.equal(toExternalId('notes/arch/a.md'), 'notes/arch/a.md');
});

test('a backslash is rejected, not folded onto a real path', () => {
  // Folding `a\b.md` to `a/b.md` merged two distinct files into one identity. Within a run that is
  // now a reported collision; across runs it was undetectable and silently overwrote. The Node port
  // already converts path.sep to '/', so nothing needs this fold.
  assert.throws(() => toExternalId('notes\\arch\\a.md'), (e: Error) => e instanceof MarkdownError);
});

test('a NUL in a path is rejected, because it forges identity keys', () => {
  assert.throws(() => toExternalId(`a${NUL}b.md`), (e: Error) => e instanceof MarkdownError);
});

test('an escaping relative path is rejected', () => {
  assert.throws(() => toExternalId('../outside.md'), (e: Error) => e instanceof MarkdownError);
});

// --- derivation ----------------------------------------------------------------

test('title falls back frontmatter -> heading -> filename', async () => {
  const { pending } = await scan({
    'a.md': { text: '---\ntitle: From Frontmatter\n---\n# From Heading\nbody' },
    'b.md': { text: '# From Heading\nbody' },
    'my_doc-name.md': { text: 'no heading here' },
  });
  const byId = Object.fromEntries(pending.map((p) => [p.externalId, p.title]));
  assert.equal(byId['a.md'], 'From Frontmatter');
  assert.equal(byId['b.md'], 'From Heading');
  assert.equal(byId['my_doc-name.md'], 'my doc name');
});

test('excerpt prefers a declared summary and marks it source, not heuristic', async () => {
  const { pending } = await scan({
    'a.md': { text: '---\ndescription: Declared summary.\n---\nbody prose' },
    'b.md': { text: '# Title\n\n```js\ncode();\n```\n\nFirst real prose with a [link](http://x).' },
  });
  const byId = Object.fromEntries(pending.map((p) => [p.externalId, p.excerpt]));
  assert.equal(byId['a.md']?.value, 'Declared summary.');
  assert.equal(byId['a.md']?.provenance, 'source');
  assert.equal(byId['b.md']?.value, 'First real prose with a link.', 'code skipped, link reduced');
  assert.equal(byId['b.md']?.provenance, 'heuristic');
});

test('folder from a directory is source, not heuristic — a human filed it there', async () => {
  const { pending } = await scan({
    'Architecture/a.md': { text: '# A' },
    'root.md': { text: '# B' },
  });
  const byId = Object.fromEntries(pending.map((p) => [p.externalId, p.folder]));
  assert.deepEqual(
    { value: byId['Architecture/a.md']?.value, provenance: byId['Architecture/a.md']?.provenance },
    { value: 'Architecture', provenance: 'source' },
  );
  assert.equal(byId['root.md']?.provenance, 'heuristic', 'scan-root basename is a guess');
});

test('tags are never guessed — absent means empty, marked heuristic', async () => {
  const { pending } = await scan({
    'a.md': { text: '---\ntags: [ledger, retries, ledger]\n---\n# A' },
    'b.md': { text: '# Kubernetes Deployment Guide' },
  });
  const byId = Object.fromEntries(pending.map((p) => [p.externalId, p.tags]));
  assert.deepEqual(byId['a.md']?.value, ['ledger', 'retries'], 'deduped');
  assert.equal(byId['a.md']?.provenance, 'source');
  assert.deepEqual(byId['b.md']?.value, [], 'no tag guessed from the title');
  assert.equal(byId['b.md']?.provenance, 'heuristic');
});

test('timestamps come from the filesystem, never from frontmatter', async () => {
  const { pending } = await scan({
    'a.md': {
      text: '---\ndate: 2099-01-01\nupdated: 2099-01-01\n---\n# A',
      modifiedAt: '2026-07-28T00:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
  });
  assert.equal(pending[0]?.updatedAt, '2026-07-28T00:00:00.000Z');
  assert.equal(pending[0]?.createdAt, '2026-07-01T00:00:00.000Z');
});

test('ingested content is normalized — bidi controls cannot hide from the reviewer', async () => {
  const RLO = String.fromCharCode(0x202e);
  const { pending } = await scan({ 'a.md': { text: `# Title${RLO}hidden\n\nbody` } });
  assert.ok(!pending[0]?.title.includes(RLO));
});

// --- failure handling ----------------------------------------------------------

test('one bad file does not fail the batch', async () => {
  const { pending, failures } = await scan({
    'good.md': { text: '# Good\n\nprose' },
    'bad.md': { throws: 'unreadable' },
    'binary.md': { throws: 'invalid-encoding' },
  });
  assert.equal(pending.length, 1);
  assert.deepEqual(
    failures.map((f) => [f.externalId, f.code]).sort(),
    [['bad.md', 'unreadable'], ['binary.md', 'invalid-encoding']].sort(),
  );
});

test('malformed frontmatter is a failure, not a silent degrade', async () => {
  const { pending, failures } = await scan({ 'a.md': { text: '---\ntitle: [unclosed\n---\nbody' } });
  assert.equal(pending.length, 0);
  assert.equal(failures[0]?.code, 'frontmatter-invalid');
});

test('symlinks are recorded as skipped, never followed', async () => {
  const { pending, failures } = await scan({ 'link.md': { isSymlink: true, text: '# X' } });
  assert.equal(pending.length, 0);
  assert.equal(failures[0]?.code, 'unsupported-type');
});

test('.mdx and oversized files are excluded', async () => {
  const { pending, failures } = await scan({
    'a.mdx': { text: '# JSX' },
    'big.md': { text: '# Big', size: 99 * 1024 * 1024 },
  });
  assert.equal(pending.length, 0);
  assert.deepEqual(failures.map((f) => f.code).sort(), ['too-large', 'unsupported-type']);
});

test('an empty file is a failure — the user needs to learn why nothing appeared', async () => {
  const { failures } = await scan({ 'a.md': { text: '   \n\n  ' } });
  assert.equal(failures[0]?.code, 'empty');
});

// --- dedupe --------------------------------------------------------------------

const runFor = async (
  pending: Awaited<ReturnType<typeof scan>>['pending'],
  failures: Awaited<ReturnType<typeof scan>>['failures'],
  known: Record<string, KnownDoc> = {},
) => {
  let n = 0;
  return runIngest({
    scope,
    sourceId: SRC,
    pending,
    failures,
    lookup: async (_s, externalId) => known[externalId],
    newId: () => `doc-minted-${++n}` as DocId,
    newEventId: () => `evt-${n}`,
    now: '2026-07-29T00:00:00.000Z',
  });
};

test('a first import is new and mints an id', async () => {
  const { pending, failures } = await scan({ 'a.md': { text: '# A\n\nprose' } });
  const { decisions, counts } = await runFor(pending, failures);
  assert.equal(decisions[0]?.outcome, 'new');
  assert.equal(decisions[0]?.docId, 'doc-minted-1');
  assert.equal(counts.new, 1);
});

test('re-importing identical content is unchanged, and reuses the stored id', async () => {
  const { pending, failures } = await scan({ 'a.md': { text: '# A\n\nprose' } });
  // `folder` must match too, or the drift check (D30) would report this as changed.
  const known = {
    'a.md': { docId: 'doc-existing' as DocId, contentHash: pending[0]!.contentHash, folder: pending[0]!.folder.value },
  };
  const { decisions, events } = await runFor(pending, failures, known);

  assert.equal(decisions[0]?.outcome, 'unchanged');
  assert.equal(decisions[0]?.docId, 'doc-existing', 'never mints a second id for the same file');
  assert.equal(events[0]?.status, 'skipped-duplicate');
});

test('edited content is changed, not new — the id survives the edit', async () => {
  const { pending, failures } = await scan({ 'a.md': { text: '# A\n\nedited prose' } });
  const known = {
    'a.md': { docId: 'doc-existing' as DocId, contentHash: 'sha256:stale', folder: pending[0]!.folder.value },
  };
  const { decisions, events } = await runFor(pending, failures, known);

  assert.equal(decisions[0]?.outcome, 'changed');
  assert.equal(decisions[0]?.docId, 'doc-existing');
  assert.equal(events[0]?.status, 'updated');
});

test('failures are emitted as events with a fixed message, never the raw error', async () => {
  const { pending, failures } = await scan({ 'a.md': { text: '---\nbad: [\n---\nx' } });
  const { events, counts } = await runFor(pending, failures);

  const failed = events.find((e) => e.status === 'failed');
  assert.equal(counts.failed, 1);
  assert.equal(failed?.error?.code, 'frontmatter-invalid');
  assert.equal(failed?.error?.message, 'The YAML frontmatter could not be parsed.');
  assert.ok(!failed?.error?.message.includes('['), 'no offending source text in the message');
  assert.equal(failed?.docId, undefined, 'a failure before a Doc existed has no docId');
});

// --- bounds and collisions found by independent review -----------------------------------------

test('a frontmatter description is capped, not trusted to be excerpt-sized', async () => {
  // The heuristic path always sliced; this one did not, and `description:` is attacker-controlled
  // up to the 2 MiB file cap. That turned search_docs — "metadata and excerpts only, never
  // document bodies" — into a body-sized channel, multiplied by MAX_RESULTS rows.
  const { pending } = await scan({
    'big.md': { text: `---\ndescription: "${'A'.repeat(5000)}"\n---\n\n# Doc\n\nprose` },
  });

  assert.equal(pending[0]?.excerpt.value.length, MAX_EXCERPT);
  assert.equal(pending[0]?.excerpt.provenance, 'source', 'still attributed to the author');
});

test('two files colliding on one externalId fail loudly instead of overwriting each other', async () => {
  // toExternalId folds backslashes (tested above, and correct for Windows-authored paths), so a
  // literal `a\b.md` and a real `a/b.md` normalize to the same identifier. Different content means
  // different hashes, so a run guard keyed on the full triple missed and BOTH were decided `new` —
  // the second silently upserted over the first, and every later run flip-flopped the surviving
  // row between the two documents forever.
  // NFD vs NFC filenames — the collision that REMAINS after backslash folding was removed.
  // `toExternalId` must NFC-normalize for identity stability across filesystems, so on a
  // normalization-preserving filesystem these two distinct files legitimately land on one id.
  const nfd = 'caf' + String.fromCharCode(0x65, 0x301) + '.md';
  const { pending, failures } = await scan({
    'café.md': { text: '# Alpha\n\nfirst document' },
    [nfd]: { text: '# Bravo\n\nsecond, entirely different document' },
  });
  assert.equal(pending.length, 2, 'the scan legitimately produces two files');
  assert.equal(pending[0]?.externalId, pending[1]?.externalId, 'which collide on identity');

  const { decisions, counts, events } = await runFor(pending, failures);

  assert.equal(decisions.length, 1, 'only the first claimant is written');
  assert.equal(counts.new, 1);
  assert.equal(counts.failed, 1, 'the loser is reported, never silently discarded');
  const failed = events.filter((e) => e.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.error?.code, 'duplicate-identity');
});

// --- ReDoS: inputs that used to make ingest hang -----------------------------------------------

test('a file of trailing whitespace canonicalizes in linear time', () => {
  // The old `.replace(/\s*$/, '\n')` was quadratic: 25k spaces took 227ms, 150k took 8.3s, and the
  // 2 MiB file cap extrapolated to ~27 minutes of blocked event loop for one crafted file. A
  // wall-clock bound is a blunt assertion, but it is the only thing that distinguishes linear from
  // quadratic, and the margin is three orders of magnitude — this cannot flake into passing.
  const hostile = ' '.repeat(2_000_000) + 'x';
  const started = process.hrtime.bigint();
  const out = canonicalize(hostile);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(out, hostile + '\n', 'leading whitespace is content and is preserved');
  assert.ok(ms < 1000, `canonicalize took ${ms.toFixed(0)}ms on 2 MiB of trailing space`);
});

test('canonicalize still collapses trailing whitespace exactly as before', () => {
  // The behaviour identity depends on. Changing the implementation must not change the hash, or
  // every document in every vault re-imports as "updated".
  assert.equal(canonicalize('a\nb\n\n\n   \n'), 'a\nb\n');
  assert.equal(canonicalize('x'), 'x\n');
  assert.equal(canonicalize(''), '\n');
  assert.equal(contentHash('a\r\nb\r\n'), contentHash('a\nb\n'));
});

test('a paragraph of unbalanced brackets does not hang excerpt derivation', () => {
  // `/\[([^\]]*)\]\([^)]*\)/g` backtracks from every `[`. 200k brackets measured 14.5s before the
  // input was bounded ahead of the regex.
  const origin = {
    path: 'a.md',
    modifiedAt: '2026-08-02T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
  const started = process.hrtime.bigint();
  const excerpt = deriveExcerpt(origin, '['.repeat(2_000_000));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(excerpt.value.length <= MAX_EXCERPT);
  assert.ok(ms < 1000, `deriveExcerpt took ${ms.toFixed(0)}ms on 2 MiB of '['`);
});

test('bounding the excerpt window does not truncate an ordinary link', () => {
  // The bound must change output only for pathological input, never for a real document.
  const origin = {
    path: 'a.md',
    modifiedAt: '2026-08-02T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
  const excerpt = deriveExcerpt(origin, 'See [the tenancy ADR](docs/adr/0002.md) for the reasoning.');
  assert.equal(excerpt.value, 'See the tenancy ADR for the reasoning.');
});

test('the same file enumerated twice is still a quiet duplicate, not a failure', async () => {
  // The guard must distinguish "one file reached by two walks" from "two files, one identity".
  // Treating the first as an error would make every legitimate re-walk noisy.
  const { pending, failures } = await scan({ 'a.md': { text: '# A\n\nprose' } });
  const { decisions, counts } = await runFor([...pending, ...pending], failures);

  assert.equal(decisions.length, 1);
  assert.equal(counts.failed, 0, 'identical bytes under one identity is not a collision');
});

test('title, folder and tags are bounded too — not just the excerpt', () => {
  // Capping only the excerpt left three unbounded channels: a reviewer measured a 3.2 MB
  // search_docs response from three documents with a ~500 KB title, with the excerpt dutifully
  // clipped to 280. Fencing does not help against volume.
  const origin = {
    declaredTitle: 'T'.repeat(50_000),
    declaredFolder: 'F'.repeat(50_000),
    declaredTags: ['G'.repeat(50_000)],
    path: 'a.md',
    modifiedAt: '2026-07-28T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
  };

  assert.equal(deriveTitle(origin, '').length, MAX_TITLE);
  assert.equal(deriveFolder(origin, 'vault').value.length, MAX_FOLDER);
});

test('a frontmatter tag is capped per tag, through the real scan path', async () => {
  const { pending } = await scan({
    'big.md': { text: `---\ntags: ["${'G'.repeat(5000)}"]\n---\n\n# Doc\n\nprose` },
  });
  assert.equal(pending[0]?.tags.value[0]?.length, MAX_TAG);
});

test('a huge frontmatter title cannot inflate a search payload', async () => {
  const { pending } = await scan({
    'big.md': { text: `---\ntitle: "${'T'.repeat(500_000)}"\n---\n\n# Doc\n\nprose` },
  });
  assert.equal(pending[0]?.title.length, MAX_TITLE);
});

// --- directory ignore rules (D30) --------------------------------------------------------------

test('the node port never walks a vendored directory', async (t) => {
  // The case that motivated this: pointing the ingest at a project root walked 1,233 markdown files
  // in this repo where 77 are the project's own. Written against a REAL temp directory rather than
  // the memory port, because the thing under test is the node walker itself.
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'strata-ignore-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(root, 'README.md'), '# Mine\n');
  for (const dir of ['node_modules', '.git', 'dist', 'coverage']) {
    await mkdir(join(root, dir, 'nested'), { recursive: true });
    await writeFile(join(root, dir, 'nested', 'THEIRS.md'), '# Theirs\n');
  }
  // A nested install, which is the normal shape of a workspace — matched on NAME, not path prefix.
  await mkdir(join(root, 'packages', 'x', 'node_modules'), { recursive: true });
  await writeFile(join(root, 'packages', 'x', 'node_modules', 'DEEP.md'), '# Deep\n');
  await writeFile(join(root, 'packages', 'x', 'KEEP.md'), '# Keep\n');

  const entries = await createNodeFileSystemPort().scan(root);
  const paths = entries.map((e) => e.path).sort();

  assert.deepEqual(paths, ['README.md', 'packages/x/KEEP.md']);
});

test('a dot-directory holding real documentation is still walked', async (t) => {
  // `.claude/` is this project's own documentation. A blanket "skip dotfiles" rule instead of a
  // named list would silently drop exactly the files somebody goes looking for — which is the
  // situation that prompted all of this.
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'strata-dotdir-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude', 'README.md'), '# Cookbook\n');

  const paths = (await createNodeFileSystemPort().scan(root)).map((e) => e.path);
  assert.deepEqual(paths, ['.claude/README.md']);
});

test('the ignore list is injectable, so it is not a hidden global', async (t) => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'strata-inject-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'A.md'), '# A\n');

  // An empty list restores the old behaviour, which is what makes the default a decision rather
  // than an assumption baked into the walker.
  const paths = (await createNodeFileSystemPort([]).scan(root)).map((e) => e.path);
  assert.deepEqual(paths, ['node_modules/A.md']);
});

test('a re-ingest from a differently-named root REFILES the document (D30)', async () => {
  // The bug this catches shipped and bit a real document: `folder` falls back to the scan root's
  // basename for a top-level file, the root name is not in the file, so the hash was identical and
  // the pipeline decided `unchanged`. A README ingested from a staging directory kept that
  // directory's name as its folder, permanently, while the run reported success.
  const file = { path: 'README.md', text: '# Handbook\n\nBody text.\n', modifiedAt: '2026-08-01T00:00:00.000Z' };

  const fromA = await scanMarkdown(createMemoryFileSystemPort([file]), '/strata', SRC);
  const fromB = await scanMarkdown(createMemoryFileSystemPort([file]), '/readme-stage', SRC);

  assert.equal(fromA.pending[0]!.folder.value, 'strata');
  assert.equal(fromB.pending[0]!.folder.value, 'readme-stage');

  // The HASHES ARE EQUAL, deliberately — it is content identity, and it has to survive a move for
  // rename detection to work at all (D20). The drift is caught by comparing the stored folder.
  assert.equal(fromA.pending[0]!.contentHash, fromB.pending[0]!.contentHash);

  const known = {
    'README.md': {
      docId: 'doc-existing' as DocId,
      contentHash: fromB.pending[0]!.contentHash,
      folder: 'readme-stage',
    },
  };
  const { decisions } = await runFor(fromA.pending, fromA.failures, known);
  assert.equal(decisions[0]?.outcome, 'changed', 'the stale folder would never be corrected');
  assert.equal(decisions[0]?.docId, 'doc-existing', 'and it is the same document, not a new one');
});

test('identical bytes under the SAME root are unchanged — idempotence survives', async () => {
  // The other half. If re-ingesting reported `changed` every time, every run would rewrite the whole
  // vault and `unchanged` would never happen again.
  const file = { path: 'docs/a.md', text: '# A\n\nBody.\n', modifiedAt: '2026-08-01T00:00:00.000Z' };
  const scanned = await scanMarkdown(createMemoryFileSystemPort([file]), '/strata', SRC);
  const known = {
    'docs/a.md': {
      docId: 'doc-existing' as DocId,
      contentHash: scanned.pending[0]!.contentHash,
      folder: scanned.pending[0]!.folder.value,
    },
  };
  const { decisions } = await runFor(scanned.pending, scanned.failures, known);
  assert.equal(decisions[0]?.outcome, 'unchanged');
});

test('a move keeps the hash, so renames stay detectable (D20)', async () => {
  // `folder` is deliberately NOT in the hash. Rename detection matches identical hashes across
  // different paths; folding the folder in made every move between folders look like a new
  // document and broke three lifecycle tests — which is how the first attempt at D30 was caught.
  const text = '# Guide\n\nBody.\n';
  const before = await scanMarkdown(
    createMemoryFileSystemPort([{ path: 'docs/guide.md', text, modifiedAt: '2026-08-01T00:00:00.000Z' }]),
    '/strata',
    SRC,
  );
  const after = await scanMarkdown(
    createMemoryFileSystemPort([{ path: 'guides/guide.md', text, modifiedAt: '2026-08-01T00:00:00.000Z' }]),
    '/strata',
    SRC,
  );

  assert.equal(before.pending[0]!.folder.value, 'docs');
  assert.equal(after.pending[0]!.folder.value, 'guides');
  assert.equal(
    before.pending[0]!.contentHash,
    after.pending[0]!.contentHash,
    'a moved file must hash identically or it can never be recognised as a rename',
  );
});

test('source files are skipped silently — they were never documents (D32)', async () => {
  // Harmless while the ingest pointed at a folder of Markdown; absurd once it could be pointed at a
  // repository root, where it produced 147 failure events in one run — one per source file, written
  // to the audit trail and the Import screen, burying the failures that mean something.
  const { pending, failures } = await scan({
    'a.md': { text: '# A\n\nBody.' },
    'index.ts': { text: 'export const x = 1;' },
    'package.json': { text: '{}' },
    'styles.css': { text: 'body{}' },
    'logo.png': { text: 'binary' },
  });

  assert.equal(pending.length, 1);
  assert.deepEqual(failures, [], 'a .ts file is not a document that failed to import');
});

test('a near-miss extension still reports, because silence would look like a drop', async () => {
  // `.mdx` and `.txt` are things somebody reasonably expects to import. Skipping them without a word
  // would read as "seen and quietly discarded", which is the failure mode this whole rule avoids.
  const { pending, failures } = await scan({
    'a.mdx': { text: '# JSX' },
    'notes.txt': { text: 'plain' },
    'index.ts': { text: 'export const x = 1;' },
  });

  assert.equal(pending.length, 0);
  assert.deepEqual(
    failures.map((f) => f.externalId).sort(),
    ['a.mdx', 'notes.txt'],
    'the .ts must not appear, and both near-misses must',
  );
});
