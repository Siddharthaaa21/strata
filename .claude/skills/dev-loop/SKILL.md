---
name: dev-loop
description: The closed verify loop for Strata — how a change gets proven rather than assumed. Read before starting implementation work, when deciding what "done" means, or when tempted to report success without running the gate. Covers the gate, the three loop tiers, hook-enforced guardrails, and what to do when the loop is slow or absent.
---

# Dev loop engineering

A development loop is the shortest path from "I changed something" to "I know whether it works."
Everything here exists to keep that path short and to make skipping it hard.

## The gate

```bash
npm run verify   # typecheck (all workspaces) + tests + context-graph integrity
```

This is the definition of done for a code change. Not "it should work." Not "the types look
right." Run it, read the output, report what it actually said.

If it fails and you cannot fix it in two attempts, stop and surface the verbatim failure. A
change reported as done on a red gate costs more than a change reported as blocked.

## Three tiers

Match the loop to what you are actually uncertain about.

| Tier | Cost | Use for | Command |
| --- | --- | --- | --- |
| **Guardrail** | instant | Catching mechanical mistakes at the moment they are made | automatic (hook) |
| **Gate** | seconds | Every change, before reporting | `npm run verify` |
| **Judgement** | minutes | UI fidelity, security, contract changes | delegate to an auditor agent |

The mistake is using tier 3 for things tier 1 catches free, or tier 1 for things only tier 3 can
see. A hook cannot tell you the card radius is wrong; a fidelity auditor should not be spending
its attention on a typo the typechecker would have caught.

## Tier 1: guardrails (already wired)

`.claude/hooks/post-edit.sh` runs on every `Edit`/`Write` and blocks on:

- **Raw `oklch()` outside `packages/tokens`** — enforces the token discipline from `CLAUDE.md`.
  Exits 2, so the message comes back as actionable feedback and gets fixed in the same turn.
- **Context-graph node edits** — reminds you to re-run the integrity check.

Guardrails are enforcement, not advice. That is the point: a rule stated only in a prompt is a
suggestion, a rule in `settings.json` or a hook is a constraint. When you find yourself
repeatedly reminding an agent of the same rule, promote it from prompt to hook.

Optional additions worth turning on once the codebase is real, in `settings.json`:

```jsonc
// Stop hook — runs the full gate when a turn ends. Catches "forgot to verify".
// Costs a few seconds per turn; enable once the test suite is worth running.
"Stop": [{ "hooks": [{ "type": "command", "command": "npm run verify" }] }]
```

## Tier 2: the gate

`npm run verify` is composed of independently runnable parts. Run the narrow one while iterating,
the full one before reporting:

```bash
npm run typecheck            # fastest signal, catches most of it
npm run test                 # node --test, no framework
npm run graph -- --check     # dangling edges, bad spec paths, cycles
```

## Tier 3: judgement loops

Some things no script can check. Route those to an agent that is prompted to disagree with you:

- UI against the handoff → `strata-fidelity-auditor`
- Anything touching ingestion, storage, MCP, or user data → `strata-verifier`

Run these *after* the gate is green, not instead of it. They are expensive and their attention is
wasted on problems a typechecker finds.

## When there is no loop yet

This repo is pre-implementation, so parts of the loop do not exist. That is a known state, not an
excuse. The rule: **if you are about to build something you cannot verify, build the verification
first.** Concretely —

- Building an ingest adapter? Write the fixture test first: recorded payload in, expected `Doc`
  out. No live network in tests.
- Building a screen? Get it rendering with fixture data before wiring anything real, so you have
  something to audit against the handoff.
- Building an MCP tool? A schema test that pins the tool signature is the loop; the signature is
  the contract agents depend on.

## Anti-patterns

- **Reporting done without running the gate.** The single most damaging habit. If the gate did
  not run, say "implemented, not verified."
- **Re-reading a file you just edited to check the edit landed.** It landed — the tool would have
  errored. This wastes context.
- **Fixing the test to match the code.** If a test fails, first establish which side is wrong.
- **Widening the loop to hide a failure.** Deleting a strict tsconfig flag to make typecheck pass
  is not a fix.

## Related

- `.claude/skills/model-routing/SKILL.md` — who runs which tier.
- `CLAUDE.md` — the non-negotiables the guardrails enforce.
