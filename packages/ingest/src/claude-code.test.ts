/**
 * The Claude Code transcript adapter.
 *
 * `parseTranscript` is pure and takes a string, so every case that matters — a truncated final line,
 * the same path written three times, an edit after a write, a file written outside the project — is
 * reachable without touching `~/.claude`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, scanClaudeCode, DOCUMENT_EXTENSIONS } from './claude-code.ts';
import type { SourceId } from '@strata/core';

const SRC = 'src-claude-code' as SourceId;
const CWD = '/Users/x/Desktop/portfolio';

/** One transcript record carrying a single tool call. */
function record(
  name: string,
  input: Record<string, unknown>,
  over: { at?: string; cwd?: string; session?: string } = {},
): string {
  return JSON.stringify({
    timestamp: over.at ?? '2026-07-19T10:00:00.000Z',
    cwd: over.cwd ?? CWD,
    sessionId: over.session ?? 'sess-1',
    message: { content: [{ type: 'tool_use', name, input }] },
  });
}

test('recovers a written document, keyed by its path within the project', () => {
  const jsonl = record('Write', { file_path: `${CWD}/README.md`, content: '# Hi\n' });
  const files = parseTranscript(jsonl);

  assert.equal(files.length, 1);
  assert.equal(files[0]!.displayPath, 'portfolio/README.md');
  assert.equal(files[0]!.content, '# Hi\n');
  assert.equal(files[0]!.at, '2026-07-19T10:00:00.000Z');
});

test('the LAST write of a path wins — not five copies of one README', () => {
  // A file written repeatedly in one session is one document with a history, and only the newest was
  // true when the session ended. Emitting each write would mean searching for a README and finding
  // four wrong answers ranked above the right one.
  const jsonl = [
    record('Write', { file_path: `${CWD}/README.md`, content: 'v1' }, { at: '2026-07-19T10:00:00.000Z' }),
    record('Write', { file_path: `${CWD}/README.md`, content: 'v2' }, { at: '2026-07-19T11:00:00.000Z' }),
    record('Write', { file_path: `${CWD}/README.md`, content: 'v3' }, { at: '2026-07-19T12:00:00.000Z' }),
  ].join('\n');

  const files = parseTranscript(jsonl);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.content, 'v3');
});

test('edits AFTER the last write are counted, because they cannot be applied', () => {
  // An Edit carries a replacement fragment, not the resulting file. Pretending otherwise would file
  // a confidently wrong document; counting is the honest alternative.
  const jsonl = [
    record('Write', { file_path: `${CWD}/README.md`, content: 'v1' }),
    record('Edit', { file_path: `${CWD}/README.md`, old_string: 'a', new_string: 'b' }),
    record('Edit', { file_path: `${CWD}/README.md`, old_string: 'c', new_string: 'd' }),
  ].join('\n');

  assert.equal(parseTranscript(jsonl)[0]!.laterEdits, 2);
});

test('a rewrite resets the edit count — earlier edits are already in that content', () => {
  const jsonl = [
    record('Write', { file_path: `${CWD}/README.md`, content: 'v1' }),
    record('Edit', { file_path: `${CWD}/README.md`, old_string: 'a', new_string: 'b' }),
    record('Write', { file_path: `${CWD}/README.md`, content: 'v2' }, { at: '2026-07-19T13:00:00.000Z' }),
  ].join('\n');

  const file = parseTranscript(jsonl)[0]!;
  assert.equal(file.content, 'v2');
  assert.equal(file.laterEdits, 0);
});

test('an edit to a file never written in this transcript is ignored, not counted', () => {
  // Editing a file that already existed on disk says nothing about a document we hold.
  const jsonl = record('Edit', { file_path: `${CWD}/OTHER.md`, old_string: 'a', new_string: 'b' });
  assert.deepEqual(parseTranscript(jsonl), []);
});

test('source files are not documents', () => {
  // Claude writes far more TypeScript than prose, and the code already lives in a repository under
  // version control. What is not recoverable elsewhere is the prose.
  const jsonl = [
    record('Write', { file_path: `${CWD}/src/index.ts`, content: 'export const x = 1;' }),
    record('Write', { file_path: `${CWD}/package.json`, content: '{}' }),
    record('Write', { file_path: `${CWD}/NOTES.md`, content: '# Notes\n' }),
  ].join('\n');

  const files = parseTranscript(jsonl);
  assert.deepEqual(files.map((f) => f.displayPath), ['portfolio/NOTES.md']);
});

