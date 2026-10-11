'use client';

/**
 * The Import screen's one working control.
 *
 * These labels have been inert since M3 — inherited from the handoff, where README:75-76 marks them
 * as visual endpoints — while both backends worked perfectly from a terminal. A control naming a
 * capability the system genuinely has, and not providing it, is the same defect as the Agent Access
 * nav item that 404'd. It got worse before it got better: relabelling Claude's from `Connect` to
 * `Import` described the mechanism accurately and made the dead control read as more actionable.
 *
 * GitHub keeps a disabled `Connect`, honestly, because there is no adapter behind it yet. The
 * distinction this file draws is exactly the one the screen was failing to draw: a control is live
 * when something is there to run, and visibly not when there isn't.
 */

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import styles from './ConnectorRow.module.css';

export type ConnectorActionKind = 'markdown' | 'claude';

const CONFIG: Record<ConnectorActionKind, { label: string; accept: string; multiple: boolean; field: string }> = {
  // `.json` only, and the wrong JSON from the export ZIP throws with a message naming what was
  // expected — the likeliest mistake, and one "0 imported" would hide.
  claude: { label: 'Import', accept: '.json,application/json', multiple: false, field: 'file' },
  markdown: { label: 'Upload', accept: '.md,.markdown,text/markdown', multiple: true, field: 'files' },
};

export function ConnectorAction({ kind, color }: { kind: ConnectorActionKind; color: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const config = CONFIG[kind];

  return (
    // A wrapper, not a fragment. The row is a flex container, so a bare result `<div>` would become
    // a sibling flex ITEM and shove the action out of its column the moment an import reports back.
    <div className={styles.actionWrap}>
      <input
        ref={input}
        type="file"
        hidden
        accept={config.accept}
        multiple={config.multiple}
        /*
         * NO `webkitdirectory`, and the reason is worth recording because the first version had it.
         *
         * It was added to make Markdown a FOLDER pick, so a nested vault would keep its structure
         * and the derived `folder` field would mean something. The comment claimed it "degrades to
         * a multi-file pick where unsupported". It does not degrade. In Chrome it REPLACES file
         * selection: `accept` is ignored, and the picker offers folders only — so somebody handed
         * three `.md` files cannot select them at all. Caught by driving the real control in a real
         * browser, which is the only thing that would have caught it.
         *
         * `multiple` alone is the honest trade. Loose files work, many-at-once works, and nesting
         * is lost — `relativePath` already falls back to the bare filename for that case. Losing
         * nesting costs the derived `folder` for a handful of files; being unable to pick a file at
         * all costs the whole control. `npm run ingest` stays the tool for a whole vault, which is
         * what the size-limit message already tells people.
         */
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length === 0) return;

          const form = new FormData();
          for (const f of files) form.append(config.field, f);
          // Cleared immediately so choosing the SAME file twice fires onChange again — otherwise a
          // failed import cannot be retried without picking something else first.
          e.target.value = '';

          startTransition(async () => {
            setMessage('');
            setFailed(false);
            try {
              const { uploadClaudeExport, uploadMarkdown } = await import('../app/import/actions');
              const res = kind === 'claude' ? await uploadClaudeExport(form) : await uploadMarkdown(form);

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
              // "Nothing changed" is a real, common outcome for a re-import, and it deserves to be
              // said rather than left as an empty string that reads like a broken button.
              setMessage(parts.length === 0 ? 'Nothing to import.' : parts.join(', ') + '.');
              // Re-render from the server so the connector's status and Recent imports catch up.
              router.refresh();
            } catch (err) {
              // The action's own message only. These are written to be safe — they name the
              // expectation or the limit, never file content (ADR 0003's sanitized-message rule).
              setFailed(true);
              setMessage(err instanceof Error ? err.message : 'The import failed.');
            }
          });
        }}
      />
      <button
        type="button"
        className={styles.actionButton}
        style={{ color }}
        disabled={pending}
        onClick={() => input.current?.click()}
      >
        {pending ? 'Importing…' : config.label}
      </button>
      {message !== '' && (
        // `role="status"` so the outcome is announced. An import finishes with no visual movement
        // other than this line; a screen-reader user would otherwise get silence and a button that
        // stopped saying "Importing…".
        <div role="status" className={failed ? styles.actionError : styles.actionResult}>
          {message}
        </div>
      )}
    </div>
  );
}
