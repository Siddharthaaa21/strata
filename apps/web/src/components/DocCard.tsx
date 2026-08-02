import Link from 'next/link';
import { sourceTint, type SourceKind } from '@strata/tokens';
import type { DocListItem, SourceListItem } from '../lib/vault';
import { relativeTime } from '../lib/relative-time';
import styles from './DocCard.module.css';

/**
 * comp-doc-card — design/handoff/README.md:17, Vault.dc.html:100-108.
 *
 * Takes the flat projection from `loadLibrary`, not a domain `Doc`: the card renders derived
 * *values*, and the provenance a `Derived<T>` carries is a retrieval concern, not a display one.
 * Keeping the projection flat also means no `workspaceId` can reach the client by accident.
 */
export function DocCard({ doc, source }: { doc: DocListItem; source: SourceListItem | undefined }) {
  const tint = sourceTint[(source?.kind ?? 'markdown') as SourceKind];

  return (
    <Link href={`/reader/${doc.id}`} className={styles.card}>
      <div className={styles.body}>
        <span className={styles.source} style={{ color: tint.fg }}>
          {source?.name ?? 'Unknown source'}
        </span>
        <h3 className={`serif ${styles.title}`}>{doc.title}</h3>
        <p className={styles.excerpt}>{doc.excerpt}</p>
        <div className={styles.meta}>
          {doc.folder} · {relativeTime(doc.updatedAt)}
        </div>
      </div>
    </Link>
  );
}
