---
name: agent-orchestration
description: When and how to fan Strata work across multiple agents — the opt-in rule, pipeline vs barrier, verification patterns, and the workflows already written for this repo. Read before writing or running any multi-agent workflow, and when deciding whether a task actually needs one.
---

# Agent orchestration

## The opt-in rule (read this first)

Workflows can spawn dozens of agents and cost a lot. **Never start one on your own judgement.**
It requires explicit opt-in: the user says "use a workflow" / "run a workflow" / "fan out agents"
in their own words, includes the `ultracode` keyword, or invokes a command that calls `Workflow`.

A task merely *benefiting* from parallelism does not count. If you think one is warranted, say so
in a sentence, give a rough cost, and ask.

## When it is actually the right tool

Orchestration wins on **breadth**, not difficulty. One agent with good context beats five with
vague context, every time.

Good fits in this repo:

- Auditing every implemented component against the handoff at once (independent, uniform).
- Migrating every consumer after a `packages/core` shape change (independent, mechanical, and
  `--impact` already gave you the exact list).
- Generating three competing designs for the MCP tool surface and judging them (diversity is the
  point).
- Sweeping all connector adapters for a class of bug.

Bad fits:

- Anything where step two depends on a decision made in step one.
- Anything you have not scoped yet — scout inline first, *then* fan out over the work list. This
  hybrid is usually the right shape: discover with one cheap agent, parallelize over the result.

## Pipeline by default

`pipeline(items, stage1, stage2)` runs each item through all stages independently — item A can be
in stage 2 while item B is still in stage 1. `parallel(...)` is a **barrier**: it waits for
everything before continuing.

Use a barrier only when a stage genuinely needs cross-item context: deduping across all findings,
early-exiting when the total is zero, or a prompt that compares one finding against the others.
"I need to flatten the array first" is not a reason — do that inside a pipeline stage.

## Verification patterns

The value of orchestration is not doing more work, it is **checking work independently**.

- **Adversarial verify.** Spawn N skeptics per finding, each prompted to *refute* it, defaulting
  to refuted when uncertain. Keep the finding only if a majority fails to refute. This is what
  stops plausible-but-wrong findings from shipping.
- **Perspective-diverse verify.** When something can fail multiple ways, give each verifier a
  different lens — correctness, tenancy, does-it-actually-reproduce — rather than N identical
  refuters. Diversity catches what redundancy cannot.
- **Loop until dry.** For unknown-size discovery, keep running finders until K consecutive rounds
  surface nothing new. Dedupe against everything *seen*, not everything *confirmed* — otherwise
  rejected findings reappear each round and it never terminates.
- **No silent caps.** If you bound coverage (top-N, sampling, no retry), `log()` what was dropped.
  Silent truncation reads as complete coverage.

## Workflows in this repo

| Script | Does | Opt-in |
| --- | --- | --- |
| `workflows/fidelity-audit.js` | One auditor per component against the handoff, then adversarial verify of each finding. | user-triggered |
| `workflows/contract-migration.js` | Scout consumers of a `packages/core` shape, migrate each in isolation, verify. | user-triggered |
| `workflows/design-panel.js` | N independent designs for one decision, judged, synthesized. | user-triggered |

Run with `Workflow({ scriptPath: ".claude/workflows/<name>.js", args: ... })`. Each persists its
script and returns a `runId` — edit the file and re-invoke with `resumeFromRunId` to re-run only
what changed.

## Toward a development orchestrator

The long-term goal is an orchestrator that drives milestones rather than single tasks. The
sequencing that makes that safe, in order:

1. **Contracts first.** Parallel agents editing overlapping code without a settled
   `packages/core` produce merge chaos. `docs/plan/03-data-contracts.md` must be real first.
2. **A gate that actually gates.** `npm run verify` must be trustworthy before agents run
   unattended, or you are parallelizing the production of unverified changes.
3. **Isolation for anything that writes.** Use `isolation: 'worktree'` when agents mutate files
   in parallel. It costs setup time and disk; only pay it when writes genuinely overlap.
4. **A judge that is not the builder.** The verify stage must run on a different agent, ideally
   a stronger model, and must be prompted to refute rather than approve.

Do not build the orchestrator before 1 and 2. An orchestrator over an untrustworthy gate is a
machine for generating confident, unverified work.

## Related

- `.claude/skills/model-routing/SKILL.md` — per-stage model and effort selection.
- `.claude/skills/dev-loop/SKILL.md` — the gate every stage reports against.
