import type { Source } from '@strata/core';
import { sourceTint, statusColor, accent } from '@strata/tokens';
import styles from './ConnectorRow.module.css';

/**
 * Per-`SourceKind` initials for the icon tile. Vault.dc.html:270-273 hardcodes these as authored
 * data (`initials: 'CL'/'CU'/'GH'/'MD'`) — they are not derived from `name`. A first-letters
 * derivation looks plausible but is wrong for every single-word name here: "Claude"/"Cursor"/
 * "GitHub" each collapse to one letter (`split(' ')` finds no space), and "Local Markdown" would
 * produce "LM", not "MD". Presentational only, so it lives here rather than on `Source`.
 */
const INITIALS: Record<Source['kind'], string> = {
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
export function ConnectorRow({ source }: { source: Source }) {
  const tint = sourceTint[source.kind];
  const connected = source.status === 'connected';
  const label = source.kind === 'markdown' ? 'Upload' : connected ? 'Connected' : 'Connect';
  const color = connected && source.kind !== 'markdown' ? statusColor.connected : accent.default;

  return (
    <div className={styles.row}>
      <div className={styles.icon} style={{ background: tint.iconBg, color: tint.iconFg }}>
        {INITIALS[source.kind]}
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
