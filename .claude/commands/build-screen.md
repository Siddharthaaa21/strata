---
description: Build a handoff screen end-to-end with the fidelity loop
argument-hint: library | import | reader
---

Build the **$1** screen from the design handoff.

Run this sequence. Do not skip steps 1 or 5.

1. **Context** — `node scripts/graph.mjs --subgraph screen-$1 --depth 2`, then read every
   `spec:` target it names. Confirm the milestone in `docs/plan/02-milestones.md` actually
   covers this screen; if we are not in that phase, say so and stop.

2. **Spec extraction** — read the `$1` section of `design/handoff/README.md` AND the
   corresponding block of `design/handoff/Vault.dc.html`. The HTML has values the README rounds
   off; where they disagree, the HTML wins — report the disagreement.

3. **Tokens** — check `packages/tokens` covers every value you need. Anything missing gets added
   there first, with a comment citing the handoff line. A raw `oklch()` in `apps/web` is blocked
   by a hook.

4. **Build** — delegate to `strata-ui-builder` with a self-contained brief: the extracted values,
   the types from `packages/core`, and what done means. The agent has none of this conversation.

5. **Verify** — `npm run verify`, then delegate to `strata-fidelity-auditor` for `screen-$1`.
   Report the auditor's findings verbatim; do not summarize away a drift.

6. **Record** — update `context-graph/nodes/screen-$1.md` status and edges, then
   `npm run graph -- --check`.

Report the auditor output and the verify result. If either is red, say so plainly rather than
describing the work as complete.
