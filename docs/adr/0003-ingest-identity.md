# ADR 0003 — Local Markdown ingest identity, normalization, and dedupe

**Status:** accepted · **Date:** 2026-07-29 · **Log entry:** D10 · **Scope:** M5's local Markdown
adapter, the first item in `docs/plan/02-milestones.md`

## Context

`svc-ingest` (`context-graph/nodes/svc-ingest.md`) defines the pipeline shape: fetch (per-source
adapter) → raw → normalize (shared) → dedupe → persist → `ImportEvent`. `svc-storage` (M4) does not
exist yet, so "persist" cannot be built for real. Routed to `strata-architect` to design the parts
that can: fetch, normalize, dedupe, and `ImportEvent` emission, stopping one field short of a real
`Doc`. See decision log D10 for why building this ahead of M4 is in scope (the same shape of
exception as D8).

`packages/ingest/src/index.ts` already commits `RawDoc` (`{ sourceId, externalId, rawMarkdown,
fetchedAt, sourceMeta }`) and a `SourceAdapter` interface with pagination. This design extends
that, and produces normalized, deduped candidates plus `ImportEvent` records — nothing further.

## Decision

**Identity:** `externalId` is the POSIX-separator, NFC-normalized path relative to the scanned
root. `contentHash` is `"sha256:" + sha256hex(canonicalize(bytes))`, where `canonicalize` strips a
UTF-8 BOM, normalizes `CRLF`/`CR` to `LF`, and collapses trailing end-of-file whitespace to one
newline.

**Shared shape:** `RawDoc` gains a typed `origin: RawOrigin` field (`declaredTitle`, `path`,
`declaredTags`, `declaredSummary`, `createdAt`/`updatedAt`, `sourceUrl` — all optional) so the
shared normalizer never reads adapter-specific `sourceMeta`. `sourceMeta` stays for adapter-internal
diagnostics only; the normalizer must not read it.

**Normalization output:** a `NormalizedDoc` — every `Doc` field except `id` and `bodyRef`, plus a
`body: string` carried alongside (storage will consume it when it exists). A compile-time check
(`Omit<Doc, 'id'|'bodyRef'> extends Omit<NormalizedDoc, 'body'> ? true : never`) fails the build the
day `Doc` gains a field ingestion should be filling but isn't.

**Dedupe:** keyed on the pair `(sourceId, externalId)`, not the full triple — the triple alone
cannot distinguish "new" from "changed" (a changed file misses on the triple and looks new).
Outcomes: `new` (mint a `DocId`, `ImportEvent.status: 'imported'`), `unchanged` (reuse the prior
`DocId`, `status: 'skipped-duplicate'` — a normal outcome per `03-data-contracts.md`), `changed`
(reuse the prior `DocId`, `status: 'updated'`). `docIdentityKey`'s full triple is still used, for a
different job: catching the same file enumerated twice within one run.

**Ingest mints `DocId`** (via an injected `IdFactory`, default `crypto.randomUUID`) rather than
leaving it to storage — otherwise a successful-create `ImportEvent` has no `docId` to link to.
This is a proposal, not an assertion: `svc-storage`'s persist step must upsert on
`(workspaceId, sourceId, externalId)`, treating the ingest-minted id as provisional so a crash
mid-persist plus a retry doesn't double-write. Recorded as a constraint on M4 in `02-milestones.md`.

**Derivation and provenance** (`Derived<T>` fields only — `title` is a bare `string` on `Doc` today
and carries no provenance; see Open):

| Field | Rule | Provenance |
| --- | --- | --- |
| `title` | frontmatter `title` → first ATX `# ` heading → basename (dashes/underscores → spaces) | n/a |
| `excerpt` | frontmatter `description`/`summary` | `source` |
| `excerpt` | else first prose block (skip code/HTML/tables, links reduced to text, ≤280 chars) | `heuristic` |
| `folder` | frontmatter `folder` | `source` |
| `folder` | else the file's relative directory | `source` — a human filed it there; that's authored, not guessed |
| `folder` | else (file at scan root) the scan root's own basename | `heuristic` |
| `tags` | frontmatter `tags` (normalized, deduped, capped) | `source` |
| `tags` | else `[]` | `heuristic` — the rule ran and found none |

`updatedAt`/`createdAt` come from filesystem mtime/birthtime, **never** from a frontmatter date —
honoring an author-supplied date would let ingested content pin a document's recency ranking
indefinitely, which is R2's shape even outside its usual "content as instruction" framing.

**Failures** (`MarkdownErrorCode`): `unreadable`, `too-large`, `invalid-encoding`, `empty`,
`frontmatter-invalid`, `path-invalid`, `unsupported-type`. `empty` and `frontmatter-invalid` are
failures, not silent skips or degrades — `ImportEvent` has no "imported, but" status, and silently
dropping an author's declared metadata or an empty file gives the user no way to learn why nothing
appeared. `path-invalid` includes a NUL check: `docIdentityKey` joins fields on `\u0000`, so a NUL
in a path is a forged-key primitive.

