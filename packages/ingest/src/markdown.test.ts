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

test('externalId is POSIX-separated and NFC-normalized', () => {
  assert.equal(toExternalId('notes\\arch\\a.md'), 'notes/arch/a.md');
  assert.equal(toExternalId('caf' + String.fromCharCode(0x65, 0x301) + '.md'), 'café.md');
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
  const known = { 'a.md': { docId: 'doc-existing' as DocId, contentHash: pending[0]!.contentHash } };
  const { decisions, events } = await runFor(pending, failures, known);

  assert.equal(decisions[0]?.outcome, 'unchanged');
  assert.equal(decisions[0]?.docId, 'doc-existing', 'never mints a second id for the same file');
  assert.equal(events[0]?.status, 'skipped-duplicate');
});

test('edited content is changed, not new — the id survives the edit', async () => {
  const { pending, failures } = await scan({ 'a.md': { text: '# A\n\nedited prose' } });
  const known = { 'a.md': { docId: 'doc-existing' as DocId, contentHash: 'sha256:stale' } };
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
  const { pending, failures } = await scan({
    'a/b.md': { text: '# Alpha\n\nfirst document' },
    'a\\b.md': { text: '# Bravo\n\nsecond, entirely different document' },
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

test('the same file enumerated twice is still a quiet duplicate, not a failure', async () => {
  // The guard must distinguish "one file reached by two walks" from "two files, one identity".
  // Treating the first as an error would make every legitimate re-walk noisy.
  const { pending, failures } = await scan({ 'a.md': { text: '# A\n\nprose' } });
  const { decisions, counts } = await runFor([...pending, ...pending], failures);

  assert.equal(decisions.length, 1);
  assert.equal(counts.failed, 0, 'identical bytes under one identity is not a collision');
});
