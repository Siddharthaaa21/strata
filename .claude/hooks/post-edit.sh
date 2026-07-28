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

# --- Guardrail 1b: Scope may only be minted from packages/auth ------------------
# ADR 0002: mintScope is the only way to construct a Scope. Importing the subpath
# outside packages/auth defeats the "minted from one place" guarantee the same way an
# exception to the oklch() rule above would.
case "$rel" in
  packages/auth/*) ;;
  *.ts|*.tsx|*.js|*.jsx)
    if grep -nE "@strata/core/scope-internal" "$file" >/dev/null 2>&1; then
      echo "Scope discipline: $rel imports @strata/core/scope-internal." >&2
      echo "mintScope is minted from packages/auth only (see docs/adr/0002-tenancy-workspace-scope.md)." >&2
      echo "Take a Scope as a parameter instead of minting one here." >&2
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

# --- Guardrail 3: graph-worthy code needs a node kept current, continuously -----
# CLAUDE.md: "When you add a screen, contract, service, or make a decision that
# constrains future work, add or update its node in the same change." This fires on
# every edit to a graph-worthy path, for as long as the agent keeps editing, until a
# context-graph/nodes file also shows as changed in this working tree.
case "$rel" in
  apps/web/src/app/*|apps/web/src/components/*|packages/core/src/*|packages/ingest/src/*|apps/mcp/src/*|docs/adr/*)
    if [ -z "$(git -C "$repo_root" status --porcelain -- context-graph/nodes 2>/dev/null)" ]; then
      echo "Graph-worthy file changed ($rel) with no context-graph/nodes edit yet this session." >&2
      echo "CLAUDE.md non-negotiable: add or update its node (screen/contract/service/decision) in the same change." >&2
      echo "Add/update context-graph/nodes/<id>.md now (or delegate to strata-cartographer) before finishing." >&2
      exit 2
    fi
    ;;
esac

exit 0
