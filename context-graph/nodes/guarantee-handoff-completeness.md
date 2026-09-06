---
id: guarantee-handoff-completeness
kind: decision
title: Every element the handoff specifies is present, or explicitly waived
status: in-progress
owner: web
spec: .claude/agents/strata-fidelity-auditor.md
depends_on: [dec-deferral-tracking]
---

**The property:** for each screen, every element the handoff specifies is either implemented or
recorded as a tracked, deliberate omission. Nothing is simply absent.

This is a *different* property from fidelity, and conflating the two is what let the Library ship
without its search field for five milestones. Fidelity asks "is this 17.5px like the handoff says";
completeness asks "is there a search field at all". A value-by-value diff cannot answer the second,
because an absent element has no values to disagree about — the audit was clean and correct and
still missed the biggest gap on the screen.

**How it is checked:** the fidelity audit runs a PRESENCE pass first — enumerate the elements the
handoff names for the screen (README prose plus the `Vault.dc.html` markup), assert each is
reachable in the implementation, and only then compare values on the ones that exist. An element
that is deliberately not built is not a pass; it is a finding that must point at a tracked item.

**Known waived omissions**, each with a reason that is not "we forgot":

| Element | Where | Why waived |
| --- | --- | --- |
| Sidebar folders list | Vault.dc.html:66-77 | [[screen-library]]'s folder pills already filter by folder; this duplicates an affordance |
| Sidebar profile footer | Vault.dc.html:79-82 | Needs a `User` contract that does not exist; handoff copy is placeholder |
| Pagination | — | The handoff has no design for it; [[screen-library]] states its limit instead of inventing controls |

A waiver belongs in this table, not in a code comment and not in a closed milestone bullet. See
[[dec-deferral-tracking]] for why that distinction is the whole point.

