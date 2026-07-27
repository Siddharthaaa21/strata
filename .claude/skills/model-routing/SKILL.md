---
name: model-routing
description: How Strata routes work to the right model and reasoning effort per task class instead of running everything on one model. Read before delegating, before writing a workflow, and when a task feels mismatched to its cost. Covers the routing table, the real mechanism behind "automatic" switching, and the failure modes of routing wrong in each direction.
---

# Model routing

## The mechanism, honestly

Claude Code does not switch the main-loop model on its own. The main loop runs whatever the user
selected with `/model` and only the user can change that. What *is* automatic is **routing by
delegation**: a subagent runs on the model pinned in its own definition, so handing a task to
`strata-scout` runs it on Haiku regardless of what the main loop is using.

Three places a model gets chosen:

| Where | How | Scope |
| --- | --- | --- |
| Agent definition | `model:` in `.claude/agents/*.md` frontmatter | Every invocation of that agent |
| `Agent` tool call | `model` parameter | One invocation, overrides the definition |
| `Workflow` script | `agent(prompt, { model, effort })` | One step in an orchestration |

So the routing table below is not advice you have to remember — it is compiled into the agent
definitions. Delegating correctly *is* routing correctly.

## The table

| Task class | Route to | Model | Effort | Why |
| --- | --- | --- | --- | --- |
| Locate, inventory, list call sites | `strata-scout` | Haiku | low | Wide, mechanical, verifiable. Reasoning adds nothing. |
| Context-graph maintenance | `strata-cartographer` | Haiku | low | Rule-following against a rigid format. |
| Build a component from a settled spec | `strata-ui-builder` | Sonnet | medium | Judgement needed, but the hard call is already made. |
| Connector / normalizer work | `strata-ingest-engineer` | Sonnet | medium | Real engineering, bounded by a known contract. |
| Fidelity audit vs handoff | `strata-fidelity-auditor` | Sonnet | medium | Comparison across many values; needs care, not depth. |
| Data contracts, MCP surface, storage, auth | `strata-architect` | Opus | high | Expensive to get wrong; migration cost is the tell. |
| Adversarial review, security, tenancy | `strata-verifier` | Opus | high | Must construct concrete failures, not plausible ones. |

Everything else stays in the main loop.

## How to classify

One question decides it: **what does being wrong cost?**

- Wrong and obvious immediately (a grep missed a file) → Haiku.
- Wrong and caught by the verify gate (a component compiles but looks off) → Sonnet.
- Wrong and discovered in three months by everyone downstream (a `Doc` shape, an MCP tool
  signature, a tenancy check) → Opus.

Token cost is a rounding error next to a bad contract. Do not route by size of task; route by
cost of error.

## Failure modes

**Routing too low.** The classic: sending schema design to a cheap model because the prompt was
short. Short prompts hide expensive decisions. If the output will be imported by other code,
route up.

**Routing too high.** Running Opus to list files. Wasteful, but the real damage is different —
a deep model given a shallow task invents complexity to justify itself. You get an architecture
review when you asked where a file lives.

**Not routing at all.** Doing everything in the main loop is the most common failure. It burns
the main context on grep output that a Haiku agent could have returned as ten lines. The main
loop's context is the scarce resource; protect it by delegating retrieval.

**Routing without context.** A subagent starts with none of your conversation. A delegation that
says "fix the thing we discussed" gets a confidently wrong answer. Every delegation must be
self-contained: what to do, which files, what "done" means.

## Effort

`effort` is orthogonal to model and set per `Workflow` step (`{ effort: 'low' | 'medium' |
'high' | 'xhigh' | 'max' }`). Raise it for the verify and judge stages of an orchestration —
those are where a shallow pass produces confident garbage. Lower it for mechanical fan-out.
Omit it to inherit the session default.

## Related

- `.claude/skills/agent-orchestration/SKILL.md` — routing across many agents at once.
- `.claude/README.md` — the shape of a normal task.
