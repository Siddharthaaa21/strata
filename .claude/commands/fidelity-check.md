---
description: Audit implemented UI against the design handoff
argument-hint: [component-or-screen | blank for everything changed]
---

Audit **${1:-every component touched on this branch}** against the design handoff.

If no argument was given, first run `git diff --name-only main...HEAD -- apps/web packages/tokens`
to get the list. If that returns nothing, use `git status --porcelain`.

For each target, delegate to `strata-fidelity-auditor`. Give each delegation the file paths and
the handoff section — the agent starts with no context from here.

Collect the findings and report them as one table, most severe first:

```
<file:line> | <dimension> | spec: <value> (<handoff source:line>) | actual: <value>
```

Then state, explicitly:

- how many values were verified correct,
- anything the auditor could not verify and why,
- whether any finding is a **handoff internal disagreement** (README vs HTML) rather than an
  implementation bug — those need a product decision, not a code fix.

Do not fix anything. This command reports. Fixes are a separate, deliberate step.
