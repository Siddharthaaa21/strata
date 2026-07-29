import { docs, importEvents, sources, type Doc, type DocId, type ImportEvent } from '@strata/core';
import { ConnectorRow } from './ConnectorRow';
import { relativeTime } from '../lib/relative-time';
import styles from './ImportScreen.module.css';

/**
 * screen-import — design/handoff/README.md:20-25, Vault.dc.html:114-146.
 *
 * Single column, 840px max: header → connector list → "Recent imports". The recent-imports list
 * is deliberately flat (no card, no status pill, no source badge — README:24) and only shows
 * `ImportEvent`s whose `docId` resolves to a fixture `Doc`: `imported`/`updated`/`skipped-duplicate`
 * always have one, `failed` (the GitHub-disconnected fixture) does not. Surfacing a failed row in
 * a list with no status indicator would silently read as a success, so it's excluded — see
 * strata-ui-builder DEVIATIONS.
 */
export function ImportScreen() {
  const docsById = new Map<DocId, Doc>(docs.map((doc) => [doc.id, doc]));

  const recentImports = importEvents
    .map((event) => (event.docId ? { event, doc: docsById.get(event.docId) } : null))
    .filter((row): row is { event: ImportEvent; doc: Doc } => row !== null && row.doc !== undefined)
    .sort((a, b) => new Date(b.event.occurredAt).getTime() - new Date(a.event.occurredAt).getTime());

  return (
    <div className={styles.screen}>
      <div>
        <h1 className={`serif ${styles.title}`}>Import &amp; Sources</h1>
        <p className={styles.subtitle}>
          Connect the tools where your team already generates knowledge — docs get parsed, tagged, and filed
          automatically.
        </p>
      </div>

      <div className={styles.connectorList}>
        {sources.map((source) => (
          <ConnectorRow key={source.id} source={source} />
        ))}
      </div>

      <div>
        <div className={styles.sectionLabel}>Recent imports</div>
        <div className={styles.recentList}>
          {recentImports.map(({ event, doc }) => (
            <div key={event.id} className={styles.recentRow}>
              <div className={styles.recentTitle}>{doc.title}</div>
              <span className={styles.recentTime}>{relativeTime(event.occurredAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
