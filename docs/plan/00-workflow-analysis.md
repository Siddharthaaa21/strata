# Workflow analysis: what the handoff gives us, and what it doesn't

Written before implementation started, from `design/handoff/README.md` and
`design/handoff/Vault.dc.html`. The point of this document is to be precise about the boundary
between "specified" and "assumed", because the handoff is confident enough to hide the gap.

## What the handoff actually is

A **design-tool prototype plus a prose spec**, covering three screens. It is high-fidelity on
presentation and silent on everything behind it.

`Vault.dc.html` is a single component in a design-tool DSL: `sc-if` / `sc-for` / `{{ }}` bindings
over a `class Component extends DCLogic` block holding state and hardcoded data. It has three
state values (`screen`, `width`, `navOpen`), one derived boolean (`isMobile`), and a `renderVals()`
function that returns every style value pre-computed. There is no data layer, no routing, no
persistence, no network.

That is not a criticism — it is exactly what a design handoff should be. But it means the
prototype's apparent completeness measures presentation coverage, not product coverage.

## Specified, unusually well

- Every color as an exact OKLCH triple, including three distinct border values used deliberately.
- Every font size, including non-round ones (11.5 / 12.5 / 17.5 / 18.5px).
- Every fixed dimension: sidebar 248px, reader rail 280px, content 660px, page 840/1180px.
- One breakpoint (860px) with a complete table of what changes on each side of it.
- Interaction behavior: nav switching, card click → reader, hamburger toggle, hover transform.
- Explicit product decisions embedded in the design: GitHub ships not connected; Recent Imports
  is deliberately minimal; reader body type *grows* on mobile.

Design work is genuinely done. There is very little to guess at on the visual layer, and the
`packages/tokens` + fidelity-auditor setup exists to keep it that way.

## Not specified at all

Ordered by how much they block.

| Gap | Why it blocks | Where it lands |
| --- | --- | --- |
| **Tenancy / access scoping** | Determines the Doc shape, every query, every MCP signature. Cannot be retrofitted. | `risk-tenancy` |
| **The MCP surface** | The stated differentiator — "usable by AI agents via MCP" — appears in the overview and then never again. Zero specification. | `svc-mcp` |
| **Storage and search** | The Library is search-and-filter-driven. What ranking, over what index, is undecided. | `svc-search`, `svc-storage` |
| **Ingestion** | Connect/Upload are visual endpoints. Real OAuth, per-source parsing, normalization, dedupe, rate limits — all unbuilt. | `svc-ingest` |
| **Auth** | The sidebar shows a user and "4 agents connected". No provider chosen. | `risk-tenancy` |
| **"Ask agent about this"** | Implies a live agent invocation with the doc as context. Styled as a button; is a feature. | not yet noded |
| **Agent Access screen** | Nav item exists and routes to the reader as scaffolding. The real screen has no design. | `screen-agent-access` |

## Three traps in the handoff itself

**1. The nav lies.** The third nav item is labelled "Agent Access" but `nav('reader', 'Agent
Access')` routes to the reader screen. Implementing the alias would ship a bug that looks
intentional.

**2. Placeholder data reads as requirements.** "312 docs", the five folders with counts, the six
doc titles, "Priya Shah", "4 agents connected" — all invented for the mock. The README says so
once, in one line, and then the prototype spends 40 lines making them look real. Every one of
these must route through `packages/core` types and a single fixtures module.

**3. The README rounds; the HTML doesn't.** The README says the card border is
`oklch(88% 0.015 95)`; the HTML uses `oklch(89% 0.015 95)` on cards and reserves 88% for
structural borders. Where the two disagree, the HTML wins — and the disagreement is worth
reporting rather than silently resolving.

## What this implies about sequencing

The instinct is to build the three screens first, because they are the part that is fully
specified. That instinct produces a demo, not a product, and it produces rework: every screen
touches `Doc`, and `Doc` cannot be settled until tenancy is.

So the sequencing in `02-milestones.md` deliberately puts contracts and the two blocking risks
ahead of screen work, and builds the shell against fixtures in parallel. The screens are the
lowest-risk work in the repo precisely because they are so well specified — which is an argument
for doing them *later*, not sooner.

## How this shapes the tooling

Three properties of this handoff drove the `.claude` setup:

1. **The spec is prose, not code.** Hence the context graph's `spec:` pointers — so a task starts
   with the six relevant lines instead of a re-read of the whole README.
2. **Fidelity drift is invisible and mechanical.** `oklch(88%)` vs `oklch(89%)` will never be
   caught by review. Hence the hook that blocks raw `oklch()` outside the token package, and a
   dedicated auditor agent that works value-by-value from the handoff side.
3. **The expensive decisions are all unspecified.** Hence routing contract, MCP, and tenancy work
   to Opus-tier agents with an explicit "state what you could not resolve" output contract, rather
   than letting them get answered implicitly by whoever writes the first query.
