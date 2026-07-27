---
id: comp-sidebar
kind: component
title: Sidebar / nav shell
status: planned
owner: web
spec: design/handoff/README.md:33
depends_on: [tokens-color, tokens-type, dec-stack]
---

248px fixed on desktop; on mobile a full-screen fixed overlay behind a hamburger, with a top bar
taking its place. Active nav item gets a white pill, ink text, and an accent leading dot.
Shared by all three screens, so build it before any of them.
