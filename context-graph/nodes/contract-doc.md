---
id: contract-doc
kind: contract
title: Doc
status: done
owner: core
spec: packages/core/src/index.ts
depends_on: [dec-tenancy]
---

The central domain shape: metadata (title, excerpt, folder, tags, timestamps), provenance
(sourceId, externalId, contentHash), and tenancy (workspaceId). Body is deliberately separate — agents
must be able to judge relevance from metadata alone, and the Library grid needs the same subset.
Fully implemented with workspaceId field per ADR 0002.
