---
id: contract-import-event
kind: contract
title: ImportEvent
status: done
owner: core
spec: packages/core/src/index.ts
depends_on: [contract-source, dec-tenancy]
---

One record per ingestion attempt, including failures. Records sourceId, docId (if created), status
(imported/updated/skipped-duplicate/failed), externalId, and optional sanitized error. Includes workspaceId
for tenancy (ADR 0002) — lets Import screen query without a join. Idempotent re-import via (sourceId,
externalId, contentHash) identity tuple; skipped-duplicate is normal, not an error.

`externalId` (optional, populated on every event) identifies the file within the source. Previously a failure
said only "something in this source failed" with no way to learn which file — docId is absent precisely when a
failure occurs. `externalId` now provides that missing diagnosis, enabling users and retry logic to pinpoint
which ingested file caused the failure (packages/core/src/index.ts, packages/ingest/src/persist.ts).
Real events are recorded into PostgreSQL via `packages/storage` (`events.append`/`events.recent`). `screen-import`'s Recent Imports list renders successful events, while failed events are surfaced in their own failure reporting section above (D33).

