# Strata

An AI engineering workspace. Strata ingests the Markdown your team already generates — Claude
research threads, Cursor implementation plans, GitHub ADRs and READMEs, loose `.md` files — and
turns it into a searchable, structured knowledge base that both humans and AI agents can read.

Humans use the web app. Agents use the MCP server.

## Status

Pre-implementation. The design handoff is complete and high-fidelity; the backend, ingestion
pipeline, and MCP surface are unbuilt. See `docs/plan/02-milestones.md`.

## Getting started

```bash
npm install
npm run dev
```

Requires Node >= 22.

## Layout

```
apps/web          Next.js app — Library, Import & Sources, Reader
apps/mcp          MCP server exposing the vault to agents
packages/core     Domain types and contracts
packages/ingest   Connector adapters + normalizer
packages/tokens   Design tokens from the handoff
design/handoff    Original design bundle (read-only reference)
docs/plan         Milestones, contracts, risks, decisions
context-graph     Machine-readable map of the system
.claude           Agent/skill/command/workflow definitions
```

## Working on this repo with Claude Code

Read `CLAUDE.md` first, then `.claude/README.md` — the second is a cookbook of the techniques
this repo is set up for (model routing, the dev loop, context-graph retrieval, orchestration).

## Verification

```bash
npm run verify
```

Typecheck, lint, test, and context-graph integrity. This is the gate before any commit.
