---
description: Pick the next task from the milestone plan, with its context loaded
---

Decide what to work on next.

1. Read `docs/plan/02-milestones.md` and identify the current milestone — the earliest one not
   fully checked off.
2. Read `docs/plan/04-risk-register.md`. Any risk marked **blocking** for this milestone must be
   resolved before implementation work in it; if one is open, the next task is resolving it, not
   coding around it.
3. Run `node scripts/graph.mjs --check` and `node scripts/graph.mjs --status` to see what is
   `planned`, `in-progress`, and `blocked`.

Then recommend exactly one task:

```
NEXT: <one sentence>
MILESTONE: <which, and why this is the next item in it>
BLOCKED BY: <open risks or planned dependencies, or "nothing">
ROUTE TO: <agent from .claude/skills/model-routing/SKILL.md, with the reason>
CONTEXT: <the /context node-id to run first>
DONE MEANS: <the concrete, checkable condition>
```

One recommendation, not a menu. If two candidates are genuinely equal, pick the one that unblocks
more of the graph and say that is why.
