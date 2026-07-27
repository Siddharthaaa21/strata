---
id: contract-import-event
kind: contract
title: ImportEvent
status: planned
owner: core
spec: docs/plan/03-data-contracts.md
depends_on: [contract-source]
---

One record per ingestion attempt, including failures. The Recent Imports list renders successes,
but failures must be recorded too or partial-sync bugs become invisible. Identity is
(sourceId, externalId, contentHash).
