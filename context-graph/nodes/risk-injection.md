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

Red-teamed 2026-07-29 by the same author as the defenses: `apps/mcp/src/injection.test.ts` drives
hostile documents through the real route — ingest, PostgreSQL, a real MCP client. Covers fence
forgery, a mimicked preamble, instructions in title/tags/folder, bidi and zero-width hiding,
error-channel smuggling, and NUL identity forgery. That suite passed, but an independent adversarial
review (M4 close) found real defects: getDoc returned title/folder/tags raw with no preamble and no
untrustedFields declaration; STRIPPED_RANGES did not cover the Tag block (U+E0000-E007F, ASCII
smuggling) or U+2028/U+2029 (the only line terminators JSON.stringify does not escape).

Round-three review (M7 close) found live defects again: the fencing guard inspected only `content[0]`, never `structuredContent`, skipped non-JSON payloads, and whitelisted any `content` key unguarded. Four tool shapes passed the suite. All defects are fixed (guarantee-fencing, updated untrusted.ts with Unicode property queries, fencing.test.ts structural guard inspecting all channels and requiring nonce envelopes).

Round-four review (M7R4 close) found a live privilege escalation in auth (an `agent_tokens` row could inherit another principal's grant by editing grant_id, because `lookupToken` read principal_id from the wrong row) plus six fencing bypasses (`isNonceFenced` checking only for envelope existence anywhere in the string, not around every marker; `allPayloads` missing embedded resources and `_meta`; `stringLeaves` missing object keys as a channel). All fixed: the escalation is now prevented at both the query level (reading the correct principal_id) and the schema level (composite FK ensuring the write is impossible); the fencing guard now walks the entire result tree and requires every marker inside a matched envelope. See contract-agent-token, dec-auth, guarantee-fencing.

R2 still does NOT close: re-verification is still needed: the strata-verifier pass that closes this risk has not happened. These fixes are the work of the reviewer, not the author — the lesson is reading found these, not writing.

One limit is recorded as a passing test rather than left implicit: plausible prose is delivered
verbatim by design. ADR 0005 rejected stripping suspicious phrasing as unbounded and lossy, since
this corpus will legitimately contain documents *about* prompt injection. The mitigation is the
label, not removal. The suite demonstrates enumerated attacks failing; it does not prove injection
impossible.

ADR 0005 section 5 is now implemented (guarantee-access-log) — it had been listed as an open sub-item of R2 for four review rounds. Only that sub-item closes. R2 itself does NOT: rounds one through four each found real defects in the previous round fixes, and the round-five pass has not reported.
