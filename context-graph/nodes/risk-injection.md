---
id: risk-injection
kind: risk
title: Prompt injection via ingested content
status: blocked
owner: product
spec: docs/plan/04-risk-register.md
depends_on: []
---

Strata's entire corpus is model-generated prose, served back to models over MCP. Ingested content
is untrusted input that will be read as text by an agent. Mitigation strategy must be settled
before any mutating MCP tool exists.

Red-teamed 2026-07-29: `apps/mcp/src/injection.test.ts` drives hostile documents through the real
route — ingest, PostgreSQL, a real MCP client. Covers fence forgery, a mimicked preamble,
instructions in title/tags/folder, bidi and zero-width hiding, error-channel smuggling, and NUL
identity forgery.

One limit is recorded as a passing test rather than left implicit: plausible prose is delivered
verbatim by design. ADR 0005 rejected stripping suspicious phrasing as unbounded and lossy, since
this corpus will legitimately contain documents *about* prompt injection. The mitigation is the
label, not removal. The suite demonstrates enumerated attacks failing; it does not prove injection
impossible.
