'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RecentImportFolderGroup } from '../lib/vault';
import { relativeTime } from '../lib/relative-time';
import styles from './RecentFolderRow.module.css';

export function RecentFolderRow({ group }: { group: RecentImportFolderGroup }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.folderCard}>
      <button
        type="button"
        className={styles.folderHeader}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <div className={styles.folderLeft}>
          <span className={styles.folderIcon}>📁</span>
          <span className={styles.folderTitle}>{group.folder}</span>
          <span className={styles.countBadge}>
            {group.items.length} {group.items.length === 1 ? 'file' : 'files'}
          </span>
        </div>
        <div className={styles.folderRight}>
          <span className={styles.recentTime}>{relativeTime(group.lastOccurredAt)}</span>
          <span className={styles.expandLabel}>
            {open ? 'Hide files ▴' : 'Show files ▾'}
          </span>
        </div>
      </button>

      {open && (
        <div className={styles.fileList}>
          {group.items.map((item) => {
            const rowContent = (
              <>
                <div className={styles.fileInfo}>
                  <span className={styles.fileDocIcon}>📄</span>
                  <span className={styles.fileTitle}>{item.title}</span>
                  {item.externalId && item.externalId !== item.title && (
                    <span className={styles.filePath}>{item.externalId}</span>
                  )}
                </div>
                <div className={styles.fileRight}>
                  <span className={styles.recentTime}>{relativeTime(item.occurredAt)}</span>
                  {item.docId && <span className={styles.openHint}>Open ↗</span>}
                </div>
              </>
            );

            return item.docId ? (
              <Link
                key={item.id}
                href={`/reader/${item.docId}`}
                className={`${styles.fileRow} ${styles.fileRowLink}`}
                title={`Open ${item.title} in Reader`}
              >
                {rowContent}
              </Link>
            ) : (
              <div key={item.id} className={styles.fileRow}>
                {rowContent}
              </div>
            );
          })}
          <div className={styles.fileListFooter}>
            <Link
              href={`/?folder=${encodeURIComponent(group.folder)}`}
              className={styles.viewFolderLink}
            >
              View in Library →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
