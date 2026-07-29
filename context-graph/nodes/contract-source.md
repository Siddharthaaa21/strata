---
id: contract-source
kind: contract
title: Source
status: done
owner: core
spec: packages/core/src/index.ts
depends_on: [dec-tenancy]
---

A connected origin: Claude, Cursor, GitHub, local Markdown. Holds kind, name, description, connection
status, and lastSyncAt. Credentials are referenced via credentialRef, never embedded. Includes
workspaceId field for tenancy (ADR 0002) — critical for list_sources tool to avoid joins or leaking
workspace-wide connections. Serialized to both client and MCP callers.
