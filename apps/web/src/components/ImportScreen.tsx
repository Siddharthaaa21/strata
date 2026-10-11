import { ConnectorRow } from './ConnectorRow';
import { RecentFolderRow } from './RecentFolderRow';
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
  const { sources, recentGroups, failures } = await loadImport();
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

  // Sources that occupy no slot — every indexed GitHub repository is one, because each gets its own
  // id (`src-github-<owner>-<repo>`) so two repos cannot overwrite each other's `README.md`. The
  // screen-import node flagged "a real Source whose id is not one of the four is invisible here" as a
  // genuine gap waiting for its first real cause. This is it, so the gap closes with it.
  const slotIds = new Set(PLACEHOLDER_CONNECTORS.map((c) => c.id));
  const extra = sources.filter((s) => !slotIds.has(s.id as (typeof PLACEHOLDER_CONNECTORS)[number]['id']));

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
        {extra.map((s) => (
          // interactive={false}: these are RECORDS of sources that exist, not slots that start an
          // import. See ConnectorRow for the control that was doing the wrong thing.
          <ConnectorRow key={s.id} source={s} interactive={false} />
        ))}
      </div>

      {/*
        FAILURES, which this screen has never shown.
        
        Carried out of M3: failed events were kept out of Recent Imports because that list has no
        status indicator by design (README:24), so a failed row would read as a success. Correct
        reason to keep them out of THAT list; mistaken for a reason to show them nowhere. ADR 0003
        records failures so a user can learn why a document did not appear — and until now, nothing
        served that purpose. It matters more since the upload buttons shipped (D24): a person can
        cause a failure from the browser, and the browser was the one place that could not say so.
        
        Its own section, above Recent imports, because a failure is the thing you came to find out
        about. Absent entirely when there is nothing to report — an empty "Failures" heading on a
        healthy vault is noise that trains people to ignore the heading.
      */}
      {failures.length > 0 && (
        <div>
          <h2 className={styles.sectionLabel}>
            Failed to import ({failures.length})
          </h2>
          <div className={styles.recentList}>
            {failures.map((f) => (
              <div key={f.id} className={styles.failureRow}>
                <span className={styles.failurePath}>{f.externalId}</span>
                {/* The sanitized per-code message by contract (ADR 0003) — never a caught
                    exception's text, never document content. */}
                <span className={styles.failureReason}>{f.message || f.code}</span>
                <span className={styles.recentTime}>{relativeTime(f.occurredAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className={styles.sectionLabel}>Recent imports</h2>
        <div className={styles.recentList}>
          {recentGroups.length === 0 ? (
            <div className={styles.recentRow}>
              <div className={styles.recentTitle}>Nothing imported yet.</div>
            </div>
          ) : (
            recentGroups.map((group) => (
              <RecentFolderRow key={group.folder} group={group} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
