'use client';

import { useMemo, useState } from 'react';
import type { DocListItem, SourceListItem } from '../lib/vault';
import { DocCard } from './DocCard';
import styles from './LibraryScreen.module.css';

const ALL = 'All';

/**
 * The interactive half of screen-library. Filtering stays client-side, as the handoff shows
 * (Vault.dc.html:93-97) — the pills are instant, with no round trip.
 *
 * Receives an already-scoped projection. It has no database access and no `Scope`; if this ever
 * needs to filter server-side, the fetch belongs in the Server Component above it.
 */
export function LibraryView({
  docs,
  sources,
}: {
  docs: readonly DocListItem[];
  sources: readonly SourceListItem[];
}) {
  const sourcesById = useMemo(
    () => new Map(sources.map((s) => [s.id, s])),
    [sources],
  );

  const folders = useMemo(
    () => [ALL, ...[...new Set(docs.map((d) => d.folder))].sort()],
    [docs],
  );

  const [activeFilter, setActiveFilter] = useState<string>(ALL);
  const visible = activeFilter === ALL ? docs : docs.filter((d) => d.folder === activeFilter);

  const connected = sources.filter((s) => s.status === 'connected').map((s) => s.name);

  return (
    <div className={styles.screen}>
      <div>
        <h1 className={`serif ${styles.title}`}>Library</h1>
        <p className={styles.subtitle}>
          {docs.length === 0
            ? 'No documents yet. Run `npm run ingest -- <folder>` to add some.'
            : `${docs.length} ${docs.length === 1 ? 'doc' : 'docs'}${
                connected.length ? ` from ${connected.join(', ')}` : ''
              }.`}
        </p>
      </div>

      {docs.length > 0 && (
        <div className={styles.filterRow}>
          {folders.map((folder) => (
            <button
              key={folder}
              type="button"
              className={`${styles.pill} ${activeFilter === folder ? styles.pillActive : ''}`}
              onClick={() => setActiveFilter(folder)}
            >
              {folder}
            </button>
          ))}
        </div>
      )}

      <div className={styles.grid}>
        {visible.map((doc) => (
          <DocCard key={doc.id} doc={doc} source={sourcesById.get(doc.sourceId)} />
        ))}
      </div>
    </div>
  );
}
