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
- A real `Source` whose id is not one of the four is **invisible here**, though its documents still
  appear in [[screen-library]]. That is a genuine gap the moment a fifth source exists.

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
