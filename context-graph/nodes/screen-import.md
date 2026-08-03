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
