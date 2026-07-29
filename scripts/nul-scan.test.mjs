import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, enumerateFiles, TEXT_EXTENSIONS } from './nul-scan.mjs';

const NUL = String.fromCharCode(0);

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nul-scan-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scan finds a NUL and reports its line', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'bad.ts'), `const a = 1;\nconst b = "x${NUL}y";\n`);
    const findings = scan(['bad.ts'], dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].count, 1);
    assert.deepEqual(findings[0].lines, [2], 'NUL is on line 2');
  });
});

test('scan counts multiple NULs and dedupes line numbers', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'bad.ts'), `a\nb${NUL}c${NUL}d\ne${NUL}\n`);
    const [finding] = scan(['bad.ts'], dir);
    assert.equal(finding.count, 3);
    assert.deepEqual(finding.lines, [2, 3]);
  });
});

test('scan passes a clean file, including one containing the escape as text', () => {
  withTempDir((dir) => {
    // The correct form of what the corrupted files got wrong: six literal characters, not a byte.
    writeFileSync(join(dir, 'good.ts'), 'const sep = "\\u0000";\n');
    assert.deepEqual(scan(['good.ts'], dir), []);
  });
});

test('scan ignores a file it cannot read rather than throwing', () => {
  withTempDir((dir) => {
    assert.deepEqual(scan(['does-not-exist.ts'], dir), []);
  });
});

test('enumerateFiles returns only text extensions and excludes ignored paths', () => {
  const files = enumerateFiles();
  assert.ok(files.length > 0, 'expected to enumerate files in this repo');
  for (const f of files) {
    assert.ok(
      TEXT_EXTENSIONS.has(f.slice(f.lastIndexOf('.'))),
      `${f} is not a text extension`,
    );
  }
  assert.ok(
    !files.some((f) => f.startsWith('.claude/worktrees/')),
    'agent worktrees must be excluded — they are ignored and run their own gate',
  );
  assert.ok(
    !files.some((f) => f.includes('node_modules/')),
    'node_modules must be excluded',
  );
});

test('this repo is free of NUL corruption', () => {
  const findings = scan(enumerateFiles());
  assert.deepEqual(
    findings,
    [],
    `NUL corruption present:\n${findings.map((f) => `  ${f.file} line(s) ${f.lines.join(', ')}`).join('\n')}`,
  );
});
