---
id: svc-ingest
kind: service
title: Ingestion pipeline
status: done
owner: ingest
spec: .claude/agents/strata-ingest-engineer.md
depends_on: [contract-doc, contract-source, contract-import-event, dec-tenancy, risk-injection, svc-storage, dec-auth]
---

fetch (per-source adapter) → raw → normalize (shared) → dedupe → persist → ImportEvent. Adapters
are the only source-specific code. Idempotency via (sourceId, externalId, contentHash) is required,
not optional — every source is assumed to deliver at least once and out of order.

`dec-tenancy`: ingestion is where `workspaceId` gets stamped onto `Doc`/`Source`/`ImportEvent`,
derived from an authenticated `Scope`, never a hand-passed string (ADR 0003).

An ingest run authenticates as a `kind:'service'` principal whose Grant names the sources it imports
into. This closes ADR 0003 open item 3 (dec-auth): `sourceIds` is the set of sources a principal may
read from *and* write to — one dimension, both directions. No `capabilities: ('read'|'write')[]` axis;
one write caller, one read caller class (the MCP server, read-only by design). All store writes are
gated by Grant.sourceIds (guarantee-grant-completeness).

`risk-injection` here means "read R2 before writing adapter code," not "blocked on R2" — node
`status` carries blocking, not `depends_on` edges (R2's own entry says it blocks M6 specifically).
See ADR 0003/D10: the local Markdown adapter's fetch/normalize/dedupe stage introduces no new
injection surface under three invariants (no model-derived values, ingested text never selects a
code path, ingested text never reaches `ImportEvent.error.message`) — but it does surface a real
gap in R2 itself, since `search_docs` returns metadata derived from that same untrusted content.

The persist stage now exists (`packages/ingest/src/persist.ts`), closing the one gap ADR 0003 left
open because `svc-storage` did not exist yet. It is a separate module from `pipeline.ts` on purpose:
the decision logic stays free of any storage dependency and testable on its own. M4 fixes: the
per-run dedupe guard is now keyed on the (sourceId, externalId) PAIR instead of the full triple
(packages/ingest/src/pipeline.ts), so two different files normalizing to one externalId no longer
silently overwrite each other. `persistDecisions` returns a `reconciled` map and `persistIngest`
rewrites affected ImportEvent.docId values, so events can no longer point at rows that do not exist.

Per-document fault tolerance (packages/ingest/src/persist.ts) now collects failures into `PersistResult.failed`
instead of throwing and aborting the batch. Failed documents' events are rewritten from imported/updated to
`failed` with sanitized `persist-failed` code, preserving the audit trail and allowing a retry to repair one
document without re-importing others already persisted.

`canonicalize()` and `deriveExcerpt`'s link-stripper regexes replaced `.replace(/\s*$/, '\n')` and unbounded
backtracking with `.trimEnd()` and input-bounded regex respectively, fixing ReDoS that could hang a worker on
2 MiB of spaces. Regression tests pin wall-clock linearity.

`unchanged` rows are skipped rather than re-upserted. Re-writing them is harmless for correctness —
the upsert is idempotent — but it would rewrite `updated_at` and the search vector on every scan,
making every document look freshly modified and destroying recency as a ranking tiebreaker.
