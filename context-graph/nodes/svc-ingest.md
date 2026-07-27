---
id: svc-ingest
kind: service
title: Ingestion pipeline
status: planned
owner: ingest
spec: .claude/agents/strata-ingest-engineer.md
depends_on: [contract-doc, contract-source, contract-import-event, risk-injection]
---

fetch (per-source adapter) → raw → normalize (shared) → dedupe → persist → ImportEvent. Adapters
are the only source-specific code. Idempotency via (sourceId, externalId, contentHash) is required,
not optional — every source is assumed to deliver at least once and out of order.
