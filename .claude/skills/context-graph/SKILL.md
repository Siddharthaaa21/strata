---
name: context-graph
description: Using the Strata context graph to select what to read before starting a task, instead of grepping blindly or loading whole directories. Read at the start of any non-trivial task, when onboarding to an unfamiliar area, or when deciding what a change will break. Covers traversal, node authoring, and the double role the graph plays as both dev tooling and a model of the product itself.
---

# Graph as context mapping

## The problem it solves

The expensive failure in a long task is not a wrong edit — it is starting with the wrong context.
You grep, get forty hits, read six of them, and miss the contract that made the whole approach
invalid. Then you build on it.

`context-graph/nodes/*.md` is a hand-maintained dependency graph of Strata: screens, components,
data contracts, services, decisions, risks, milestones. Edges point **toward what you must
understand first**. Traversing it turns "what should I read?" from a judgement call into a query.

## Traversal

```bash
npm run graph -- --subgraph screen-reader --depth 2
```

Prints the node, its transitive dependencies to depth 2, and the `spec:` path each one points at.
Read those specs and you have the context for the task — and, just as usefully, a bounded reason
to stop reading.

```bash
npm run graph -- --impact contract-doc    # reverse edges: what breaks if I change this
npm run graph -- --check                  # integrity; part of `npm run verify`
npm run graph -- --mermaid                # writes context-graph/graph.mmd for a visual
```

`--impact` before touching anything in `packages/core`. It is the cheapest way to find out that
a "small" shape change has nine consumers.

## The workflow

1. **Before starting** — `--subgraph <node>` on the thing you are changing. Read the specs it
   names. Do not grep first; grep is for when the graph has no node for what you need, which is
   itself a finding worth reporting.
2. **Before changing a contract** — `--impact <node>`. Every consumer it lists gets updated in
   the same change or gets an explicit follow-up.
3. **After the change** — update the node. Status, new edges, new spec line. `npm run verify`
   fails on dangling edges, so this is enforced rather than remembered.

## Authoring nodes

Format and rules live in `.claude/agents/strata-cartographer.md`. The three that matter:

- **Edge direction is "needs to know about"**, not "calls" and not "contains". `screen-library`
  depends on `contract-doc` because you cannot build the screen without the shape.
- **Nodes persist; status changes.** Never delete a completed node — you lose the edges pointing
  at it.
- **Under four sentences.** The node is an index entry. Detail belongs in the `spec:` target,
  which is a real file and line.

Add a node when you add a screen, a contract, a service, a decision that closes off an
alternative, or a risk. Not for every component — a graph that models every file is a second
copy of the filesystem and rots at the same rate.

## Why this repo in particular

Two reasons beyond the usual.

**The handoff is the spec and it is prose.** The design values live in a README and an HTML
prototype, not in code. Without `spec:` pointers, every task starts by re-reading a 70-line
README to find the six lines that matter. The graph makes that a lookup.

**The graph is a rehearsal of the product.** Strata's whole premise is turning unstructured
Markdown into a structured, agent-queryable knowledge base with typed relationships. The context
graph is that same idea applied to the repo — nodes with metadata, typed edges, traversal by
relevance. When you find the retrieval model here awkward, that is direct signal about the
product's own retrieval model. Take the lesson across.

## Limits

- It is hand-maintained. It is accurate because people update it, not because it is derived. A
  node claiming `status: done` is a claim; check the code.
- It maps *understanding* dependencies, not the import graph. Do not use it for dead-code
  analysis or build ordering.
- It does not replace reading the code. It tells you which code to read.

## Related

- `.claude/agents/strata-cartographer.md` — maintains it.
- `scripts/graph.mjs` — the implementation; read it if a query is not doing what you expect.
