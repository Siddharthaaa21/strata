import { border, surface } from '@strata/tokens';

/**
 * M0 scaffold page. Deliberately not a handoff screen — screens are M2/M3, and building them
 * before packages/core settles means building them twice (docs/plan/05-decision-log.md D4).
 *
 * What this page is for: proving the token pipeline works end to end. If the swatches below
 * render as four visibly distinct hairlines, tokens are loading and the four border values are
 * intact. Delete this page when screen-library lands.
 */
export default function Page() {
  const borders = Object.entries(border);

  return (
    <main style={{ padding: 'var(--main-padding)', maxWidth: 'var(--import-column-max)' }}>
      <h1 style={{ fontSize: 'var(--text-screen-title)', fontWeight: 600, letterSpacing: '-0.01em', margin: 0 }}>
        Strata
      </h1>
      <p style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-body)', marginTop: 4 }}>
        M0 scaffold. Token pipeline check — see <code>docs/plan/02-milestones.md</code>.
      </p>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 'var(--text-nav-item)', fontWeight: 600, color: 'var(--ink-strong)' }}>
          Border tokens
        </h2>
        <p style={{ fontSize: 'var(--text-meta)', color: 'var(--ink-muted)', maxWidth: 520 }}>
          Four near-identical values doing four different jobs. Substituting one for another is the
          least visible fidelity bug in the project (risk register R9).
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {borders.map(([name, value]) => (
            <div
              key={name}
              style={{
                background: surface.raised,
                border: `1px solid ${value}`,
                borderRadius: 'var(--radius-row)',
                padding: '14px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                gap: 14,
                fontSize: 'var(--text-meta)',
              }}
            >
              <span style={{ fontWeight: 600 }}>{name}</span>
              <span style={{ color: 'var(--ink-subtle)', fontFamily: 'var(--font-mono)' }}>{value}</span>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 'var(--text-nav-item)', fontWeight: 600, color: 'var(--ink-strong)' }}>
          Reading type
        </h2>
        <p
          className="serif"
          style={{
            fontSize: 'var(--text-reader-body)',
            lineHeight: 'var(--leading-reader-body)',
            color: 'var(--ink-body)',
            maxWidth: 'var(--reader-content-max)',
          }}
        >
          Source Serif 4 at the reader body size. Below 860px this grows to 18.5px with looser
          leading — deliberate, for reading on a phone. Resize the window past the breakpoint to
          confirm the media query is live.
        </p>
      </section>
    </main>
  );
}
