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

### 4. Enable Supabase Auth and add its keys — 10 minutes

This is the front door. Until it is configured, **every page throws**, deliberately: there is no
unauthenticated fallback and no development stub, because a web app that quietly drops to an
open mode when a variable is unset is one misconfigured deploy away from serving the whole vault.

In the Supabase dashboard:

1. **Authentication → Providers → Email.** Enable it. Turn **"Confirm email" ON** — the allowlist
   matches on email address, so an unverified address means anyone can claim a colleague's. The
   verifier refuses unverified tokens regardless (see `allowUnverifiedEmail`), so leaving this off
   just means nobody can sign in.
2. **Authentication → URL Configuration.** Add redirect URLs:
   `http://localhost:3000/auth/callback` and, once deployed, `https://<your-app>/auth/callback`.
3. **Project Settings → API.** Copy the **Project URL** and the **anon / publishable** key.

Add to `.env`:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the anon key>
```

> **Never the `service_role` key.** It bypasses every check in this codebase. The anon key is public
> by design — it ships to the browser and is meant to.

**Restart the dev server after editing these two.** Unlike everything else in `.env`, they are not
read at runtime: `next.config.ts` reads them at *config* time and Next substitutes them into the
client bundle as literals (D18). A running server holds the values it started with, so an edit does
nothing until it restarts — and the symptom is a sign-in button that hangs on "Sending…".

**Open the emailed link in the browser you requested it from.** The sign-in uses PKCE: requesting a
link stores a one-time verifier in that browser, and the callback needs it. A link opened anywhere
else — a mail app's built-in browser, a different browser, another device — cannot complete, and
fails in a few milliseconds without ever contacting Supabase. If your mail client opens links
somewhere unhelpful, copy the link and paste it into the right browser. Since D19 the app says so
instead of looping silently; `[auth/callback]` lines in the server log name the reason.

**On the free plan, the built-in mailer sends two emails per hour.** That is enough to sign in and
not much more, so get the configuration right before spending one. A cheap way to test the whole
browser → Supabase path without sending anything: submit the sign-in form with a malformed address
such as `probe@`. Supabase rejects the format before it sends, so `Unable to validate email address`
appearing under the form proves the key, the URL and the network path are all good.

**One optional variable, and only for older projects.** Current Supabase projects sign tokens with
asymmetric keys, which this app fetches from the project's public JWKS endpoint automatically —
nothing to configure. If your project uses the legacy shared secret (Project Settings → API → JWT
Settings shows a **JWT Secret**), add it:

```
SUPABASE_JWT_SECRET=<the JWT secret>
```

Setting it switches verification to HS256. Unlike the anon key this one **is** a secret: it signs
tokens, so anyone holding it can mint a session as anybody.

### 5. Mint a CLI token

`npm run ingest` and `npm run search` authenticate like every other caller. There is no anonymous
mode and no development stub — `localDevScope` is deleted (M7 increment 2), so a credential is the
only way in.

```bash
npm run agent:create -- "Local CLI" --kind service --by <your member email>
```

Put the printed `STRATA_AGENT_TOKEN=…` line into `.env` renamed to `STRATA_CLI_TOKEN=…`. It is
shown once and cannot be recovered; mint a new one if you lose it and revoke the old.

Chicken-and-egg: `--by` requires a member who has signed in at least once, so do step 6 first if
this is a brand-new workspace.

### 6. Add yourself to the allowlist

The allowlist is the invite. A valid Google or email account is not access — membership is, and it
is ours to decide rather than the provider's.

```bash
npm run member -- add you@example.com
```

Then `npm run dev`, sign in, and follow the emailed link. Your principal and grant are created on
first successful sign-in. Add teammates the same way; `npm run member -- list` shows who has
actually signed in versus who is merely invited.

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

**The MCP server now authenticates its caller.** `STRATA_AGENT_TOKEN` names a principal, its
workspace, and its grant, verified on every tool call. Create one:

```bash
npm run agent:create -- "Claude Code — my laptop"
```

The token is printed once and cannot be recovered; the script does not write it anywhere. Paste the
`STRATA_AGENT_TOKEN=` line into `.env`. To narrow an agent to specific sources, pass
`--sources src-markdown`; to test the gate, `--sources ''` creates a deny-all grant.

Revocation takes effect on the **next call**, with no restart and nothing to invalidate:

```sql
UPDATE agent_tokens SET revoked_at = now() WHERE principal_id = '<id>';
```

**The web app is still unauthenticated.** `packages/auth` still exports `localDevScope` for it — a
labelled development stub where anything able to start the process gets the configured workspace.
Human sessions are increment 2 of ADR 0006.

**And be clear about what a stdio token does not buy: confidentiality.** This server reads
`DATABASE_URL` from `.env` itself, deliberately, so that no client config holds a secret. Anything
that can launch the process can therefore also connect to Postgres directly and bypass every check
in the tool layer. The token buys **attribution** (which agent, not "somebody"), **narrowing**
(per-agent `Grant.sourceIds`), and **revocation**. Containment arrives with remote transport, where
the server holds the credential and the client does not.

That is fine for a local single-user vault. It is **not** acceptable for anything shared or hosted.
Do not deploy this to a shared environment on the assumption that the tenancy model protects you —
the tenancy model is sound, but nothing authenticates the caller yet.

**The design now exists**: `docs/adr/0006-authentication.md` decides it, and its increment 0 has
landed — `Grant.sourceIds` gates every store method, reads and writes alike, so a narrowed grant
means something before one is ever issued. Increment 1 (agent tokens over stdio) is what makes the
sentence above stop being true. Until it ships, this section stands as written.

One thing that ADR is explicit about and is worth knowing before you wire anything up: even once
agent tokens exist, a token in a **stdio** client config buys attribution, per-agent scoping, and
revocation — but **not** confidentiality. This server reads `DATABASE_URL` itself (deliberately, so
your client config holds no secret), so anything that can launch it can reach the database directly.
Containment arrives with remote transport, where the server holds the credential and the client
does not.

---

## Connecting an agent to the vault

The MCP server is read-only: `search_docs`, `get_doc`, `list_sources`. It reads `DATABASE_URL` and
`STRATA_WORKSPACE_ID` from the repo's `.env` itself, so **no client config contains a secret**.

Verify it works before wiring any client:

```bash
npm run mcp:smoke
```

That spawns the real server as a subprocess and drives it with a real MCP client over stdio —
process spawn, env loading, pool creation, stdio framing, shutdown. The in-repo tests use an
in-memory transport and prove the handlers; this proves the entrypoint.

### Claude Code

`.mcp.json` at the repo root already declares it. Claude Code picks up project-scoped servers
automatically and will ask for approval the first time. Nothing else to do.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and merge in:

```json
{
  "mcpServers": {
    "strata": {
      "command": "node",
      "args": ["/absolute/path/to/design_handoff_strata_workspace/apps/mcp/src/index.ts"]
    }
  }
}
```

Absolute paths are required — Claude Desktop does not launch from the repo. Restart the app after
editing.

### What an agent can and cannot do

Can: search the vault, read one document at a time, list connected sources.

Cannot: write, delete, trigger a sync, or reach another workspace. There are no mutating tools
(D5), and every tool re-checks scope itself.

**One caveat worth stating plainly.** There is no authentication (R7/M7). Anything able to start
this process gets the workspace named in `.env`. That is fine for a local vault on your own
machine; do not expose this server over a network on the assumption that tenancy protects you —
tenancy is sound, but nothing authenticates the caller yet.