`ImportEvent.error.message` is built **only** from a fixed, per-code message template — never from
a caught exception's own `.message`. This matters because parser errors routinely embed source
text (a YAML parser's error message includes the offending line), which would otherwise put raw
ingested content in a field the data-contracts doc guarantees is sanitized.

**Symlinks are never followed** (not configurable) — a symlink out of the scanned root is
arbitrary-file-read, and a cycle hangs the walk. Default extensions `.md`/`.markdown`; `.mdx` is
excluded by default (embeds JSX/imports — a different, executable-adjacent parse).

**Scope, not a bare `workspaceId`.** The pipeline entry point takes a `Scope` (from ADR 0002) and
derives `workspaceId` from it, reusing `isVisible`'s existing `Pick<Doc, 'workspaceId'|'sourceId'>`
signature to authorize the write. This is a deliberate, honest under-approximation — `Grant` models
*read* narrowing, and this reuses it to gate an *import*, which is strictly more restrictive than
no check at all, never a widening. "Which principals may import into which sources" has no proper
home yet; routed to R7/M7 (see Open).

## Rationale

Constraints, in the order they forced the shape above:

1. `svc-storage` doesn't exist — the design must produce something real without persistence.
2. `RawDoc` is already committed; the design extends it rather than inventing a parallel shape.
3. "Adapters are the only source-specific code" (the ingest agent's own rule) collides with an
   untyped `sourceMeta` bag — `RawOrigin` is the typed fix, not a `sourceMeta` special-case.
4. `Doc.title` has no `Derived<T>` provenance slot today — this design does not change that (see
   Open); it is safe to defer only because Strata is "not an editor" yet, so nothing user-authored
   exists for a re-sync to clobber.
5. ADR 0002: every persisted entity carries `workspaceId` first — ingestion is where it gets
   stamped, from an authenticated `Scope`, not a hand-passed string.
6. `ImportEvent.error.message` is sanitized by contract — the sharp edge is that this is easy to
   violate by accident (`message: err.message`), not on purpose.
7. `docIdentityKey` joins on `\u0000` — path input is attacker-influenced (a user imports a folder
   they didn't author themselves), so NUL-injection into an identity field is a real primitive, not
   a theoretical one.

## Rejected

| Alternative | Why not |
| --- | --- |
| `externalId` = content hash | Moves on every edit; `updated` becomes indistinguishable from `new`. |
| `externalId` = inode/file id | Not portable across `git clone`, copy, or backup restore. |
| Hash the *normalized* output, not raw bytes | Ties identity to the normalizer's version — every heuristic tweak invalidates the whole corpus. |
| No byte canonicalization before hashing | One teammate's Windows checkout re-imports the entire vault as "updated." |
| Normalizer reads `RawDoc.sourceMeta` directly | Requires a per-source branch in shared code — the exact abstraction failure the ingest rules forbid. |
| Change `Doc.title` to `Derived<string>` now | Correct eventually, wrong at M5 — touches `packages/core`, every screen, and every future MCP payload to solve a problem that can't occur before titles are user-editable. |
| Heuristic (guessed) tags from headings/filename | A wrong guessed tag actively hurts retrieval; model-derived tags would pull R2 into M5. |
| `frontmatter-invalid` degrades to a warning | `ImportEvent` has no "imported, but" status; silently dropping declared metadata hides the reason from the user. |
| Storage mints `DocId`, ingest emits id-less events | A successful-create event would have no `docId` to link the Import screen to. |
| Real temp-directory fixtures instead of an fs port | Can't portably produce `EACCES`, a broken symlink, or invalid UTF-8 content — exactly the failure paths that most need testing. |
| Remove the `risk-injection` edge from `svc-ingest` | The edge is correct as a "read this first" pointer; removing it means the next adapter author skips R2 at the one place untrusted text enters the system. |

## Migration risk

**Medium, decaying to high with time-since-first-real-import.** `externalId`-as-path and the
`canonicalize` hashing rule are both baked into stored rows once real data exists; changing either
orphans every markdown-sourced `Doc` and forces a full re-import. A file **rename is currently a
delete-plus-create** — the old `DocId` (and anything later attached to it) is lost. This is a named
property of path-based identity, not an oversight; content-addressed identity has the mirror-image
flaw (an edit creates a new doc instead), so neither option is free. Nothing in `packages/core`, no
MCP tool signature, no screen, and no token changes — this is additive within `packages/ingest`
only, and the blast radius is bounded almost entirely by there being no real data yet.

## Open

1. **`Doc.title` has no provenance slot.** Consequence: once titles are user-editable, a re-sync
   could silently clobber a user's rename with a re-derived one. Routed to `contract-doc`/
   `strata-architect`, to be decided before any title-edit feature ships — not here.
2. **R2's mitigations are written about content; retrieval returns metadata derived from that same
   content.** `title`/`excerpt`/`tags` all flow from untrusted file content under this design.
   Routed to the risk register (R2) and the eventual injection-fencing ADR — not resolved here.
3. **Write authorization is unmodeled.** Reusing `Grant`/`Scope` (read-narrowing) to gate an import
   is a deliberate under-approximation. "Which principals may import into which sources" is routed
   to R7/M7.
4. **Renames, moves, and deletes.** Path-identity makes a rename destructive; a deleted file has no
   tombstone. Routed to R5 as a named open item; the deletion half additionally blocks on M4.
5. **No `normalizerVersion` field.** `mode: 'reprocess'` gives a manual backfill path, but nothing
   records which normalizer version produced a stored doc. Routed to `svc-storage` (M4) — decide it
   there, alongside storage's own reasons for wanting one, rather than widening `Doc` pre-emptively.
