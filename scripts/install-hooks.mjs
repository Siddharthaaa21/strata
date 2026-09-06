#!/usr/bin/env node
// Installs this repo's git hooks.
//
//   npm run hooks:install     copy scripts/hooks/* into .git/hooks/
//   npm run hooks:install -- --uninstall
//
// `.git/hooks/` is not tracked by git, so a hook that lives only there exists on exactly one
// machine. The source of truth is `scripts/hooks/`, which IS tracked; this copies it into place.
//
// REFUSES TO OVERWRITE a hook it did not write. Silently replacing somebody's existing post-commit
// hook — theirs might sign commits or run a linter — is a good way to make a tool untrustworthy the
// first time it costs someone work.

import { readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'scripts', 'hooks');

/** Written into every hook we install, so we can recognise our own on a later run. */
const MARKER = 'strata-managed-hook';

function gitDir() {
  try {
    // `--git-common-dir` rather than `--git-dir`: in a worktree the two differ, and hooks live with
    // the common one. Installing into a worktree's private dir means the hook never fires elsewhere.
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return resolve(ROOT, out);
  } catch {
    return undefined;
  }
}

const dir = gitDir();
if (dir === undefined || !existsSync(dir)) {
  console.error('Not a git repository — nothing to install.');
  process.exit(0);
}

const hooksDir = join(dir, 'hooks');
if (!existsSync(hooksDir)) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(hooksDir, { recursive: true });
}

const uninstall = process.argv.includes('--uninstall');
let skipped = 0;

for (const name of readdirSync(SOURCE)) {
  const target = join(hooksDir, name);
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  const ours = existing !== undefined && existing.includes(MARKER);

  if (uninstall) {
    if (ours) {
      unlinkSync(target);
      console.log(`removed  ${name}`);
    } else if (existing !== undefined) {
      console.log(`kept     ${name} (not ours — left alone)`);
      skipped += 1;
    }
    continue;
  }

  if (existing !== undefined && !ours) {
    // Theirs. Say so loudly and do nothing: a hook that quietly ate someone's commit signing is
    // worse than a hook that did not install.
    console.error(`SKIPPED  ${name} — a hook already exists here and this tool did not write it.`);
    console.error(`         Inspect ${target} and merge by hand if you want both.`);
    skipped += 1;
    continue;
  }

  const body = readFileSync(join(SOURCE, name), 'utf8').replace(
    '#!/bin/sh\n',
    `#!/bin/sh\n# ${MARKER} — installed by \`npm run hooks:install\`; edit scripts/hooks/${name} instead.\n`,
  );
  writeFileSync(target, body);
  chmodSync(target, 0o755);
  console.log(`installed ${name}`);
}

if (!uninstall) {
  console.log('');
  console.log('Markdown you commit is now ingested automatically, in the background.');
  console.log('  log      .git/strata-ingest.log');
  console.log('  skip one STRATA_INGEST_HOOK=0 git commit ...');
  console.log('  remove   npm run hooks:install -- --uninstall');
}

if (skipped > 0 && !uninstall) process.exitCode = 1;
