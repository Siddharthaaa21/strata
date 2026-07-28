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
(imported/updated/skipped-duplicate/failed), and optional sanitized error. Includes workspaceId for
tenancy (ADR 0002) — lets Import screen query without a join. Idempotent re-import via (sourceId,
externalId, contentHash) identity tuple; skipped-duplicate is normal, not an error.
