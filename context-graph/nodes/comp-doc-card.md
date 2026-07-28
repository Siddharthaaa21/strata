---
id: comp-doc-card
kind: component
title: Doc card
status: done
owner: web
spec: design/handoff/README.md:17
depends_on: [contract-doc, tokens-color, tokens-type, dec-stack]
---

White card, 14px radius, 20px padding, `oklch(89% 0.015 95)` border, hover `translateY(-2px)` with
no shadow change. Source label / serif title / excerpt / folder + relative time. Whole card is the
click target. Relative time is rendered, never stored.
