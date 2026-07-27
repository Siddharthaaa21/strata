#!/usr/bin/env bash
# PostToolUse hook (Edit|Write). Fast, file-local guardrails only — the heavy gate is
# `npm run verify`. Exit 2 sends the message back to Claude as actionable feedback.
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

# --- Guardrail 1: design values must come from packages/tokens ------------------
# The token package and the generated stylesheet are where raw OKLCH literals belong.
case "$rel" in
  packages/tokens/*|*/globals.css|design/*) ;;
  *.ts|*.tsx|*.css|*.js|*.jsx)
    if grep -nE 'oklch\(' "$file" >/dev/null 2>&1; then
      echo "Token discipline: $rel contains a raw oklch() literal." >&2
      echo "Design values live in packages/tokens (see CLAUDE.md non-negotiable #2)." >&2
      echo "Add the value there with a citation to the handoff line, then reference the token." >&2
      exit 2
    fi
    ;;
esac

# --- Guardrail 2: context graph must stay in sync -------------------------------
case "$rel" in
  context-graph/nodes/*.md)
    echo "Context-graph node changed. Run 'npm run graph -- --check' before finishing." >&2
    exit 2
    ;;
esac

exit 0
