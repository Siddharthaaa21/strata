---
id: contract-membership
kind: contract
title: Membership, allowlist, and principal provisioning
status: in-progress
owner: core
spec: packages/auth/src/store.ts
depends_on: [dec-auth, dec-tenancy]
---

The data contract for workspace membership. `memberships` table is keyed on lower-cased email (rejecting capitalization mismatches that lock out the person the invite was written for). `principal_id` is NULL until first sign-in, making the allowlist idempotent: adding an address before authentication, fetching on first successful `SessionClaims`, provisioning principal + grant + identity link in one atomic CTE.

`user_identities` keeps the provider's subject id OUT of `PrincipalId` per ADR 0006 §5 rule 1, enabling provider swaps that rewrite one table instead of every foreign key. It is also **read**, not merely written: `(provider, subject)` is the identity and an invitation is single-use. Email alone selects the invitation; it does not prove who is claiming it. Until the round-five fixes (D16) the read was missing, so a different provider subject presenting the same address inherited the first person's principal.

`resolveSession(workspaceId, claims)` takes the workspace as a PARAMETER — it previously selected on email across every workspace with no `ORDER BY` and took the first row. It gates the membership check before minting a `Scope`: an authenticated Google account cannot manufacture a workspace member.

`addMember` and `removeMember` are idempotent and restorative: remove-then-re-add round-trips membership, principal, and grant. The restored grant **inherits the narrowing** of the one last held rather than defaulting to `NULL` (= every source), and the candidate ordering is total (`revoked_at DESC, created_at DESC, id DESC`) because grants are stamped from two different clocks and a tie decided the difference between a narrowed grant and the whole vault.

`removeMember` revokes the membership, the principal and its tokens — **not grants**, which stay as the record of what the person could reach and as the source `addMember` restores from. It returns counts (`principalsRevoked`, `tokensRevoked`, `unattributedAgents`) so callers report what happened rather than asserting what should have. Departing member tokens stay revoked deliberately.

All implemented in `packages/storage/src/auth-store.ts`.
