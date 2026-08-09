---
id: adapter-claude
kind: service
title: Claude export adapter
status: in-progress
owner: ingest
spec: packages/ingest/src/claude.ts
depends_on: [svc-ingest, adapter-markdown, contract-doc, contract-import-event, risk-injection, dec-untrusted-content]
---

M5's second adapter, and **an import rather than a connector** (D22, R5).

There is no Claude API to connect to. Export is Settings → Privacy → Export data: a manual act
producing an emailed link that expires in twenty-four hours and needs an interactive signed-in
browser to download. No OAuth, no pagination, no incremental sync — the four things `SourceAdapter`
exists to describe. So this does not implement it. Bending an interface to accommodate a mechanism
it does not describe is how the abstraction stops meaning anything. The user drops a file; we read
it.

**Identity is the conversation `uuid`, and it is the best identity in this codebase.**
[[adapter-markdown]] uses a path, which moves — D20 spent a whole change repairing what that costs.
A uuid is assigned by the source, never changes, and survives the conversation being renamed,
continued, or re-exported. Renaming a chat is an `updated` automatically, with no hash-matching
heuristic needed. No fallback to an array index: an index is not an identity, and using one would
make a re-export after a single deletion rewrite the identity of every conversation after it.

**The content hash is taken from the RENDERED transcript, not the export's JSON object.** Two
exports of an unchanged conversation must agree, and the object carries fields that move between
exports without the conversation changing.

**[[risk-injection]] applies here harder than anywhere else in the system.** This is not "documents
that happen to be model-generated" — it is a verbatim transcript of a model being instructed, stored
and served back to models over MCP. A conversation in which someone asked Claude to write a prompt
injection is an *ordinary document* in this source, not an attack. Every derived string goes through
`normalizeIngested`; bodies are fenced downstream like any other. `tool_use` / `tool_result` blocks
are skipped rather than rendered — their payloads are exactly the structured text that reads as
instruction, and they are plumbing rather than conversation.

**Titles.** Claude names most threads `Untitled`, so `name` alone files an entire import under one
indistinguishable label — the worst outcome for a product whose job is finding things again. Falls
back to the opening human turn, clipped at one line, which is what a person would call it.

**Tolerance is asymmetric, deliberately.** A malformed *conversation* is a recorded failure and the
import continues; a malformed *file* throws, because pointing this at the wrong JSON from the export
ZIP is the likeliest mistake and "0 imported" would be indistinguishable from an empty account. A
missing or unfamiliar `projects.json` costs folders, not the import.

**Not built, and not going to be: Cursor.** No official export; chats live in undocumented SQLite
key-value blobs that already broke once (Cursor 3.0, April 2026). See D22 for why "best effort with
a version check" was rejected — the failure arrives on an update the user did not know was
significant, and they blame Strata.
