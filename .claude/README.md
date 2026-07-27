# Strata Cookbook

How this repo is set up to be built with Claude Code. Four techniques, layered — each one is a
skill you can read in full, and each has concrete wiring in this directory.

| Technique | What it buys you | Read |
| --- | --- | --- |
| **Model routing** | The right model and reasoning effort per task class, instead of one model doing everything at one cost. | `skills/model-routing/SKILL.md` |
| **Dev loop engineering** | A closed verify loop so changes are proven, not assumed. | `skills/dev-loop/SKILL.md` |
| **Graph-as-context** | Load the *relevant* files by traversing a dependency graph, instead of grepping and hoping. | `skills/context-graph/SKILL.md` |
| **Orchestration** | Fan work across agents deterministically once single-agent turns stop fitting. | `skills/agent-orchestration/SKILL.md` |

Domain skills — the "how Strata specifically works" layer:

| Skill | Use when |
| --- | --- |
| `skills/design-fidelity/SKILL.md` | Building or reviewing any UI against the handoff. |
| `skills/data-contracts/SKILL.md` | Touching `Doc`, `Source`, `ImportEvent`, or anything that serializes them. |
| `skills/mcp-surface/SKILL.md` | Designing or changing what agents can do with the vault. |

## Directory

```
.claude/
  agents/       Subagent definitions. Each pins a model + effort — this is where routing lives.
  skills/       The cookbook. Procedural knowledge, loaded on demand.
  commands/     Slash commands for the recurring loops.
  workflows/    Multi-agent orchestration scripts (opt-in, user-triggered).
  hooks/        Shell hooks wired in settings.json.
  settings.json Shared config: permissions, env, hooks.
```

## The shape of a normal task

1. **Locate** — `/context <node-id>` or delegate to `strata-scout` (Haiku). Cheap, wide.
2. **Plan** — for anything that closes off an alternative, `strata-architect` (Opus, high effort).
   Skip for mechanical work.
3. **Build** — `strata-ui-builder` or the main loop. Sonnet, medium effort.
4. **Verify** — `npm run verify`, then `strata-verifier` (Opus) for anything user-facing or
   security-adjacent. Never self-certify a change you just wrote without running the gate.
5. **Record** — update the context-graph node and, if a decision was made, the decision log.

Steps 1 and 4 are the ones people skip. They are the ones that pay.

## When to reach for orchestration

Not by default. A single agent with the right context beats five agents with vague context. Reach
for `workflows/` when the work is genuinely parallel and independent — auditing 9 components
against a spec, migrating every call site, generating N competing designs to judge. Orchestration
is user-triggered and billed; see the orchestration skill for the opt-in rule.

## Conventions

- Agents return data, not prose. Their final message is a return value.
- Skills are loaded on demand — keep each one under ~200 lines and link rather than duplicate.
- Anything an agent must never do belongs in `settings.json` `permissions.deny`, not in a prompt.
  Prompts are guidance; permissions are enforcement.
