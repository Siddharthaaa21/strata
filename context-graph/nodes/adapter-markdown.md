---
id: adapter-markdown
kind: service
title: Local Markdown ingest adapter
status: done
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

The filesystem is an injected port (ADR 0003): real temp-directory fixtures cannot portably produce
EACCES, a broken symlink, or invalid UTF-8 — exactly the failure paths that most need testing. Symlinks
are reported but never followed, in either direction, because a symlink out of the scan root is arbitrary-file-read
and a cycle hangs the walk. Text is decoded strictly so a replacement character cannot silently corrupt content and
its hash. MAX_EXCERPT (280) now applies to the frontmatter path too; it previously applied only to the
heuristic path, leaving `description:` unbounded, making `search_docs` a channel for body-sized prose.

`canonicalize()` replaced quadratic `/\s*$/` regex with `.trimEnd() + '\n'`, fixing ReDoS where 2 MiB of trailing
spaces would block the event loop for ~27 minutes. Identity behavior is unchanged and pinned by test. This fix
closes the R2 open item on quadratic regexes in ingest.

**A document's life after its file moves (R5, D20 — closes ADR 0003 open item 4).** Identity is
still the path, so an edit is still an update. The content hash now carries weight at exactly one
moment: deciding what a *disappearance* means.

- **Moved** — exactly one vanished document and exactly one arriving file share a hash. The document
  keeps its `DocId` via `relocate`, then goes through the ordinary `upsert`, because `folder`,
  `tags`, and the search vector are all derived FROM THE PATH. Relocating without re-deriving files
  a document under a directory that no longer exists, and [[screen-library]]'s filter pills are
  built from that column.
- **Ambiguous** — anything other than one-to-one is left alone. Identical files are ordinary, and a
  wrong match silently rewrites one document's identity to another's path, which is worse than the
  bug. A rename whose content also changed is therefore not detected: a stated limit, chosen over
  similarity scoring's class of confident mistakes.
- **Gone** — reported on every run, deleted only under `--prune`. `externalId` is relative to the
  scanned root, so ingesting a subfolder makes nearly every stored document legitimately unseen;
  pruning by default would let one narrow command empty the vault and print success.

Deletion is a tombstone (`docs.deleted_at`), filtered from every read path in [[svc-storage]] and
deliberately NOT from `findKnown` — so a returning file resurrects its original document instead of
minting a second one. A tombstoned prior forces `changed`, or an unchanged restored file would be
decided `unchanged`, written nowhere, and stay invisible while the run called it present.

Nine tests, five guards mutation-verified. New store surface: `listKnown`, `relocate`, `softDelete`,
all three registered in [[guarantee-grant-completeness]].
