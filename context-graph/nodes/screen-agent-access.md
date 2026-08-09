---
id: screen-agent-access
kind: screen
title: Agent Access
status: done
owner: web
spec: apps/web/src/components/AgentAccessScreen.tsx
depends_on: [svc-mcp, contract-source, contract-agent-token, comp-sidebar, dec-tenancy, contract-scope, dec-auth, guarantee-access-log]
---

M7 increment 3. Built 2026-08-09; closes the milestone's "a user can see and revoke what each
connected agent can reach."

**No handoff design exists** — `design/handoff/` covers Library, Import and Reader only. Built
entirely from existing [[tokens-color]] / [[tokens-type]] values, like [[screen-login]], so
designing it later means replacing one CSS module rather than unpicking hardcoded values. The
layout deliberately mirrors [[screen-import]]: single column, same max width, header → list →
section label. Two screens invented in the same week should not also invent two layouts, and these
are siblings in the IA — both are about connections rather than documents.

Everything it does has worked from a terminal since increment 1 (`agent:create`, `member remove`).
This is the part a teammate can use. `mcp:smoke` already proves the property the copy promises: a
revoked token fails on the next call, same connection, no restart.

**Two rules shape every line.**

1. **No credential material reaches the browser.** `last4` and nothing else — not the hash, not the
   token id, not the presented string. Deciding whether a credential should keep existing needs a
   name, a reach, and a last-used, none of which authenticate anything. A management UI able to
   display a secret is a way to leak one over a shoulder. Enforced at the store: `listAgents` never
   selects `token_hash`.
2. **Reach is three distinct cases and stays that way.** `sourceIds` NULL reaches every source,
   `[]` reaches none, a list reaches those. The `?? []` that looks like defensive coding renders the
   most powerful credential in the workspace as the most harmless one, so it appears nowhere on this
   path — see [[contract-scope]].

**Revocation** is a POST through a server action in its own `'use server'` module (that directive
publishes every export in its file, so helpers must not share it). `principalId` comes from a
browser and is a *selector, never an authorization*: the action re-derives scope from the session
cookie and `revokeAgent` filters by the workspace that comes back, so a crafted id from another
workspace matches no row. `window.confirm` before firing, because there is no undo and this screen
has no design to borrow a modal from.

The button reports **what the database did**, not what was intended — `revokeAgent` returns counts
for the same reason `removeMember` does (D16). An optimistic "revoked" makes the operator stop
looking while the credential is still live. Revoked agents stay on screen, greyed, because deleting
the row answers "did that work?" by removing the evidence.

Two findings are surfaced on the row itself rather than left for someone to deduce: an agent that
has **never been used** (the easiest thing here to revoke safely), and an agent with **no recorded
creator** — which cannot be swept up by removing a member, the exact gap `--by` was made mandatory
to close.

**Recent activity — [[guarantee-access-log]] finally reaching a human.** ADR 0005 §5 admits in its
own Open items that fencing reduces injection's likelihood and blast radius without eliminating it,
and names logging as the compensating control for the remainder. So an injection that *succeeds* is
discovered here or not at all. The table has been collected since M6 and read by nobody.

Two rules carried over from the log itself:

- **A count of documents, never their ids or titles.** The log's first rule is that it never holds
  content; a view resolving logged doc ids back to titles would reconstruct — inside the screen
  built for incident response — exactly what the table refuses to store.
- **Failed authentications are counted, not listed.** `recent()` filters on `workspace_id`, and a
  call that failed to authenticate has none — so the rows the schema calls "the point" were
  unreachable by the only reader it had. `unattributedFailures` closes that, as a **count**: those
  entries have no workspace, so there is no honest answer to whose they are, and attributing them to
  whichever workspace happens to be looking would invent one. A count says "something is knocking"
  without claiming to know on whose door.

**Still deferred:** per-agent re-scoping (narrowing an existing grant from the UI). It has a sharp
edge worth designing rather than improvising — the one-active-grant index forces revoke-then-insert,
and `agent_tokens` carries a composite foreign key requiring a token's grant to belong to its own
principal, so the token's `grant_id` has to move in the same statement or the write is rejected.
Member management stays a CLI (ADR 0006 §6b).
