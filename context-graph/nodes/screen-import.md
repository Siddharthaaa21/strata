---
id: screen-import
kind: screen
title: Import & Sources
status: done
owner: web
spec: design/handoff/README.md:20
depends_on: [contract-source, contract-import-event, comp-connector-row, comp-sidebar]
---

Single column, 840px max. Connector list above a deliberately minimal Recent Imports list (no
cards, no status pills). In the handoff the Connect and Upload actions are visual endpoints only —
wiring them means real OAuth, which is milestone work, not a UI task. Exported with `const dynamic = 'force-dynamic'`
(Next.js constraint): must fetch vault data on every request, never build as static HTML, because auth scope
changes per-visitor and static HTML would serve the same vault to every visitor once authentication lands.

Failed `ImportEvent`s now carry `externalId`, identifying the file that caused the failure. Previously a failure
said only "something in this source failed" — `docId` is absent precisely in the failure case, so there was no way
to learn which file. The screen can now surface which document failed, enabling diagnosis and targeted retry.

**The four connector rows are SLOTS, not a list of what exists.** The handoff draws Claude, Cursor,
GitHub and Local Markdown, so all four always render; a slot shows real data only when a `Source`
with the matching id is in the database, and reads `Connect` otherwise. Two consequences worth
knowing before reading this screen as a status board:

- Only the **Markdown** adapter is built ([[adapter-markdown]]). Claude, Cursor and GitHub have no
  implementation at all — M5, gated on R5 — so those rows advertise intent, and their actions are
  inert by design (`aria-disabled`, no handler; README:75-76 calls them visual endpoints).
- ~~A real `Source` whose id is not one of the four is **invisible here**.~~ **Closed 2026-08-10
  (D29).** Sources outside the slots now render as their own rows beneath them. The gap acquired a
  real cause the moment [[adapter-github]] landed: every indexed repository is its own Source, since
  `externalId` is the path within a repo and `README.md` exists in nearly all of them.

The slot merge takes `kind` from the LIVE source when one is present, not from the slot. Taking
`name` and `status` from the live row while keeping the slot's `kind` let a markdown source sitting
on the `src-claude` id render with Claude's badge and colours — reading, at a glance, as a connected
Claude account.

**The four connector rows are three mechanisms, and one of them cannot exist (D22, R5).** Verified
2026-08-09 rather than assumed, and the row list changed as a result:

| Row | Mechanism | Label |
| --- | --- | --- |
| GitHub | Documented, authenticated API | `Connect` |
| Claude | **No API.** Manual export; emailed link expiring in 24h | `Import` |
| Local Markdown | A folder you point at | `Upload` |
| ~~Cursor~~ | No official export; undocumented SQLite that already broke once | **Removed** |

`Connect` implies an authenticated, ongoing sync. That is true of GitHub and false of the other two,
so one label for all of them promised a capability two sources will never have — the same defect as
the [[comp-sidebar]] nav item that returned a 404, and the same fix: say what the thing actually is.

Cursor's row is **deleted rather than greyed**. A disabled row still advertises an intention, and
there is no intention here: see D22 for why "best effort with a version check" was rejected.
[[adapter-claude]] is built and imports through the same pipeline as [[adapter-markdown]].

## The actions are live (D24, 2026-08-10)

`Import` (Claude) and `Upload` (Markdown) now do the thing they name. They post to Server Actions in
`apps/web/src/app/import/actions.ts`, which call `apps/web/src/lib/import-upload.ts` — **the CLI's
own path**: same adapters, same `runIngest`, same `persistIngest`, same `Scope` minted from the
caller's real session. There is no web-only ingest route, because a second way to write into the
vault is a second thing to review and the one nobody reviews is the one that ships a bug.

Two constraints that are not obvious from the code:

- **Uploads can never prune.** `persistIngest` is called without `prune`, and there is no parameter
  to pass it. A browser upload is the worst possible place to infer deletion: the user picked one
  file, or dragged one folder of a larger vault, so almost every stored document is legitimately
  absent. Missing counts are *reported* and never acted on; `--prune` stays at a terminal where an
  operator named the whole source deliberately.
- **The upload is bounded** (`MAX_UPLOAD_BYTES`, 16 MB) before anything is decoded. The CLI has no
  equivalent because a local operator reading their own disk is not the same threat as an
  authenticated form post.

**All three rows are live as of D29.** Claude and Markdown take a file; GitHub takes an *address*,
so it has its own control — an input that appears only when asked for, then reads the repository.
Its failures are network failures rather than parse failures, and the one that matters most is
`incomplete`: a repository larger than the ceiling produces a partial import whose counts look
exactly like a complete one, so the control states that before any number.

Getting here took two steps back first. Relabelling Claude from `Connect` to `Import` (D22)
described the mechanism accurately and thereby made a dead control read as *more* actionable; the
Markdown picker then shipped with `webkitdirectory`, which does not "degrade to a multi-file pick"
as its comment claimed but makes the input folder-ONLY in Chrome, so loose files could not be
selected at all. Both were found by driving the real control in a real browser. See
[[comp-connector-row]], [[adapter-github]].
