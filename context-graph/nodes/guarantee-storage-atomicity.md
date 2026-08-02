---
id: guarantee-storage-atomicity
kind: decision
title: Storage upsert atomicity via single CTE
status: done
owner: core
spec: packages/storage/src/driver.ts:1
depends_on: [contract-doc]
---

The upsert operation writes docs and doc_bodies together in a single data-modifying CTE. Previously two unwrapped queries could leave a bodyless document between them if a crash or network partition occurred—searchable but unreadable, and never repaired on retry (reported as unchanged). This guarantees all-or-nothing semantics: either the full write succeeds or neither table is modified, and a retry converges rather than diverges.
