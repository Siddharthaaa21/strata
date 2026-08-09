import { ConnectorRow } from './ConnectorRow';
import { relativeTime } from '../lib/relative-time';
import { loadImport } from '../lib/vault';
import styles from './ImportScreen.module.css';

/**
 * screen-import — design/handoff/README.md:20-25, Vault.dc.html:114-146.
 *
 * A Server Component reading real sources and real ImportEvents. Single column, 840px max:
 * header → connector list → "Recent imports", the last deliberately flat (no card, no status pill,
 * no source badge — README:24).
 *
 * Connectors that have never been connected are not in the database, so the rows the handoff shows
 * are merged in as not-connected placeholders. That keeps the screen honest: it advertises what
 * Strata could connect to, while only reporting real status for what actually exists.
 *
 * **The handoff draws four identical rows. They are three different mechanisms, and one of them
 * cannot exist (D22).** Verified rather than assumed:
 *
 *   - GitHub has a documented, authenticated API. A real connector.
 *   - Claude has NO API. Export is a manual act producing an emailed link that expires in 24 hours.
 *     It is an import — the user drops a file — so the row must not say "Connect".
 *   - Cursor has no official export at all. Its chats live in undocumented SQLite blobs that
 *     already broke once (Cursor 3.0, April 2026). Not being built; the row is gone rather than
 *     greyed, because a disabled row still advertises an intention.
 *
 * Four `Connect` links promising one mechanism for three is the same defect as the Agent Access nav
 * item that returned a 404: a control describing a capability the system does not have.
 */
const PLACEHOLDER_CONNECTORS = [
  {
    id: 'src-claude',
    kind: 'claude',
    name: 'Claude',
    description: 'Import a Claude data export — Settings → Privacy → Export data.',
  },
  { id: 'src-github', kind: 'github', name: 'GitHub', description: 'Indexes READMEs, ADRs, and PR descriptions.' },
  { id: 'src-markdown', kind: 'markdown', name: 'Local Markdown', description: 'Drag in .md files or folders from anywhere.' },
] as const;

export async function ImportScreen() {
  const { sources, recent } = await loadImport();
  const bySourceId = new Map(sources.map((s) => [s.id, s]));

  const connectors = PLACEHOLDER_CONNECTORS.map((c) => {
    const live = bySourceId.get(c.id);
    return {
      id: c.id,
      // The LIVE kind when a real source occupies this slot, falling back to the placeholder's only
      // when nothing is connected. Taking `name` and `status` from the live row while keeping the
      // slot's kind meant the icon and tint described the slot rather than the source — so a
      // markdown source occupying the `src-claude` id rendered with Claude's badge and colours and
      // read, to anyone glancing at the screen, as a connected Claude account. The icon is the
      // fastest thing on the row to read, which makes it the worst thing to have lying.
      kind: live?.kind ?? c.kind,
      name: live?.name ?? c.name,
      description: live?.description ?? c.description,
      status: live?.status ?? 'disconnected',
    };
  });

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
        {connectors.map((c) => (
          <ConnectorRow key={c.id} source={c} />
        ))}
      </div>

      <div>
        <h2 className={styles.sectionLabel}>Recent imports</h2>
        <div className={styles.recentList}>
          {recent.length === 0 ? (
            <div className={styles.recentRow}>
              <div className={styles.recentTitle}>Nothing imported yet.</div>
            </div>
          ) : (
            recent.map((r) => (
              <div key={r.id} className={styles.recentRow}>
                <div className={styles.recentTitle}>{r.title}</div>
                <span className={styles.recentTime}>{relativeTime(r.occurredAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
