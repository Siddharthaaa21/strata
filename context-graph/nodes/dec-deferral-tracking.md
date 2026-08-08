---
id: dec-deferral-tracking
kind: decision
title: A deferral needs a destination, and a "Done when" needs to be exercised
status: done
owner: core
spec: docs/plan/05-decision-log.md
depends_on: [screen-library, comp-sidebar]
---

Written after the Library shipped for five milestones without a search box — the second half of its
own stated purpose in the handoff (README:15, "Browse/**search** all ingested docs").

**How it happened, in four steps, none of which was careless on its own:**

1. M2 omitted the search field because nothing backed it yet. Correct: M2 predates storage.
2. The omission was recorded as a note *inside an already-checked milestone bullet*
   (`02-milestones.md:61`) and in a `DEVIATIONS` comment. Neither is a place anything is read again.
3. M4's completion criterion was **"Done when the Library search box returns real ranked results"**
   and was marked **Met** — on the strength of 13 passing storage tests. Nobody rendered the page.
4. The fidelity auditor ran and reported clean. Its brief is "compares implemented UI against the
   handoff **value-by-value**", so it audits values of elements that exist. A missing element has
   no values to compare, and it was structurally incapable of finding one.

**The decision, in three parts:**

- **A `Done when` that names a user-visible thing is closed by exercising it**, not by a green test
  suite. Browser tools exist; a screenshot of the described behaviour is the evidence.
- **[[guarantee-handoff-completeness]]**: the fidelity audit runs a presence pass *before* its value
  pass — enumerate every element the handoff specifies for a screen, assert each is reachable, then
  compare values.
- **A deferral creates a tracked item**, never a parenthetical in a closed bullet. If it is worth
  writing down, it is worth putting somewhere that gets read.

**The general lesson, which is the reason this is a node and not a comment.** Verification went
where the tooling was, not where the risk was. Authentication got five independent adversarial
review rounds and found real privilege escalation; there are 230+ tests; every SQL statement was
enumerated for tenancy leaks. All of that is checkable without a human looking at anything. The one
question that needed someone to open a browser — *is this the product?* — had no mechanism, so it
went unasked for six milestones while every later milestone built on "Library: done".

**Reversible?** The process changes cost a presence pass per screen audit. The alternative is
trusting that a value-by-value diff notices absence, which it demonstrably does not.
