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

Fixture set added at `packages/core/src/fixtures.ts` (`importEvents`): a mix of all four statuses
against the existing Doc/Source fixtures. `screen-import`'s Recent Imports list renders only the
events whose `docId` resolves to a fixture Doc (imported/updated/skipped-duplicate) — the one
`failed` fixture has no `docId` (GitHub is disconnected, D6) and is intentionally excluded from
that flat, status-pill-free list; see strata-ui-builder DEVIATIONS for that call.
