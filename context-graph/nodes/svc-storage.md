---
id: svc-storage
kind: service
title: Storage
status: planned
owner: core
spec: docs/plan/04-risk-register.md
depends_on: [contract-doc]
---

Where docs live. Undecided. The choice is coupled to search: full-text ranking and vector
similarity have very different storage implications, and picking storage first without deciding
retrieval is how you end up with a second system six weeks later.
