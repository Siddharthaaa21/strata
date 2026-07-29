import Link from 'next/link';
import type { Doc, Source } from '@strata/core';
import { docs } from '@strata/core';
import { accent } from '@strata/tokens';
import { formatDate } from '../lib/format-date';
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
export function ReaderScreen({ doc, source }: { doc: Doc; source: Source }) {
  const others = docs.filter((d) => d.id !== doc.id);
  const sameFolder = others.filter((d) => d.folder.value === doc.folder.value);
  const rest = others.filter((d) => d.folder.value !== doc.folder.value);
  const related = [...sameFolder, ...rest].slice(0, 3);

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
            <p>
              Placeholder reading content. <code>Doc</code> intentionally has no <code>body</code> field (see the
              &ldquo;body separability&rdquo; note in <code>packages/core/src/index.ts</code>), so this paragraph
              and the ones below exist only to demonstrate the reader&rsquo;s type scale and rhythm at a realistic
              length — they are not a description of this document&rsquo;s actual contents.
            </p>
            <div className={styles.heading}>Section heading</div>
            <p>
              Section headings in the reader body sit at 20px/600, a step below the reader title and a step above
              body copy, giving long-form placeholder text a scannable shape without any real prose driving it.
            </p>
            <div className={styles.heading}>Example code block</div>
            <div className={styles.code}>placeholder_key = hash(doc_id, source_id, updated_at)</div>
            <p>
              The monospace block above is the one code sample the reader design calls for — light background, no
              border, 14px/monospace — again standing in for whatever a real document body would contain.
            </p>
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
