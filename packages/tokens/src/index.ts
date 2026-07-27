/**
 * Design tokens transcribed from the Strata handoff.
 *
 * Every value cites the handoff line it came from. Nothing here is invented — if you need a value
 * that is not present, read `design/handoff/Vault.dc.html` and add it WITH a citation. Raw
 * `oklch()` anywhere outside this package is blocked by `.claude/hooks/post-edit.sh`.
 *
 * Where README.md and Vault.dc.html disagree, the HTML wins (see docs/plan/04-risk-register.md R10).
 */

/** Page and surface backgrounds. README:49-51 */
export const surface = {
  page: 'oklch(96.5% 0.014 95)',
  sunken: 'oklch(94.5% 0.016 95)', // sidebar, mobile top bar
  raised: 'oklch(100% 0 0)', // cards, search field, active nav pill
  chip: 'oklch(95% 0.015 95)', // reader tag pills — Vault.dc.html:171
  code: 'oklch(95.5% 0.015 95)', // reader code block — Vault.dc.html:160
} as const;

/**
 * Four distinct border values doing four different jobs. They are NOT interchangeable —
 * substituting one for another is the most common and least visible fidelity bug (R9).
 */
export const border = {
  structural: 'oklch(88% 0.015 95)', // sidebar edge, reader rail, top bar — Vault.dc.html:40
  card: 'oklch(89% 0.015 95)', // doc cards, connector rows — Vault.dc.html:101,123
  hairline: 'oklch(91% 0.015 95)', // recent-imports dividers — Vault.dc.html:138
  control: 'oklch(87% 0.015 95)', // search field, hamburger, close — Vault.dc.html:33,51
} as const;

/** Text colors. README:53-54 */
export const ink = {
  base: 'oklch(20% 0.02 75)',
  title: 'oklch(22% 0.02 75)', // card titles — Vault.dc.html:104
  body: 'oklch(24% 0.02 75)', // reader body, active nav — Vault.dc.html:155
  strong: 'oklch(28% 0.02 75)', // related-doc links — Vault.dc.html:179
  muted: 'oklch(48% 0.02 75)',
  subtle: 'oklch(52% 0.02 75)',
  faint: 'oklch(55% 0.02 75)',
  /** Text on accent/ink fills. Deliberately warm off-white, NOT pure white. Vault.dc.html:30 */
  inverse: 'oklch(99% 0.005 90)',
  /** Inactive sidebar nav item label. Vault.dc.html:214 */
  navInactive: 'oklch(40% 0.02 75)',
  /** Inactive sidebar nav item leading dot. Vault.dc.html:216 */
  navIconInactive: 'oklch(70% 0.02 75)',
  /** Inactive filter pill label. Vault.dc.html:249-252 */
  controlText: 'oklch(35% 0.02 75)',
} as const;

/**
 * Accent is a PROP with a default, not a constant (README:55). Thread it through; do not inline
 * the violet. `alternates` are the curated options the handoff sanctions.
 */
export const accent = {
  default: 'oklch(55% 0.23 300)',
  alternates: [
    'oklch(55% 0.23 300)', // electric violet
    'oklch(58% 0.22 15)', // warm red
    'oklch(55% 0.2 165)', // green
    'oklch(50% 0.02 70)', // neutral ink
  ],
} as const;

/** Per-connector tints, keyed by Source kind. Vault.dc.html:255-273 */
export const sourceTint = {
  claude: { fg: 'oklch(48% 0.14 40)', iconFg: 'oklch(45% 0.12 40)', iconBg: 'oklch(93% 0.05 40)' },
  cursor: { fg: 'oklch(45% 0.12 260)', iconFg: 'oklch(42% 0.1 260)', iconBg: 'oklch(90% 0.04 260)' },
  markdown: { fg: 'oklch(45% 0.1 145)', iconFg: 'oklch(38% 0.1 145)', iconBg: 'oklch(92% 0.05 145)' },
  github: { fg: 'oklch(30% 0.01 70)', iconFg: 'oklch(30% 0.01 70)', iconBg: 'oklch(90% 0.008 90)' },
} as const;

