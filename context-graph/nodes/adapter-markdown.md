---
id: adapter-markdown
kind: service
title: Local Markdown ingest adapter
status: in-progress
owner: ingest
spec: docs/adr/0003-ingest-identity.md
depends_on: [svc-ingest, contract-doc, contract-import-event, dec-tenancy, risk-injection, dec-untrusted-content]
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

Implementation in progress. The filesystem is an injected port (ADR 0003): real temp-directory
fixtures cannot portably produce EACCES, a broken symlink, or invalid UTF-8 — exactly the failure
paths that most need testing. Symlinks are reported but never followed, in either direction, because
a symlink out of the scan root is arbitrary-file-read and a cycle hangs the walk. Text is decoded
strictly so a replacement character cannot silently corrupt content and its hash.
