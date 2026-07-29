---
id: svc-ingest
kind: service
title: Ingestion pipeline
status: planned
owner: ingest
spec: .claude/agents/strata-ingest-engineer.md
depends_on: [contract-doc, contract-source, contract-import-event, dec-tenancy, risk-injection]
---

fetch (per-source adapter) → raw → normalize (shared) → dedupe → persist → ImportEvent. Adapters
are the only source-specific code. Idempotency via (sourceId, externalId, contentHash) is required,
not optional — every source is assumed to deliver at least once and out of order.

`dec-tenancy`: ingestion is where `workspaceId` gets stamped onto `Doc`/`Source`/`ImportEvent`,
derived from an authenticated `Scope`, never a hand-passed string (ADR 0003).

`risk-injection` here means "read R2 before writing adapter code," not "blocked on R2" — node
`status` carries blocking, not `depends_on` edges (R2's own entry says it blocks M6 specifically).
See ADR 0003/D10: the local Markdown adapter's fetch/normalize/dedupe stage introduces no new
injection surface under three invariants (no model-derived values, ingested text never selects a
code path, ingested text never reaches `ImportEvent.error.message`) — but it does surface a real
gap in R2 itself, since `search_docs` returns metadata derived from that same untrusted content.
