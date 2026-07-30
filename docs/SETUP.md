# Setup — what needs a human

Everything in this repo runs and tests without external services. Tests use PGlite (PostgreSQL 18
compiled to WASM, in-process), so `npm run verify` is green on a clean checkout with no database,
no container, and no credentials.

**One thing needs you: a PostgreSQL database.** That is the only external dependency, and it is
required for *running* the product, not for building or testing it.

---

## Already done — no action needed

| | |
| --- | --- |
| MCP SDK | `@modelcontextprotocol/sdk@1.30.0` installed. The server is built and tested against it. |
| Postgres client | `pg` installed; `fromPoolLike` adapts it (or postgres.js, or Neon's driver). |
| Schema | `packages/storage` owns the DDL. `npm run db:setup` applies it. |
| CI | Runs `npm run verify` on every PR. No secrets required. |

---

## Your tasks

### 1. Create a hosted Postgres — 5 minutes

Either provider is fine; both have a free tier that is ample here.

- **[Neon](https://neon.tech)** — create a project, copy the connection string from the dashboard.
- **[Supabase](https://supabase.com)** — create a project, then Settings → Database → Connection
  string → URI. Use the **pooler** URI (port 6543) if you plan to deploy serverless.

Postgres 14+ is enough. Nothing here needs an extension: full-text search is native.

### 2. Put the connection string in `.env`

```bash
cp .env.example .env
```

Paste the URL after `DATABASE_URL=`. Add a workspace id — any stable string:

```
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
STRATA_WORKSPACE_ID=ws-personal
```

**Do not paste the connection string into a chat, a commit, or an issue.** It contains a password.
`.env` is gitignored, and `db:setup` only ever prints host and database name, never the URL.

### 3. Apply the schema and check it

```bash
npm run db:setup
```

This does more than connect. It verifies the things ADR 0004 actually depends on: that the
`english` text-search config exists and `ts_rank_cd` returns a nonzero rank, that the GIN index
landed, and that a full round trip through the real store works — upsert twice with different
minted ids, confirm the stored id wins, then search and find it. It deletes its probe rows after.

Expected output ends with `Database ready.`

If a check fails, the message names which one. `--check` re-runs the verification without
re-applying DDL.

---

## What each task unblocks

| Task | Unblocks |
| --- | --- |
| Database exists | M4: screens read real ranked results instead of fixtures |
| | M5: ingested Markdown actually persists |
| | M6: the MCP server runs against real data, and the R2 red-team pass becomes possible |

Until then, all three are built and tested against PGlite — the code is done, it just has nowhere
to write.

---

## Not your task, and deliberately so

**Authentication does not exist.** `packages/auth` exports `localDevScope`, which is a labelled
development stub: anything able to start the process gets the configured workspace. There is no
credential, no verification, and no revocation.

That is fine for a local single-user vault. It is **not** acceptable for anything shared or hosted.
Real per-connection principals are M7 (see R7 in the risk register). Do not deploy this to a shared
environment on the assumption that the tenancy model protects you — the tenancy model is sound, but
nothing authenticates the caller yet.
