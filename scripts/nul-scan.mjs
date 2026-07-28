#!/usr/bin/env node
// Repo-wide NUL-byte scan. Part of `npm run verify`.
//
// Defense in depth behind `.claude/hooks/binary-guard.sh`. The hook only fires on edits made
// through Claude Code's Edit/Write tools; a file corrupted by anything else — a concurrent
// writer, an editor, a script, a bad merge — reaches the tree unnoticed. That is how commit
// 5fe48a4 put `packages/core/src/index.ts` into git as `Bin 4369 -> 9200`, after which every
// change to it was invisible in review until someone noticed by hand.
//
// The usual cause is a unicode escape typed as a literal byte rather than as the characters of
// the escape sequence. Runtime behavior is often identical, which is exactly why it survives:
// tests pass, types check, and only `git diff` quietly gives up.
//
//   node scripts/nul-scan.mjs           scan and exit non-zero on any hit
//   node scripts/nul-scan.mjs --list    print every file scanned, then scan

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Text sources where a NUL is always corruption. Mirrors binary-guard.sh's case list. */
export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.css', '.yml', '.yaml', '.sh', '.html', '.txt',
]);

/**
 * Files git knows about: tracked, plus untracked-but-not-ignored.
 *
 * Deliberately not a filesystem walk. Using git's own view means ignored paths are excluded for
 * free — node_modules, .next, and `.claude/worktrees/` (which holds full checkouts that run their
 * own gate). Untracked-but-not-ignored is included on purpose: the corruption this scan was
 * written for was found in an ADR that had not been committed yet.
 */
export function enumerateFiles(root = ROOT) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean).filter((f) => TEXT_EXTENSIONS.has(extname(f)));
}

/** @returns {{file: string, count: number, lines: number[]}[]} */
export function scan(files, root = ROOT) {
  const findings = [];
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(resolve(root, file));
    } catch {
      continue; // raced deletion, or a broken symlink — not this check's problem
    }
    if (!buf.includes(0)) continue;

    const lines = [];
    let line = 1;
    let count = 0;
    for (const byte of buf) {
      if (byte === 0) {
        count++;
        if (!lines.includes(line)) lines.push(line);
      } else if (byte === 10) {
        line++;
      }
    }
    findings.push({ file, count, lines });
  }
  return findings;
}

function main() {
  const files = enumerateFiles();
  if (process.argv.includes('--list')) {
    for (const f of files) console.log(`  ${f}`);
  }

  const findings = scan(files);
  if (!findings.length) {
    console.log(`ok — ${files.length} text files scanned, no NUL bytes`);
    return;
  }

  for (const { file, count, lines } of findings) {
    console.error(`ERROR ${file}: ${count} NUL byte(s) on line(s) ${lines.join(', ')}`);
  }
  console.error(
    `\n${findings.length} corrupt file(s). A NUL in a text source makes git treat the file as` +
      `\nbinary, hiding every later change to it from review. This is usually a unicode escape` +
      `\ntyped as a literal byte — replace it with the characters of the escape sequence.`,
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
