---
description: Bring the context graph back in sync with the code and check its integrity
---

Reconcile `context-graph/` with reality.

1. `node scripts/graph.mjs --check`. Fix every failure — dangling edges, duplicate ids, missing
   `spec:` targets, cycles.
2. Compare graph to repo:
   - Every `status: done` node — verify the code it claims exists actually does. A false `done`
     is the most damaging kind of staleness, because other agents trust it.
   - Every new screen, contract, service, or committed decision since the last sync — does it
     have a node?
   - Every `spec:` line number — still pointing at the right thing after edits?
3. Delegate repairs to `strata-cartographer`.
4. `node scripts/graph.mjs --check` again, then `--mermaid` to regenerate the diagram.

Report:

```
DRIFT FOUND: <node → what was wrong>
NODES ADDED: <ids, and what prompted each>
STATUS CORRECTIONS: <node: claimed → actual>
CHECK: <pass | actual output>
```

If nothing drifted, say so in one line. Do not invent findings to justify the run.
