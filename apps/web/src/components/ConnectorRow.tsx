import { sourceTint, statusColor, accent, type SourceKind } from '@strata/tokens';
import styles from './ConnectorRow.module.css';

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
 * Connect/Upload into one label. `Connect`/`Upload`/`Connected` are visual endpoints only
 * (README:75-76) — no `onClick`.
 */
/** The flat projection, not a domain `Source` — no `workspaceId` or `credentialRef` reaches a component. */
export interface ConnectorInfo {
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
}

export function ConnectorRow({ source }: { source: ConnectorInfo }) {
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
  const label = connected && kind !== 'markdown' && kind !== 'claude'
    ? 'Connected'
    : kind === 'markdown'
      ? 'Upload'
      : kind === 'claude'
        ? 'Import'
        : 'Connect';
  const color = connected && kind !== 'markdown' ? statusColor.connected : accent.default;

  return (
    <div className={styles.row}>
      <div className={styles.icon} style={{ background: tint.iconBg, color: tint.iconFg }}>
        {INITIALS[kind]}
      </div>
      <div className={styles.text}>
        <div className={styles.name}>{source.name}</div>
        <div className={styles.desc}>{source.description}</div>
      </div>
      <span className={styles.action} style={{ color }} role="button" aria-disabled="true">
        {label}
      </span>
    </div>
  );
}
