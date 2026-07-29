---
id: adapter-markdown
kind: service
title: Local Markdown ingest adapter
status: planned
owner: ingest
spec: docs/adr/0003-ingest-identity.md
depends_on: [svc-ingest, contract-doc, contract-import-event, dec-tenancy, risk-injection]
---

M5's first adapter and the reference implementation every later adapter is measured against — no
OAuth, exercises fetch → normalize → dedupe → `ImportEvent` end to end without needing `svc-storage`
(M4) to exist. Identity: `externalId` is the NFC-normalized relative file path; `contentHash` is a
SHA-256 over canonicalized bytes (BOM stripped, CRLF normalized, trailing whitespace collapsed).
Produces a `PendingDoc` (every `Doc` field except `id`/`bodyRef`), not a real `Doc` — storage mints
those. Tested entirely against an injected filesystem port and in-memory fixtures; no live disk or
network in the test suite. See ADR 0003 for the full design, its rejections, and its open items
(no provenance slot on `Doc.title`; R2's metadata-channel gap; write authorization unmodeled;
rename/delete semantics undecided).
