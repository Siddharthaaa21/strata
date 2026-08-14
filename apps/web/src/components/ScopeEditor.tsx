'use client';

/**
 * Changing what one agent reaches, without minting a new credential.
 *
 * Until now the only lever on this screen was Revoke — so narrowing an over-scoped agent meant
 * destroying it, creating a replacement, and redeploying whatever holds the token. That is a large
 * enough cost that the realistic outcome is the over-scoped agent simply stays.
 *
 * THE THREE STATES ARE NOT A CHECKBOX LIST. `undefined` reaches every source, `[]` reaches none, and
 * a list reaches those. An empty checkbox list and "every source" are opposites, and a UI where
 * unticking the last box silently means "everything" would be the most dangerous control in the app.
 * So the mode is an explicit choice, and the checkboxes only exist inside one of its branches.
 *
 * Reach is stated back in the same words the row above uses, so what you are about to commit reads
 * identically to what is already there.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import styles from './AgentAccessScreen.module.css';

type Mode = 'all' | 'some' | 'none';

export interface ScopeEditorSource {
  readonly id: string;
  readonly name: string;
}

function modeOf(sourceIds: readonly string[] | undefined): Mode {
  if (sourceIds === undefined) return 'all';
  return sourceIds.length === 0 ? 'none' : 'some';
}

export function ScopeEditor({
  principalId,
  name,
  sourceIds,
  sources,
}: {
  principalId: string;
  name: string;
  sourceIds?: readonly string[] | undefined;
  sources: readonly ScopeEditorSource[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(() => modeOf(sourceIds));
  const [picked, setPicked] = useState<readonly string[]>(() => sourceIds ?? []);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState('');
  const [failed, setFailed] = useState(false);
  const router = useRouter();

  // `some` with nothing ticked is `none` by another name. Rather than silently submitting deny-all
  // under a label that says "only these", the control refuses and says so.
  const emptySome = mode === 'some' && picked.length === 0;

  function submit() {
    const next: readonly string[] | null = mode === 'all' ? null : mode === 'none' ? [] : picked;
    const describe =
      mode === 'all'
        ? 'every source in this workspace'
        : mode === 'none'
          ? 'nothing at all'
          : `${picked.length} source${picked.length === 1 ? '' : 's'}`;

    // Confirmed, like Revoke, and for a weaker but real version of the same reason: this takes
    // effect on the agent's very next call, with no cache to wait out and no undo beyond setting it
    // back. Widening is the direction worth pausing on.
    if (!window.confirm(`Change “${name}” to reach ${describe}?`)) return;

    startTransition(async () => {
      setResult('');
      setFailed(false);
      try {
        const { rescope } = await import('../app/agent-access/actions');
        const report = await rescope(principalId, next);
        // Reports what the DATABASE did, never an optimistic "saved" — D16's lesson, the same one
        // RevokeButton follows. A refusal (revoked agent, wrong workspace) comes back as zero, and
        // an operator who reads "saved" over a zero stops checking.
        setResult(
          report.grantsReplaced === 0
            ? 'Nothing changed — this agent may have been revoked. Reload and check.'
            : `Updated. ${report.tokensRepointed} token(s) now use the new scope.`,
        );
        setFailed(report.grantsReplaced === 0);
        if (report.grantsReplaced > 0) setOpen(false);
        router.refresh();
      } catch (err) {
        setFailed(true);
        setResult(err instanceof Error ? err.message : 'That change could not be applied.');
      }
    });
  }

  if (!open) {
    return (
      <>
        <button type="button" className={styles.button} onClick={() => setOpen(true)}>
          Change scope
        </button>
        {result !== '' && <p className={failed ? styles.noteError : styles.note}>{result}</p>}
      </>
    );
  }

  return (
    <div className={styles.scopeEditor}>
      <fieldset className={styles.scopeModes}>
        <legend className={styles.scopeLegend}>This agent may read</legend>

        {(
          [
            ['all', 'Every source in this workspace'],
            ['some', 'Only the sources I pick'],
            ['none', 'Nothing — deny every source'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className={styles.scopeMode}>
            <input
              type="radio"
              name={`scope-${principalId}`}
              checked={mode === value}
              onChange={() => setMode(value)}
              disabled={pending}
            />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      {mode === 'some' && (
        <div className={styles.scopeSources}>
          {sources.length === 0 ? (
            <p className={styles.note}>This workspace has no sources yet.</p>
          ) : (
            sources.map((s) => (
              <label key={s.id} className={styles.scopeSource}>
                <input
                  type="checkbox"
                  checked={picked.includes(s.id)}
                  disabled={pending}
                  onChange={(e) =>
                    setPicked((prev) =>
                      e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                    )
                  }
                />
                <span>{s.name}</span>
              </label>
            ))
          )}
          {/*
            Named rather than silently corrected. Unticking the last box is a plausible way to mean
            deny-all, and it is also a plausible slip — so it asks instead of guessing, because the
            two readings differ by the entire vault.
          */}
          {emptySome && (
            <p className={styles.noteError}>
              Nothing is ticked. Choose “Nothing — deny every source” if that is what you mean.
            </p>
          )}
        </div>
      )}

      <div className={styles.scopeActions}>
        <button type="button" className={styles.button} disabled={pending || emptySome} onClick={submit}>
          {pending ? 'Saving…' : 'Save scope'}
        </button>
        <button
          type="button"
          className={styles.buttonQuiet}
          disabled={pending}
          onClick={() => {
            // Back to what the server last told us, not to whatever was half-typed.
            setMode(modeOf(sourceIds));
            setPicked(sourceIds ?? []);
            setResult('');
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>

      {result !== '' && <p className={failed ? styles.noteError : styles.note}>{result}</p>}
    </div>
  );
}
