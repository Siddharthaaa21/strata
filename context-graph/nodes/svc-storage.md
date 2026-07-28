---
id: svc-storage
kind: service
title: Storage
status: planned
owner: core
spec: docs/plan/04-risk-register.md
depends_on: [contract-doc, dec-tenancy]
---

Where docs live. Undecided. The choice is coupled to search: full-text ranking and vector
similarity have very different storage implications, and picking storage first without deciding
retrieval is how you end up with a second system six weeks later.

Tenancy (`dec-tenancy`) is resolved, so this is no longer blocked by an open scope decision — every
store read still must take a `Scope` and apply `scopeFilter` (ADR 0002); that is now an
implementation requirement, not an open unknown.
