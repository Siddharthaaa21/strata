import Link from 'next/link';
import type { Doc, Source } from '@strata/core';
import { sourceTint } from '@strata/tokens';
import { relativeTime } from '../lib/relative-time';
import styles from './DocCard.module.css';

/**
 * comp-doc-card — design/handoff/README.md:17, Vault.dc.html:100-108.
 *
 * Whole card is the click target, navigating to the Reader screen. `screen-reader` doesn't exist
 * yet (next build pass) — the route below 404s until then, which is expected.
 */
export function DocCard({ doc, source }: { doc: Doc; source: Source }) {
  const tint = sourceTint[source.kind];

  return (
    <Link href={`/reader/${doc.id}`} className={styles.card}>
      <div className={styles.body}>
        <span className={styles.source} style={{ color: tint.fg }}>
          {source.name}
        </span>
        <h3 className={`serif ${styles.title}`}>{doc.title}</h3>
        <p className={styles.excerpt}>{doc.excerpt.value}</p>
        <div className={styles.meta}>
          {doc.folder.value} · {relativeTime(doc.updatedAt)}
        </div>
      </div>
    </Link>
  );
}
