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
  total,
  folders: allFolders,
  query = '',
}: {
  docs: readonly DocListItem[];
  sources: readonly SourceListItem[];
  /** Documents in scope. NOT `docs.length` — that is one clamped page. */
  total: number;
  /** Every folder in scope, queried separately so truncation cannot hide one. */
  folders: readonly string[];
  /**
   * The active search, already run on the SERVER against the whole vault.
   *
   * Present only so this component can describe what it is showing. It must never filter on this
   * value — `docs` is already the ranked result set, and re-filtering here would narrow a
   * whole-vault answer down to whatever also matched a client-side string compare.
   */
  query?: string;
}) {
  const searching = query !== '';
  const sourcesById = useMemo(
    () => new Map(sources.map((s) => [s.id, s])),
    [sources],
  );

  // From the server's folder query, not from `docs`. Deriving pills from the page meant a folder
  // whose documents were all older than the newest fifty had no pill — so the one control that
  // would have surfaced them was itself hidden by the truncation that hid them.
  const folders = useMemo(() => [ALL, ...allFolders], [allFolders]);

  const [activeFilter, setActiveFilter] = useState<string>(ALL);
  const visible = activeFilter === ALL ? docs : docs.filter((d) => d.folder === activeFilter);

  const connected = sources.filter((s) => s.status === 'connected').map((s) => s.name);

  return (
    <div className={styles.screen}>
      <div>
        <h1 className={`serif ${styles.title}`}>
          {searching ? 'Search' : 'Library'}
        </h1>
        <p className={styles.subtitle}>
          {searching ? (
            <>
              {docs.length === 0
                ? `Nothing matches “${query}”.`
                : `${docs.length} ${docs.length === 1 ? 'result' : 'results'} for “${query}”, best first.`}
              {/*
                Named explicitly so an empty result is not read as an empty vault. "No results" on a
                screen headed "Library" is the one message that could make someone conclude their
                document was never imported — and the answer to that is one link away, not a support
                conversation.
              */}
              <span className={styles.truncationNote}>
                {' '}Searched all {total} {total === 1 ? 'document' : 'documents'} in scope.{' '}
                <a className={styles.clearSearch} href="/">
                  Clear search
                </a>
              </span>
            </>
          ) : total === 0 ? (
            'No documents yet. Run `npm run ingest -- <folder>` to add some.'
          ) : (
            `${total} ${total === 1 ? 'doc' : 'docs'}${
              connected.length ? ` from ${connected.join(', ')}` : ''
            }.`
          )}
          {/*
            Stated rather than hidden. The list is one clamped page, and until this screen has a
            pagination design — the handoff has none — the honest thing is to say which documents
            are on screen. Silently showing 50 of 312 under a heading that says "312 docs" is worse
            than either showing all of them or admitting the limit.
          */}
          {!searching && docs.length < total && (
            <span className={styles.truncationNote}>
              {' '}Showing the {docs.length} most recently updated.
            </span>
          )}
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
