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

`user_identities` keeps the provider's subject id OUT of `PrincipalId` per ADR 0006 §5 rule 1, enabling provider swaps that rewrite one table instead of every foreign key.

`resolveSession` gates membership check before minting a `Scope` — an unauthenticated Google account cannot manufacture a workspace member. `addMember` and `removeMember` are idempotent and restorative: remove-then-re-add round-trips membership, principal, and grant atomically. Departing member tokens stay revoked deliberately. All implemented in `packages/storage/src/auth-store.ts`.
