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

        {/*
          R8: "Ask agent about this" is a feature drawn as a button. The handoff specifies a filled
          accent CTA and nothing behind it — which agent, whose credentials, what happens to the
          response, whether it is stored. None of that is decided.

          It shipped looking live, and a reader duly clicked it and got nothing. The register's own
          instruction is "do not let it ship looking functional", so the fix is not to wire it up —
          that would be inventing the feature — but to stop it lying. A real disabled button, an
          honest label, and one line saying why. The handoff's geometry is kept so the layout still
          matches; only the affordance changes.
        */}
        <button
          type="button"
          className={styles.cta}
          disabled
          aria-describedby="cta-note"
          style={{ background: accent.default }}
        >
          Ask agent about this
        </button>
        <p id="cta-note" className={styles.ctaNote}>
          Not built yet — this needs a decision about which agent runs, under whose credentials, and
          what happens to the answer.
        </p>
      </div>
    </div>
  );
}
