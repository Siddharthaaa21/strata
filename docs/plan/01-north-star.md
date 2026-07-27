# North star

## What Strata is

A knowledge base for AI-generated engineering documents, with two readers of equal standing: the
engineer in the web app, and the agent over MCP.

## The one sentence that decides arguments

**If a change makes the vault better for humans and worse for agents, it is the wrong change.**

Note-taking tools that are good for humans already exist. The reason to build Strata is that
Claude, Cursor, and coding agents now generate more durable engineering prose than the team does,
and none of it is retrievable by the next agent that needs it. The agent-facing side is the
product; the web app is how humans supervise it.

This is why `Doc` is designed for metadata-first retrieval, why the MCP surface gets an architect
and a verifier pass on the same change, and why "make the Library prettier" is never the priority
over "make search_docs return the right five documents."

## Who it is for

A small engineering team that already generates AI docs across several tools and has no shared
place for them. Not an enterprise wiki. Not a personal notes app.

## What good looks like

- An agent asked "how do we handle idempotency in the ledger service?" finds the right document
  from metadata alone, without loading six wrong ones first.
- An engineer finds a doc a teammate generated three weeks ago in one search, having never known
  it existed.
- Connecting a source is the last manual step; nothing needs filing by hand afterward.

## Explicit non-goals

These are decided, not open. Reopening one needs a decision-log entry.

- **Not an editor.** Strata ingests and serves. Authoring happens in the tools that already do it.
- **Not a chat product.** "Ask agent about this" hands context to an agent; it does not become a
  conversation surface.
- **Not real-time collaborative.** Docs are ingested artifacts, not shared live documents.
- **Not a general document store.** Markdown and Markdown-adjacent text. No PDFs, no images, no
  binaries — the handoff's "no imagery" design is the visual expression of this.

## The constraint that shapes everything

Strata serves untrusted, model-generated text to models. A corpus written largely by AI, read
largely by AI, in an environment where text is instruction. Every design decision inherits this:
read-only MCP surface to start, ingested content fenced as data, no ingested text in a tool
description or a control-flow decision, ever.

Treating this as a late-stage security review item rather than a founding constraint is the most
plausible way this product fails badly rather than merely failing.
