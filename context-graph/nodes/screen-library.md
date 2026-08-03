---
id: screen-library
kind: screen
title: Library
status: done
owner: web
spec: design/handoff/README.md:14
depends_on: [contract-doc, comp-doc-card, comp-sidebar, tokens-color, tokens-type]
---

Browse and filter all ingested docs. Pill filter row, then a 3-column grid (1 column below 860px)
with a 20px gap and 1180px max width. Filter state and search are the first place real query
behavior has to be decided — see svc-search. Exported with `const dynamic = 'force-dynamic'` (Next.js
constraint): must fetch vault data on every request, never build as static HTML, because auth scope
changes per-visitor and static HTML would serve the same vault to every visitor once authentication lands.
