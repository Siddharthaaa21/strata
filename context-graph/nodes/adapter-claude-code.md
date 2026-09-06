---
id: adapter-claude-code
kind: service
title: Claude Code transcript adapter
status: done
owner: ingest
spec: packages/ingest/src/claude-code.ts
depends_on: [svc-ingest, adapter-markdown, contract-doc, contract-import-event, risk-injection, dec-untrusted-content]
---

Recovers documents Claude **wrote**, from local Claude Code session logs. Read [[adapter-markdown]]
first — as with [[adapter-github]], most of what this adapter "does" is that adapter's work.

## Why it exists

Claude Code writes every session to `~/.claude/projects/<slug>/*.jsonl`, and those transcripts hold
the full text of every file written. A document is therefore recoverable **even if the file was never
kept** — deleted, written to a scratch path, or made in a project since forgotten.

Not hypothetical. This adapter exists because a README went missing and the only reason it was
findable was that a transcript still held it. Doing that by hand meant grepping 38 MB of JSONL.

**Not a connector.** There is nothing to connect to: the data is already on disk. No API, no token,
no export, nothing expiring in 24 hours — the opposite of [[adapter-claude]], which needs a manual
export because claude.ai has no API at all (D22).

## The three decisions that shape it

- **Artifacts, not conversations.** Ingesting raw transcripts would bury the vault — one session here
  is 24 MB of tool calls, diffs and reasoning. What has a title, a body and a moment it existed is
  the FILE, so the file is the unit.
- **`Write` only; `Edit` is counted, never applied.** An edit carries a replacement fragment, not the
  resulting file, so edits cannot reconstruct content. A document with later edits gets a note **in
  its own body** saying its content predates them. A stale document that admits it is stale is
  useful; one that does not is a trap.
- **Documents only, not source files.** Claude writes far more TypeScript than prose, and the code
  already lives in a repository under version control. What is not recoverable elsewhere is the
  prose.

## Facts that constrain callers

- **Last write wins, per path**, across every session — they overlap and interleave. Five writes of
  one README is one document, not five wrong answers ranked above the right one.
- **Files written outside the session cwd are kept**, under an `outside-project/` prefix. Claude Code
  writes skills and settings there; dropping them would reproduce the exact problem this adapter
  exists to fix.
- **There is no `--prune`, and no flag to add one.** A transcript is an append-only record. A document
  missing from a scan means the session that wrote it was rotated away, NOT that the document was
  deleted — pruning on that basis would erase the old work this exists to recover.
- **Project filtering is the caller's**, via `--project` / `--ignore` on substring match, because the
  slug is a mangled path and nobody remembers it exactly.

Content here is model-generated, which is [[risk-injection]]'s threat in its purest form: text
written by a model that will later be read by one. It reaches the store through `scanMarkdown` and
`normalizeIngested` like everything else, and never bypasses them.
