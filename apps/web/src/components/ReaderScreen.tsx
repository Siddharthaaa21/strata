import Link from 'next/link';
import type { Doc } from '@strata/core';
import { accent } from '@strata/tokens';
import { formatDate } from '../lib/format-date';
import { MarkdownBody } from './MarkdownBody';
import styles from './ReaderScreen.module.css';

/**
 * screen-reader — design/handoff/README.md:27-31, Vault.dc.html:148-186.
 *
 * Content column (source/folder label → serif title → metadata divider → placeholder body) +
 * right rail (tags → related docs → dead-end "Ask agent" CTA). Stacks below 860px via CSS only.
 *
 * `body` is deliberately absent from `Doc` (see packages/core/src/index.ts "body separability").
 * There is no fixture to wire here — the paragraphs below are inline, obviously-placeholder copy
 * that exists only to demonstrate the reading type scale, not a stand-in for real ingested content.
 */
/** Related is passed in, not computed here: the component has no store and no `Scope`. */
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

        {/* Dead-end visual per docs/plan/02-milestones.md — no onClick, no agent invocation. */}
        <div className={styles.cta} style={{ background: accent.default }}>
          Ask agent about this
        </div>
      </div>
    </div>
  );
}
