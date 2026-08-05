---
id: guarantee-access-log
kind: decision
title: The audit trail records who read what, and never what it said
status: done
owner: core
spec: packages/storage/src/access-log.ts:1
depends_on: [dec-untrusted-content, contract-agent-token]
---

ADR 0005 section 5, promised when the fencing strategy was designed and not built for the whole of M6. It is the compensating control for that ADR's own admission that fencing reduces the likelihood and blast radius of injection without eliminating it — so until this landed, an injection that *succeeded* left no record at all. Detection was the fallback, and the fallback did not exist.

It rose in priority when the project's audience became a few teammates rather than one person. "You cannot see who read what" is a theoretical gap with one user and a day-two problem with several.

**Never stores content — only a SHA-256 of the response.** This is the guarantee, and the reasoning is ADR 0005's own: a log holding the payload is a *second copy of the problem*. It sits outside every fence, it is read by whoever is debugging an incident, and it inherits none of the retention that applies to documents. A hash can answer "was this the same response as that one" and cannot answer "what did it say", which is the correct amount of power for an audit trail. The first test in `apps/mcp/src/access-log.test.ts` asserts the body, title, and excerpt are all absent from the table after a real `get_doc`.

Note the consequence, recorded rather than asserted away: `get_doc` mints a fresh nonce per response, so two identical reads hash *differently*. The hash identifies a response, not a document.

**Recording is fire-and-forget and can never fail the request it records.** An audit trail that can take down the thing it audits is worse than none, because the outage arrives at exactly the moment the log is most interesting. `ServerDeps.log` is optional and every call site is `void ... .catch(() => {})`. Tested with a log that rejects on every call: the tool surface still works.

**Failures are logged too, and the `Unauthorized` rows are the point.** A stream of them is what a credential being probed looks like. `principal_id` is NULL exactly there — a request that failed to authenticate has no principal, and inventing one would be worse than the null.

`docIdsIn` walks the whole response structurally and collects only KEYS named `doc_id`, never values. Same discipline as `guarantee-fencing`: do not enumerate channels, walk the structure — so a tool added later is covered without an edit here, and no content can reach the log through this path even by accident.

Open, and deliberately not solved here: retention. Nothing prunes this table. It is append-only and unbounded, and the right policy depends on a product decision nobody has made. Recorded so it is not mistaken for an oversight.
