'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Doc } from '@strata/core';
import { accent } from '@strata/tokens';
import { formatDate } from '../lib/format-date';
import { MarkdownBody } from './MarkdownBody';
import { DocAssistant } from './DocAssistant';
import styles from './ReaderScreen.module.css';

/**
 * screen-reader — design/handoff/README.md:27-31, Vault.dc.html:148-186.
 *
 * Content column (source/folder label → serif title → metadata divider → markdown body) +
 * right rail (tags → related docs → interactive "Ask agent" CTA and assistant drawer).
 * Stacks below 860px via CSS only.
 */
export interface RelatedDoc {
  readonly id: string;
  readonly title: string;
}

export function ReaderScreen({
  doc,
  source,
  related,
}: {
  doc: Doc & { readonly body: string };
  source: { readonly name: string };
  related: readonly RelatedDoc[];
}) {
  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <div className={styles.screen}>
      <div className={styles.contentWrap}>
        <div className={styles.content}>
          <div className={styles.label} style={{ color: accent.default }}>
            {source.name} · {doc.folder.value}
          </div>
          <h1 className={`serif ${styles.title}`}>{doc.title}</h1>
          {/* UNSPECIFIED: handoff metadata line is "date · reviewer" (Vault.dc.html:154); there is
              no reviewer field on Doc or Source, so only the date renders — see DEVIATIONS. */}
          <div className={styles.meta}>{formatDate(doc.updatedAt)}</div>

          <div className={`serif ${styles.body}`}>
            <MarkdownBody body={doc.body} />
          </div>
        </div>
      </div>

      <div className={styles.rail}>
        <div>
          <div className={styles.railLabel}>Tags</div>
          <div className={styles.tagList}>
            {doc.tags.value.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div>
          <div className={styles.railLabel}>Related</div>
          <div className={styles.relatedList}>
            {related.map((relatedDoc) => (
              <Link key={relatedDoc.id} href={`/reader/${relatedDoc.id}`} className={styles.related}>
                {relatedDoc.title}
              </Link>
            ))}
          </div>
        </div>

        {/*
          R8: "Ask agent about this" is now an interactive assistant drawer.
          Clicking toggles the assistant conversation panel with security-fenced prompt delivery.
        */}
        <button
          type="button"
          className={styles.cta}
          onClick={() => setAssistantOpen((prev) => !prev)}
          style={{ background: accent.default }}
        >
          {assistantOpen ? 'Hide assistant' : 'Ask agent about this'}
        </button>

        {assistantOpen && (
          <DocAssistant
            docId={doc.id}
            docTitle={doc.title}
            docFolder={doc.folder.value}
            onClose={() => setAssistantOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

