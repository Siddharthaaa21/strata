---
name: data-contracts
description: The Strata domain shapes — Doc, Source, ImportEvent — and the rules for changing them. Read before touching packages/core, before designing a query or MCP tool signature, and whenever a screen or adapter needs a field that does not exist yet.
---

# Data contracts

`packages/core` is the single source of truth for domain shapes. No screen, adapter, or MCP tool
defines its own. Committed shapes and their rationale live in `docs/plan/03-data-contracts.md`.

## Design principle: the agent is the primary reader

Strata's differentiator is that an MCP client reads this vault. The Library grid is the easy
consumer — it needs a title, an excerpt, a source, and a timestamp. The hard consumer is an agent
deciding *whether to read a document at all* from metadata alone.

So every field answers one of two questions:

- **Retrieval**: would this help an agent decide relevance without loading the body?
- **Provenance**: where did this come from, how was it derived, can it be trusted?

A field that serves neither is probably UI state and does not belong in the contract.

## Derived vs authored

The single most important distinction in this schema. `excerpt`, `folder`, and `tags` are
*inferred* — by heuristic, by model, or set by a user. Each must record which:

```ts
type Provenance = "source" | "heuristic" | "model" | "user";
```

Two things depend on this. A re-sync must never clobber a `user` value with a `model` one. And an
agent must be able to tell a human-curated tag from a guessed one — those warrant different
confidence.

## Changing a shape

1. `npm run graph -- --impact contract-doc` — the real consumer list, not your recollection.
2. Route the change to `strata-architect`. Shape changes are the canonical Opus-tier decision:
   wrong is cheap to write and expensive forever.
3. Update every consumer in the same change, **including the MCP tool schemas** — those are a
   published interface. An agent's stored workflow breaks silently when a field disappears.
4. Update the context-graph node and add a decision-log entry.

## Rules

1. **Ids are opaque strings, never source-derived.** `doc.id` is Strata's. `externalId` is the
   source's. Conflating them makes re-connecting a source a migration.
2. **Timestamps are ISO-8601 UTC strings at rest.** Relative time ("6m ago") is a render concern
   and never persists. The prototype shows only relative time; that is presentation.
3. **Identity is `(sourceId, externalId, contentHash)`.** This is what makes ingestion idempotent.
4. **Body is separable from metadata.** Every retrieval path must be able to fetch metadata
   without the body — this is what makes agent retrieval cheap and it is a hard requirement, not
   an optimization.
5. **Optional means genuinely absent, not "not yet computed."** Use an explicit status for
   pending derivation rather than `undefined`; `exactOptionalPropertyTypes` is on.
6. **No `any` crossing a package boundary.** Parse untrusted input at the edge and hand typed
   values inward.

## Open questions

Several shapes are deliberately not committed yet — see `docs/plan/04-risk-register.md`. Notably:
tenancy (is a `Doc` scoped to a user, a team, or a workspace?) and access control, which cannot be
retrofitted cheaply and blocks the MCP surface. Do not assume a resolution; if a task requires one,
escalate it rather than picking silently.
