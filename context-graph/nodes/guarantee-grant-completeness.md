---
id: guarantee-grant-completeness
kind: decision
title: Grant.sourceIds enforcement completeness via enumerating test
status: done
owner: core
spec: packages/storage/src/grant-completeness.test.ts:1
depends_on: [dec-auth, contract-scope]
---

Every store method that takes a Scope must declare how Grant.sourceIds constrains it, holding the
narrowing invariant for both reads and writes.

`grant-completeness.test.ts` reflects over each store method and enumerates the live surface—so a
method added tomorrow is exercised without editing the test. The suite fails loudly if any method
lacks an entry in its argument table, catching both new methods and new narrowing omissions.

Verified by adding a deliberately-unregistered store method and confirming the suite failed, naming
it exactly. See ADR 0006 §6 and D13 — a claim about what a test would catch is itself testable.
