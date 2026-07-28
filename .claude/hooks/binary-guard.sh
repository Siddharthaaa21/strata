#!/usr/bin/env bash
# PostToolUse hook (Edit|Write). Catches a specific, otherwise-invisible failure mode:
# a NUL byte (or other control byte) landing in a text source file. This has one of two
# causes in practice — a concurrent writer racing this edit on the same path, or a stray
# escape typed as a literal instead of `\uXXXX` — and both are worth failing loudly on,
# because `git diff` silently reports the file as "Binary files differ" from then on and
# the corruption stops showing up in review. See docs/plan/05-decision-log.md D10.
set -uo pipefail

payload="$(cat)"
file="$(printf '%s' "$payload" | node -e '
  let s = "";
  process.stdin.on("data", d => (s += d));
  process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(s)?.tool_input?.file_path ?? ""); }
    catch { process.stdout.write(""); }
  });
' 2>/dev/null)"

[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
rel="${file#"$repo_root"/}"

case "$rel" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.md|*.css|*.yml|*.yaml)
    if LC_ALL=C grep -qP '\x00' "$file" 2>/dev/null; then
      echo "Binary guard: $rel now contains a NUL byte." >&2
      echo "This usually means a concurrent writer touched this exact file mid-edit, or a" >&2
      echo "literal control character was typed instead of an escape (e.g. \\u0000)." >&2
      echo "git diff will silently show this file as binary from now on, hiding future" >&2
      echo "changes to it from review. Re-check the file's current content before re-saving," >&2
      echo "and if another agent/session is also editing this path, isolate with a git" >&2
      echo "worktree instead of sharing this working tree (see CLAUDE.md, agent-orchestration" >&2
      echo "SKILL.md)." >&2
      exit 2
    fi
    ;;
esac

exit 0
