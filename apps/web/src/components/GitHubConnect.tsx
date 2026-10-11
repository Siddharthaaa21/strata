'use client';

/**
 * The GitHub row's control.
 *
 * Different in shape from the other two, because GitHub is different in kind: Claude and Markdown
 * take a file you already have, and GitHub takes an ADDRESS it then goes and reads. So this is the
 * one connector that needs an input before it can do anything, and the one whose failures are
 * network failures rather than parse failures.
 *
 * It stays a bare-text control matching the row (Vault.dc.html:122-131) rather than growing a
 * panel: the input appears only once you ask for it, so a screen with nothing connected still reads
 * as three quiet rows.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import styles from './ConnectorRow.module.css';

export function GitHubConnect({ color }: { color: string }) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState('');
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const router = useRouter();

  function submit() {
    if (repo.trim() === '' || pending) return;

    startTransition(async () => {
      setMessage('');
      setFailed(false);
      try {
        const { importGitHub } = await import('../app/import/actions');
        const res = await importGitHub(repo.trim());

        if (!res.ok) {
          setFailed(true);
          setMessage(res.error);
          return;
        }

        const report = res.report;
        const parts = [
          report.created > 0 ? `${report.created} new` : '',
          report.updated > 0 ? `${report.updated} updated` : '',
          report.unchanged > 0 ? `${report.unchanged} unchanged` : '',
          report.failed > 0 ? `${report.failed} failed` : '',
        ].filter(Boolean);

        // `incomplete` is stated FIRST and always. A repository larger than the ceiling produces a
        // partial import whose numbers look exactly like a complete one — the failure this adapter
        // is most exposed to — and a count alone would let it pass as success.
        const summary = parts.length === 0 ? 'Nothing to import.' : parts.join(', ') + '.';
        setMessage(
          report.incomplete
            ? `Partial: only the first files were read. ${summary} Use \`npm run ingest:github\` for the whole repo.`
            : summary,
        );
        setFailed(report.incomplete);
        if (!report.incomplete) setOpen(false);
        router.refresh();
      } catch (err) {
        setFailed(true);
        // The action's own sentence. It never carries GitHub's message, which can quote request URLs
        // and private path names.
        setMessage(err instanceof Error ? err.message : 'That import failed.');
      }
    });
  }

  if (!open) {
    return (
      <div className={styles.actionWrap}>
        <button type="button" className={styles.actionButton} style={{ color }} onClick={() => setOpen(true)}>
          Connect
        </button>
        {message !== '' && (
          <div role="status" className={failed ? styles.actionError : styles.actionResult}>
            {message}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.actionWrap}>
      <div className={styles.repoRow}>
        <input
          className={styles.repoInput}
          type="text"
          value={repo}
          autoFocus
          disabled={pending}
          placeholder="owner/repo"
          aria-label="GitHub repository"
          onChange={(e) => setRepo(e.target.value)}
          // Enter submits, because a one-field form where Enter does nothing feels broken.
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        <button
          type="button"
          className={styles.actionButton}
          style={{ color }}
          disabled={pending || repo.trim() === ''}
          onClick={submit}
        >
          {pending ? 'Reading…' : 'Index'}
        </button>
      </div>
      {message !== '' && (
        <div role="status" className={failed ? styles.actionError : styles.actionResult}>
          {message}
        </div>
      )}
    </div>
  );
}
