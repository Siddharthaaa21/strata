'use client';

/**
 * The one destructive control in the app.
 *
 * Three properties, none of them decoration:
 *
 * 1. **A POST via a server action, never a link.** A GET that revokes is revoked by a link
 *    prefetcher, a crawler, or a browser restoring tabs. The one control that destroys access must
 *    not be reachable by anything that follows URLs speculatively.
 * 2. **Confirmation before it fires.** Revocation is immediate and there is no undo — a new token
 *    has to be minted and distributed. `window.confirm` rather than an invented modal, because this
 *    screen has no design and a hand-rolled dialog would be inventing one under deadline for the
 *    step where being unambiguous matters most.
 * 3. **It reports what the DATABASE did.** The action returns the token count actually revoked, and
 *    that number is what appears. D16's lesson, in the UI: an optimistic "revoked" makes the
 *    operator stop looking, and if it did not happen the credential is still live.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import styles from './AgentAccessScreen.module.css';

export function RevokeButton({ principalId, name }: { principalId: string; name: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState('');
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        className={styles.button}
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Revoke “${name}”? Its tokens stop working immediately and cannot be restored.`)) {
            return;
          }
          startTransition(async () => {
            const { revoke } = await import('../app/agent-access/actions');
            const report = await revoke(principalId);
            setResult(
              report.tokensRevoked === 0
                ? 'Already revoked — no live tokens were found.'
                : `Revoked. ${report.tokensRevoked} token(s) stopped working.`,
            );
            // Re-render from the server so the row moves to Revoked. Without this the button would
            // report success next to a row still presenting itself as connected.
            router.refresh();
          });
        }}
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      {result !== '' && <p className={styles.note}>{result}</p>}
    </>
  );
}
