---
id: screen-library
kind: screen
title: Library
status: done
owner: web
spec: design/handoff/README.md:14
depends_on: [contract-doc, comp-doc-card, comp-sidebar, tokens-color, tokens-type, svc-storage]
---

Browse and filter all ingested docs. Pill filter row, then a 3-column grid (1 column below 860px)
with a 20px gap and 1180px max width. Renders the true vault total (not the clamped page size) via
`docs.count(scope)` queried separately from `list`. Folder pills derive from the server's `docs.folders(scope)`,
which sees past MAX_RESULTS, so folders vanish only if emptied—never by pagination. Pagination itself
remains unbuilt; the handoff has no design for it. Instead, honest text states "Showing the 50 most recently
updated" when truncated, because the UI is limited. Exported with `const dynamic = 'force-dynamic'` (Next.js
constraint): must fetch vault data on every request, never build as static HTML, because auth scope
changes per-visitor and static HTML would serve the same vault to every visitor once authentication lands.
