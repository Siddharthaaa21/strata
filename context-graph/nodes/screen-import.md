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
