# Context graph

A hand-maintained map of Strata: screens, components, contracts, services, decisions, risks.
Edges point **toward what you must understand first** — `a depends_on b` means read `b` before `a`.

Its job is to answer "what should I read before starting this task?" as a query instead of a
judgement call, and to give a defensible reason to *stop* reading.

```bash
npm run graph -- --subgraph screen-reader --depth 2   # what to read first
npm run graph -- --impact contract-doc                # what breaks if I change this
npm run graph -- --status                             # progress and blockers
npm run graph -- --check                              # integrity — part of `npm run verify`
npm run graph -- --mermaid                            # writes graph.mmd
npm run graph                                         # writes graph.json
```

`graph.json` and `graph.mmd` are generated and gitignored. `nodes/` is the source of truth.

## Node format

```markdown
---
id: screen-library          # must equal the filename stem
kind: screen                # screen|component|contract|service|token|decision|risk|milestone
title: Library screen
status: planned             # planned|in-progress|done|blocked
owner: web                  # web|mcp|ingest|core|design|product
spec: design/handoff/README.md:14
depends_on: [contract-doc, comp-doc-card]
---

Two to four sentences: what this is, and the one thing someone must know before touching it.
```

`spec:` must point at a real file — `--check` fails otherwise, and that check runs in
`npm run verify`.

## Rules

1. **Edge direction is "needs to know about"**, not "calls" and not "contains".
2. **Nodes persist; status changes.** Never delete a completed node — you lose the inbound edges.
3. **Under four sentences.** The node is an index entry; detail lives at the `spec:` target.
4. **Add a node** for a screen, contract, service, committed decision, or risk. Not for every
   component — a graph that mirrors the filesystem rots at the same rate as the filesystem.

`.claude/agents/strata-cartographer.md` maintains this. `/graph-sync` reconciles it against the
code.

## Why this exists here specifically

The Strata spec is prose — a README and an HTML prototype. Without `spec:` pointers every task
starts by re-reading 70 lines to find the six that matter.

There is a second reason. Strata's premise is turning unstructured Markdown into a structured,
agent-queryable knowledge base with typed relationships. This graph is that idea applied to the
repo itself. Where the retrieval model here feels awkward, that is direct signal about the
product's own retrieval model — take the lesson across rather than working around it.