/** Connector "Connected" state text. Vault.dc.html:270 */
export const statusColor = { connected: 'oklch(45% 0.1 145)' } as const;

/** README:59-62. Sizes are deliberately non-round — never round them. */
export const font = {
  ui: "'Space Grotesk', system-ui, sans-serif",
  reading: "'Source Serif 4', serif",
  mono: 'ui-monospace, monospace',
} as const;

export const fontSize = {
  micro: '11px', // uppercase section labels
  label: '11.5px', // card source label, card meta
  small: '12px',
  meta: '12.5px', // card excerpt, reader metadata
  nav: '13px',
  navItem: '13.5px',
  body: '14px',
  cardTitle: '17px',
  readerHeading: '20px', // in-body section headings
  screenTitle: '28px',
  readerTitleMobile: '26px',
  readerTitle: '34px',
  readerBody: '17.5px',
  readerBodyMobile: '18.5px', // GROWS on mobile — deliberate, README:37
  /** Sidebar/top-bar product-name wordmark. Vault.dc.html:31,44 */
  brand: '15px',
} as const;

/** Unitless line-heights that are pinned exact values, not eyeballed. */
export const lineHeight = {
  cardTitle: '1.35', // Vault.dc.html:104
  cardExcerpt: '1.5', // Vault.dc.html:105
} as const;

export const radius = {
  sm: '6px',
  control: '7px',
  md: '8px',
  tile: '9px',
  cta: '10px',
  row: '12px',
  card: '14px',
  pill: '99px',
} as const;

/** Fixed layout dimensions. README:16,29 */
export const layout = {
  breakpoint: 860, // the ONLY breakpoint
  sidebarWidth: '248px',
  readerRailWidth: '280px',
  readerContentMax: '660px',
  importColumnMax: '840px',
  libraryColumnMax: '1180px',
  mainPadding: '40px 48px',
  mainPaddingMobile: '20px 18px',
  libraryGrid: 'repeat(3, minmax(0, 1fr))',
  libraryGridMobile: '1fr',
  libraryGap: '20px',
  /** Sidebar brand-mark tile. Vault.dc.html:43 (desktop), :30 (mobile top bar) */
  logoTileDesktop: '26px',
  logoTileMobile: '24px',
  /** Mobile top-bar hamburger tile. Vault.dc.html:33 */
  hamburgerTile: '34px',
  /** Mobile sidebar-overlay close tile. Vault.dc.html:47 */
  closeTile: '30px',
  /** Sidebar nav item leading dot. Vault.dc.html:58 */
  navDotSize: '7px',
} as const;

export const motion = {
  cardHover: 'translateY(-2px)', // no shadow change — Vault.dc.html:101
  cardTransition: 'transform .15s',
} as const;

/**
 * Padding/gap values that recur across the sidebar, top bar, doc card, and library screen.
 * Each cites the handoff line it came from — see packages/tokens/src/index.ts header comment.
 */
export const spacing = {
  cardPadding: '20px', // Vault.dc.html:102
  cardGap: '12px', // Vault.dc.html:102 (internal doc-card flex gap)
  sidebarPadding: '22px 16px', // Vault.dc.html:40
  sidebarSectionGap: '26px', // Vault.dc.html:40
  brandGap: '9px', // Vault.dc.html:29,42
  navListGap: '2px', // Vault.dc.html:55
  navItemGap: '11px', // Vault.dc.html:57
  navItemPadding: '9px 10px', // Vault.dc.html:57
  topBarPadding: '14px 18px', // Vault.dc.html:28
  filterRowGap: '8px', // Vault.dc.html:93
  filterPillPadding: '7px 15px', // Vault.dc.html:95
  headerGap: '26px', // Vault.dc.html:87 (header/filters/grid column gap)
} as const;

export type SourceKind = keyof typeof sourceTint;
