import assert from 'node:assert/strict';
import { test } from 'node:test';
// Node's native TS runner resolves ESM specifiers literally (unlike tsc's "bundler" mode
// elsewhere in this repo), so these need explicit extensions to run under `node --test`.
import type { Grant, GrantId, Principal, PrincipalId, SourceId, WorkspaceId } from './index.ts';
import { mintScope } from './scope-internal.ts';

const workspaceId = 'ws-a' as WorkspaceId;
const otherWorkspaceId = 'ws-b' as WorkspaceId;
const principalId = 'pr-1' as PrincipalId;

function principal(overrides: Partial<Principal> = {}): Principal {
  return { id: principalId, kind: 'agent', workspaceId, ...overrides };
}

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: 'gr-1' as GrantId,
    workspaceId,
    principalId,
    createdAt: '2026-07-28T00:00:00Z',
    ...overrides,
  };
}

test('mints a Scope for a matching principal and grant', () => {
  const scope = mintScope(principal(), grant());
  assert.equal(scope.workspaceId, workspaceId);
  assert.equal(scope.principal.id, principalId);
  assert.equal(scope.grant.id, 'gr-1');
});

test('rejects a revoked grant', () => {
  assert.throws(
    () => mintScope(principal(), grant({ revokedAt: '2026-01-01T00:00:00Z' })),
    /revoked/i,
  );
});

// Regression: `if (grant.revokedAt)` was a truthiness check, so a `revokedAt: ''` value (an empty
// but present string — e.g. from a row mapper doing `?? ''`) minted a Scope for a revoked grant.
// `exactOptionalPropertyTypes` treats "optional means genuinely absent" (data-contracts rule 4);
// the check must be presence-based (`!== undefined`), matching scopeFilter/inGrant elsewhere in
// this package.
test('treats a present-but-falsy revokedAt as revoked, not active', () => {
  assert.throws(() => mintScope(principal(), grant({ revokedAt: '' })), /revoked/i);
});

test('rejects a grant issued to a different principal', () => {
  assert.throws(
    () => mintScope(principal(), grant({ principalId: 'pr-2' as PrincipalId })),
    /does not match/i,
  );
});

test('rejects a grant for a different workspace than the principal', () => {
  assert.throws(
    () =>
      mintScope(
        principal({ workspaceId: otherWorkspaceId }),
        grant({ workspaceId, principalId }),
      ),
    /does not match/i,
  );
});

test('carries sourceIds narrowing through to the minted Scope', () => {
  const sourceIds = ['src-a' as SourceId];
  const scope = mintScope(principal(), grant({ sourceIds }));
  assert.deepEqual(scope.grant.sourceIds, sourceIds);
});
