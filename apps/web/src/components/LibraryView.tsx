'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { DocListItem, SourceListItem } from '../lib/vault';
import { relativeTime } from '../lib/relative-time';
import { DocCard } from './DocCard';
import styles from './LibraryScreen.module.css';

const ALL = 'All';

function DocListRow({ doc, showFolder = false }: { doc: DocListItem; showFolder?: boolean }) {
  return (
    <Link href={`/reader/${doc.id}`} className={styles.listRow} title={`Open ${doc.title}`}>
      <div className={styles.listLeft}>
        <span className={styles.listIcon}>📄</span>
        <div className={styles.listText}>
          <span className={styles.listTitle}>{doc.title}</span>
          {doc.excerpt && <span className={styles.listExcerpt}>{doc.excerpt}</span>}
        </div>
      </div>
      <div className={styles.listRight}>
        {showFolder && doc.folder && (
          <span className={styles.listFolderBadge}>{doc.folder}</span>
        )}
        <span className={styles.listTime}>{relativeTime(doc.updatedAt)}</span>
        <span className={styles.listArrow}>→</span>
      </div>
    </Link>
  );
}

/**
 * The interactive half of screen-library.
 *
 * FILTERING MOVED TO THE SERVER. The handoff shows instant client-side pills
 * (Vault.dc.html:93-97), and that was implemented literally: `docs.filter(...)` over the array
 * already on screen. It worked only while the whole vault fit in one response. `docs.list` is
 * clamped to 50, so a pill actually meant "documents in this folder among the newest fifty" — and a
 * folder whose documents all sat beyond that rendered an empty grid under its own pill. Paging turns
 * that from a large-vault edge case into the ordinary one.
 *
 * The pills are now links carrying `?folder=`, and the filter runs in SQL against the whole vault.
 * The round trip is the cost of the answer being correct.
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
  folder = '',
  page = 1,
  pageCount = 1,
  firstOnPage = 0,
  lastOnPage = 0,
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
  /** The active folder, resolved on the SERVER. Empty string means every folder. */
  folder?: string;
  /** 1-based and already clamped by the loader against the true count. Never recomputed here. */
  page?: number;
  pageCount?: number;
  /** 1-based position of the first and last document on this page, for the "51-100 of 120" line. */
  firstOnPage?: number;
  lastOnPage?: number;
}) {
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const searching = query !== '';
  const sourcesById = useMemo(
    () => new Map(sources.map((s) => [s.id, s])),
    [sources],
  );

  // From the server's folder query, not from `docs`. Deriving pills from the page meant a folder
  // whose documents were all older than the newest fifty had no pill — so the one control that
  // would have surfaced them was itself hidden by the truncation that hid them.
  const folders = useMemo(() => [ALL, ...allFolders], [allFolders]);
  const activeFilter = folder === '' ? ALL : folder;

  const toggleFolder = (name: string) => {
    setCollapsedFolders((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  // Group docs by folder when viewing All and not searching
  const docsByFolder = useMemo(() => {
    if (activeFilter !== ALL || searching) return null;
    const map = new Map<string, DocListItem[]>();
    for (const d of docs) {
      const f = d.folder || 'Other';
      const list = map.get(f);
      if (list) {
        list.push(d);
      } else {
        map.set(f, [d]);
      }
    }
    return [...map.entries()];
  }, [docs, activeFilter, searching]);

  /** A same-screen link that changes one thing and drops the page, so every move lands on page 1. */
  const href = (over: { folder?: string; page?: number }) => {
    const params = new URLSearchParams();
    if (query !== '') params.set('q', query);
    const nextFolder = over.folder ?? folder;
    if (nextFolder !== '' && nextFolder !== ALL) params.set('folder', nextFolder);
    // Changing folders must reset paging: page 4 of "Architecture" is usually page 4 of nothing, and
    // landing on an empty grid reads as "this folder is empty".
    const nextPage = over.page ?? 1;
    if (nextPage > 1) params.set('page', String(nextPage));
    const qs = params.toString();
    return qs === '' ? '/' : `/?${qs}`;
  };

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
        </p>
      </div>

      {docs.length > 0 && (
        <div className={styles.toolbar}>
          <div className={styles.filterRow}>
            {folders.map((name) => (
              <Link
                key={name}
                href={href({ folder: name === ALL ? '' : name, page: 1 })}
                className={`${styles.pill} ${activeFilter === name ? styles.pillActive : ''}`}
                // Announces which pill is the current one to a screen reader, which colour alone does
                // not. `page` because these navigate rather than toggle a control.
                aria-current={activeFilter === name ? 'page' : undefined}
              >
                {name}
              </Link>
            ))}
          </div>

          <div className={styles.viewModeToggle} role="group" aria-label="View mode">
            <button
              type="button"
              className={`${styles.viewModeBtn} ${viewMode === 'grid' ? styles.viewModeBtnActive : ''}`}
              onClick={() => setViewMode('grid')}
              title="Cards view"
            >
              ⊞ Cards
            </button>
            <button
              type="button"
              className={`${styles.viewModeBtn} ${viewMode === 'list' ? styles.viewModeBtnActive : ''}`}
              onClick={() => setViewMode('list')}
              title="List view"
            >
              ☰ List
            </button>
          </div>
        </div>
      )}

      {docsByFolder ? (
        <div className={styles.folderSections}>
          {docsByFolder.map(([folderName, folderDocs]) => {
            const isCollapsed = Boolean(collapsedFolders[folderName]);
            return (
              <div key={folderName} className={styles.folderSection}>
                <div className={styles.folderHeaderRow}>
                  <div className={styles.folderHeaderLeft}>
                    <span className={styles.folderIcon}>📁</span>
                    <h2 className={styles.folderTitle}>{folderName}</h2>
                    <span className={styles.folderCountBadge}>
                      {folderDocs.length} {folderDocs.length === 1 ? 'doc' : 'docs'}
                    </span>
                  </div>
                  <div className={styles.folderHeaderRight}>
                    <Link
                      href={href({ folder: folderName, page: 1 })}
                      className={styles.folderFilterLink}
                    >
                      Focus folder →
                    </Link>
                    <button
                      type="button"
                      onClick={() => toggleFolder(folderName)}
                      className={styles.folderToggleBtn}
                      aria-expanded={!isCollapsed}
                    >
                      {isCollapsed ? 'Expand ▾' : 'Collapse ▴'}
                    </button>
                  </div>
                </div>

                {!isCollapsed && (
                  viewMode === 'grid' ? (
                    <div className={styles.grid}>
                      {folderDocs.map((doc) => (
                        <DocCard key={doc.id} doc={doc} source={sourcesById.get(doc.sourceId)} />
                      ))}
                    </div>
                  ) : (
                    <div className={styles.listContainer}>
                      {folderDocs.map((doc) => (
                        <DocListRow key={doc.id} doc={doc} showFolder={false} />
                      ))}
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>
      ) : (
        viewMode === 'grid' ? (
          <div className={styles.grid}>
            {docs.map((doc) => (
              <DocCard key={doc.id} doc={doc} source={sourcesById.get(doc.sourceId)} />
            ))}
          </div>
        ) : (
          <div className={styles.listContainer}>
            {docs.map((doc) => (
              <DocListRow key={doc.id} doc={doc} showFolder={true} />
            ))}
          </div>
        )
      )}

      {/*
        Paging, which the Library did not have. Before this the newest 50 documents were the only
        ones the screen could reach — everything older was not truncated-and-labelled, it was
        absent. The handoff has no pagination design, so this is the smallest honest thing: where
        you are, and a step either way. Prev/Next rather than numbered pages because a card grid
        with page numbers is a design decision the handoff has not made.
      */}
      {!searching && pageCount > 1 && (
        <div className={styles.pager}>
          {page > 1 ? (
            <Link className={styles.pagerLink} href={href({ page: page - 1 })} rel="prev">
              ← Newer
            </Link>
          ) : (
            <span className={styles.pagerDisabled}>← Newer</span>
          )}

          <span className={styles.pagerPosition}>
            {firstOnPage}–{lastOnPage} of {total}
          </span>

          {page < pageCount ? (
            <Link className={styles.pagerLink} href={href({ page: page + 1 })} rel="next">
              Older →
            </Link>
          ) : (
            <span className={styles.pagerDisabled}>Older →</span>
          )}
        </div>
      )}
    </div>
  );
}
