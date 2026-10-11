import { sourceTint, statusColor, accent, type SourceKind } from '@strata/tokens';
import { ConnectorAction, type ConnectorActionKind } from './ConnectorAction.tsx';
import { GitHubConnect } from './GitHubConnect.tsx';
import { DisconnectButton } from './DisconnectButton.tsx';
import styles from './ConnectorRow.module.css';

/**
 * The kinds that have a working importer behind them, and therefore a real control.
 *
 * A row is live when there is something to run and visibly inert when there is not. Cursor is not
 * offered at all (D22). GitHub is live as of D29 — it takes an address rather than a file, so it has
 * its own control rather than sharing the file-picker one.
 */
const LIVE: readonly string[] = ['markdown', 'claude'] satisfies ConnectorActionKind[];

/**
 * Per-`SourceKind` initials for the icon tile. Vault.dc.html:270-273 hardcodes these as authored
 * data (`initials: 'CL'/'CU'/'GH'/'MD'`) — they are not derived from `name`. A first-letters
 * derivation looks plausible but is wrong for every single-word name here: "Claude"/"Cursor"/
 * "GitHub" each collapse to one letter (`split(' ')` finds no space), and "Local Markdown" would
 * produce "LM", not "MD". Presentational only, so it lives here rather than on `Source`.
 */
const INITIALS: Record<SourceKind, string> = {
  claude: 'CL',
  cursor: 'CU',
  github: 'GH',
  markdown: 'MD',
};

/**
 * comp-connector-row — design/handoff/README.md:23, Vault.dc.html:122-131.
 *
 * Flat row, no button chrome: 36px tinted-initials tile → name + one-line description (flex:1) →
 * bare colored-text action. Action label/color derived from `Source.kind`/`status`, not just
 * `status`: `kind === 'markdown'` always shows `Upload` regardless of connection state
 * (Vault.dc.html:273 — `actionLabel: 'Upload'` on the markdown mock entry, independent of any
 * status field), matching the handoff's per-connector authored data rather than collapsing
 * Connect/Upload into one label.
 *
 * The handoff marks these as visual endpoints (README:75-76) and they stayed inert through M3-M7,
 * long after both importers worked from a terminal. That is placeholder status being mistaken for a
 * requirement (CLAUDE.md non-negotiable 5): a control naming a capability the system genuinely has,
 * and refusing to provide it, is the same defect as the Agent Access nav item that 404'd. All three
 * are now live — Markdown and Claude take a file (D24), GitHub takes an address (D29). Cursor is not
 * offered at all, because no export exists to offer (D22).
 */
/** The flat projection, not a domain `Source` — no `workspaceId` or `credentialRef` reaches a component. */
export interface ConnectorInfo {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
}

export function ConnectorRow({
  source,
  interactive = true,
}: {
  source: ConnectorInfo;
  /**
   * Whether this row is a SLOT that can start an import, or a RECORD of a source that already
   * exists.
   *
   * The distinction is not cosmetic. A row's control was chosen from `kind` alone, so the
   * `src-claude-code` source — recovered transcripts, `kind: 'claude'` — rendered Claude's `Import`
   * button, which opens a Claude-EXPORT file picker and writes to `src-claude`. Clicking it would
   * have imported a conversations.json into a different source than the row you clicked. An indexed
   * GitHub repository had the same defect in a milder form: its `Connect` starts a NEW repo rather
   * than re-syncing that one.
   *
   * Records show what they are and offer nothing. Re-syncing an existing source is a CLI operation
   * (`npm run ingest:github`, `npm run ingest:claude-code`) and pretending otherwise on this screen
   * is how a control ends up doing something other than what its row says.
   */
  interactive?: boolean;
}) {
  const kind = source.kind as SourceKind;
  const tint = sourceTint[kind];
  const connected = source.status === 'connected';
  // The label states the MECHANISM, not one word for all of them (D22).
  //
  // `Connect` implies an authenticated, ongoing sync. That is true of GitHub and false of the other
  // two: Markdown is a folder you point at, and Claude has no API at all — its export is a manual
  // act producing a link that expires in 24 hours. Labelling all three `Connect` promises a
  // capability for two sources that will never have it, and the person who clicks expecting an
  // OAuth screen is owed better than a control that does nothing.
  const live = LIVE.includes(kind);
  const label = !interactive ? (connected ? 'Connected' : 'Idle') : connected && !live ? 'Connected' : 'Connect';
  // A live control is always the accent colour, never `statusColor.connected`. Green is this
  // screen's vocabulary for STATE; these read `Import` and `Upload`, which are things you do. A
  // green verb tells an operator the action already happened.
  const color = !interactive
    ? connected
      ? statusColor.connected
      : accent.default
    : live
      ? accent.default
      : connected
        ? statusColor.connected
        : accent.default;

  return (
    <div className={styles.row}>
      <div className={styles.icon} style={{ background: tint.iconBg, color: tint.iconFg }}>
        {INITIALS[kind]}
      </div>
      <div className={styles.text}>
        <div className={styles.name}>{source.name}</div>
        <div className={styles.desc}>{source.description}</div>
      </div>
      {interactive && kind === 'github' ? (
        <GitHubConnect color={accent.default} />
      ) : interactive && live ? (
        <div className={styles.statusAndAction}>
          <ConnectorAction kind={kind as ConnectorActionKind} color={color} />
          {connected && <DisconnectButton sourceId={source.id} sourceName={source.name} />}
        </div>
      ) : (
        <div className={styles.statusAndAction}>
          <span className={styles.action} style={{ color }} aria-disabled="true">
            {label}
          </span>
          {connected && <DisconnectButton sourceId={source.id} sourceName={source.name} />}
        </div>
      )}
    </div>
  );
}
