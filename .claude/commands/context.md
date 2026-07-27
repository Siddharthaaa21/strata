---
description: Load the right context for a task by traversing the context graph
argument-hint: <node-id> [depth]
allowed-tools: Bash(node scripts/graph.mjs:*), Read, Grep, Glob
---

Load working context for `$1` (depth `${2:-2}`).

1. Run `node scripts/graph.mjs --subgraph $1 --depth ${2:-2}`.
   - If the node does not exist, list the closest ids and stop. Do not guess.
2. Read every `spec:` target the subgraph names, at the cited line.
3. Run `node scripts/graph.mjs --impact $1` so you know what a change here would touch.

Then report, and nothing more:

```
NODE: <id> — <title> (<status>, owner: <owner>)
MUST KNOW: <the constraints from the specs you read — 3-6 bullets, concrete>
CONSUMERS: <what --impact returned>
BLOCKED BY: <any dependency with status blocked/planned that this actually needs>
NOT IN GRAPH: <anything the task clearly needs that has no node — this is a real finding>
```

Do not start implementing. This command ends with a report.