test('a file written outside the project is kept, under its own prefix', () => {
  // Claude Code writes skills and settings outside the session cwd. Dropping them would reproduce
  // exactly the problem this adapter exists to fix — a document that exists and cannot be found.
  const jsonl = record('Write', {
    file_path: `${process.env['HOME'] ?? '/Users/x'}/.claude/skills/thing/SKILL.md`,
    content: '# Skill\n',
  });
  assert.equal(parseTranscript(jsonl)[0]!.displayPath, 'outside-project/.claude/skills/thing/SKILL.md');
});

test('paths are normalized: .. and duplicate slashes collapse, traversals leave the project (F2)', () => {
  const jsonl = [
    record('Write', { file_path: `${CWD}/docs/../README.md`, content: '# Root\n' }),
    record('Write', { file_path: `${CWD}//sub//doc.md`, content: '# Sub\n' }),
    record('Write', { file_path: `${CWD}/../../etc/passwd.md`, content: '# Secret\n' }),
  ].join('\n');

  const files = parseTranscript(jsonl);
  assert.equal(files.length, 3);
  assert.equal(files[0]!.displayPath, 'portfolio/README.md');
  assert.equal(files[1]!.displayPath, 'portfolio/sub/doc.md');
  assert.match(files[2]!.displayPath, /^outside-project\//);
  assert.ok(!files[2]!.displayPath.startsWith('portfolio/'));
});

test('a truncated final line does not lose the records before it', () => {
  // A transcript being appended to right now ends mid-line. This is the ordinary state of an active
  // session, not an edge case.
  const jsonl =
    record('Write', { file_path: `${CWD}/A.md`, content: '# A\n' }) +
    '\n' +
    '{"timestamp":"2026-07-19T10:0';

  assert.equal(parseTranscript(jsonl).length, 1);
});

test('malformed records are skipped without throwing', () => {
  const jsonl = [
    'null',
    '"a string"',
    '{}',
    '{"message":{}}',
    '{"message":{"content":"not an array"}}',
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Write' }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'x.md' } }] } }),
    record('Write', { file_path: `${CWD}/GOOD.md`, content: '# Good\n' }),
  ].join('\n');

  const files = parseTranscript(jsonl);
  assert.deepEqual(files.map((f) => f.displayPath), ['portfolio/GOOD.md']);
});

test('an empty write is not a document', () => {
  const jsonl = record('Write', { file_path: `${CWD}/EMPTY.md`, content: '' });
  assert.deepEqual(parseTranscript(jsonl), []);
});

test('across transcripts, the newest write of a path wins', async () => {
  // Sessions overlap and interleave; the same file can be written in two of them.
  const older = record('Write', { file_path: `${CWD}/README.md`, content: '# Older\n' }, { at: '2026-07-01T00:00:00.000Z' });
  const newer = record('Write', { file_path: `${CWD}/README.md`, content: '# Newer\n' }, { at: '2026-08-01T00:00:00.000Z' });

  const result = await scanClaudeCode(
    [
      { project: 'p', jsonl: newer },
      { project: 'p', jsonl: older },
    ],
    SRC,
  );

  assert.equal(result.recovered, 1);
  assert.equal(result.pending.length, 1);
  assert.match(result.pending[0]!.body, /Newer/);
});

test('a stale document says so in its own body', async () => {
  // A recovered file that admits it predates later edits is useful. One that does not is a trap.
  const jsonl = [
    record('Write', { file_path: `${CWD}/README.md`, content: '# Doc\n\nBody.\n' }),
    record('Edit', { file_path: `${CWD}/README.md`, old_string: 'a', new_string: 'b' }),
  ].join('\n');

  const result = await scanClaudeCode([{ project: 'p', jsonl }], SRC);
  assert.equal(result.stale, 1);
  assert.match(result.pending[0]!.body, /1 edit\(s\) were made to this file after this version/);
});

test('recovered content goes through the Markdown adapter, not around it', async () => {
  // Model-generated text is R2's threat in its purest form. Title, folder and excerpt must come from
  // the same derivation everything else uses.
  const jsonl = record('Write', {
    file_path: `${CWD}/docs/guide.md`,
    content: '---\ntitle: Declared\ntags: [alpha]\n---\n\n# Ignored\n\nBody.\n',
  });

  const result = await scanClaudeCode([{ project: 'p', jsonl }], SRC);
  const doc = result.pending[0]!;
  assert.equal(doc.title, 'Declared');
  assert.deepEqual([...doc.tags.value], ['alpha']);
  assert.equal(doc.externalId, 'portfolio/docs/guide.md');
  assert.equal(doc.folder.value, 'portfolio/docs');
});

test('the extension list is injectable', () => {
  const jsonl = record('Write', { file_path: `${CWD}/a.json`, content: '{}' });
  assert.equal(parseTranscript(jsonl).length, 0);
  assert.equal(parseTranscript(jsonl, { extensions: ['.json'] }).length, 1);
  assert.ok(DOCUMENT_EXTENSIONS.includes('.md'));
});
