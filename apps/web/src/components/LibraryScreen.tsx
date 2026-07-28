'use client';

import { useMemo, useState } from 'react';
import { docs, sources, type Source, type SourceId } from '@strata/core';
import { DocCard } from './DocCard';
import styles from './LibraryScreen.module.css';

const ALL = 'All';

/**
 * screen-library — design/handoff/README.md:14-19.
 *
 * Header (title + subtitle) → pill filter row → responsive doc-card grid. Filters are folder-based
 * (`libraryFilters` in Vault.dc.html:94 enumerates folder names), applied client-side over
 * `packages/core` fixtures. No backend — this is real interaction over mock data, per D8.
 */
export function LibraryScreen() {
  const sourcesById = useMemo(() => {
    const map = new Map<SourceId, Source>();
    for (const source of sources) map.set(source.id, source);
    return map;
  }, []);

  const folders = useMemo(() => {
    const unique = new Set(docs.map((doc) => doc.folder.value));
    return [ALL, ...[...unique].sort()];
  }, []);

  const [activeFilter, setActiveFilter] = useState<string>(ALL);

  const filteredDocs = activeFilter === ALL ? docs : docs.filter((doc) => doc.folder.value === activeFilter);

  return (
    <div className={styles.screen}>
      <div>
        <h1 className={`serif ${styles.title}`}>Library</h1>
        <p className={styles.subtitle}>
          {docs.length} docs from {sources.filter((s) => s.status === 'connected').map((s) => s.name).join(', ')}.
        </p>
      </div>

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

      <div className={styles.grid}>
        {filteredDocs.map((doc) => {
          const source = sourcesById.get(doc.sourceId);
          return source ? <DocCard key={doc.id} doc={doc} source={source} /> : null;
        })}
      </div>
    </div>
  );
}
