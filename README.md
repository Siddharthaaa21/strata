# Strata — AI Engineering Workspace

Strata turns scattered AI-generated Markdown (Claude research threads, Cursor plans, GitHub documentation, prompt recipes) into a structured, searchable engineering knowledge base — accessible to humans through a Next.js web app and to AI agents through a Model Context Protocol (MCP) server.

Humans browse and query the web app. Agents retrieve context over MCP.

---

## Current Status

**Active Development (Post-M7 Hardening)**. The application is fully built and tested:
- **Web App**: Next.js 16 App Router with Library (ranked search & folder filtering), Document Reader with interactive AI Document Assistant, Import & Sources, and Agent Access credential management.
- **MCP Server**: Stdio server exposing `search_docs`, `get_doc`, and `list_sources` with cryptographic nonce-delimited prompt injection fencing.
- **Storage**: Native PostgreSQL with full-text search (`tsvector`), ranking weighted specifically for AI context windows, and atomic CTE upserts.
- **Ingestion**: Multi-source pipeline for local Markdown (with rename tracking and tombstone pruning), Claude exports, Claude Code transcripts, and GitHub repositories.
- **Authentication**: Human sessions via Supabase Auth (PKCE, ES256 JWKS) and machine tokens via `stra_at_<tokenId>_<secret>`.
- **Verification Gate**: 370 automated tests passing against in-process PostgreSQL (PGlite).

---

## Monorepo Layout

```
apps/
  web/             Next.js 16 web application (Library, Reader, Import, Agent Access)
  mcp/             Model Context Protocol stdio server for AI agents
packages/
  core/            Canonical domain shapes (Doc, Source, Scope, Grant, Untrusted<T>)
  storage/         PostgreSQL schema, CTE upserts, tsvector FTS ranking, audit logs
  auth/            Session authentication (Supabase PKCE) and agent token hashing
  ingest/          Adapters (Markdown, Claude artifacts, Claude Code, GitHub) + pipeline
  tokens/          OKLCH design tokens transcribed from the handoff
design/
  handoff/         Original read-only design bundle (Vault.dc.html)
context-graph/     Machine-readable dependency graph of the codebase
docs/
  plan/            Milestones, data contracts, risk register, decision log
  adr/             Architecture decision records (0001–0006)
scripts/           Database setup, CLI ingestion tools, token minting, verification
```

---

## Quick Start

### Prerequisites
- **Node.js >= 22**
- **PostgreSQL 14+** (Supabase or Neon free tier recommended)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Add your database connection string and a workspace identifier:
```env
DATABASE_URL=postgresql://user:password@host:port/postgres?sslmode=require
STRATA_WORKSPACE_ID=ws-personal
```

*(Optional)* To use live LLM completions in the Document Reader Assistant, add an API key:
```env
GEMINI_API_KEY=your-gemini-key
# or ANTHROPIC_API_KEY=your-anthropic-key
# or OPENAI_API_KEY=your-openai-key
```
*(If no API key is provided, the assistant uses a built-in contextual fallback stream).*

### 3. Initialize the database
```bash
npm run db:setup
```
Applies schema migrations, verifies full-text search indexes (`ts_rank_cd`), and tests round-trip upserts.

### 4. Run the web application
```bash
# Standard mode (requires Supabase Auth login):
npm run dev

# Local dev auto sign-in mode:
npm run dev:inside
```
The app runs at `http://localhost:3000` (or `:3001` in `dev:inside`).

---

## Ingesting Content

### Ingest a Local Directory of Markdown
```bash
npm run ingest -- /path/to/docs
# To tombstone files deleted since last scan:
npm run ingest -- /path/to/docs --prune
```
*Note: Git hook auto-ingestion can be installed with `npm run hooks:install`.*

### Ingest Claude Chat Exports
Export your conversations from [Claude.ai](https://claude.ai) (Settings → Privacy → Export data) and ingest:
```bash
npm run ingest:claude -- /path/to/conversations.json
```
*Extracts authored documents and code artifacts rather than raw conversation chatter (Decision D34).*

### Ingest Claude Code Transcripts
Indexes interactive terminal sessions from `~/.claude`:
```bash
npm run ingest:claude-code
```

### Ingest a GitHub Repository
```bash
npm run ingest:github -- owner/repo
# With GITHUB_TOKEN configured in .env for private repos and higher rate limits:
GITHUB_TOKEN=ghp_xxx npm run ingest:github -- owner/repo
```

---

## Connecting AI Agents via MCP

Strata exposes a read-only MCP server over stdio for AI coding assistants (Claude Code, Cursor, Windsurf, Claude Desktop).

### 1. Mint an Agent Credential
```bash
npm run agent:create -- "Claude Code — Laptop" --by your-email@example.com
```
Prints a secret token (`STRATA_AGENT_TOKEN=stra_at_...`).

### 2. Verify with Smoke Test
```bash
STRATA_AGENT_TOKEN=stra_at_... npm run mcp:smoke
```

### 3. Claude Code Integration
`.mcp.json` at the repo root connects Claude Code automatically.

### 4. Claude Desktop Configuration
Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "strata": {
      "command": "node",
      "args": ["/absolute/path/to/design_handoff_strata_workspace/apps/mcp/src/index.ts"],
      "env": {
        "STRATA_AGENT_TOKEN": "stra_at_..."
      }
    }
  }
}
```

---

## Verification & Quality Gates

Before committing any change, run the verification gate:
```bash
npm run verify
```
This executes:
1. `typecheck`: `tsc --noEmit` across all workspaces.
2. `lint`: ESLint 9 with strict `no-restricted-syntax` access-control rules.
3. `test`: Complete unit & integration test suite (370 tests against PGlite).
4. `graph`: Context-graph DAG cycle and spec integrity check.
5. `scan`: Scan for corrupt NUL bytes across all text files.
