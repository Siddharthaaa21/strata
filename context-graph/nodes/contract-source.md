---
id: contract-source
kind: contract
title: Source
status: planned
owner: core
spec: docs/plan/03-data-contracts.md
depends_on: []
---

A connected origin: Claude, Cursor, GitHub, local Markdown. Holds connection status and per-source
tint used by the UI. Credentials are referenced, never embedded — a Source is serialized to the
client and to MCP callers.
