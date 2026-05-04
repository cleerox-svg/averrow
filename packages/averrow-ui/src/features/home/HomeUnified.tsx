// Phase 1 of the unified Home rebuild — responsive shell.
//
// This is the foundation file that subsequent phases (2, 2.5, 3, …)
// will plug content into. It establishes the container-query layout
// pattern, the entrance-animation gating on prefers-reduced-motion,
// and the visible "you're on the new Home" affordance so anyone with
// the feature flag enabled can verify they landed on this code path.
//
// Why container queries (not viewport media queries):
//   Each section sizes itself to the parent shell's width, not the
//   browser viewport. This means the same section component renders
//   correctly whether it's on Home (full width) or in a sidebar of
//   another page in the future. Subsequent phases will compose
//   responsive sections (StatGrid, MoversSection, ModuleHub, etc.)
//   on top of this primitive without revisiting breakpoints.

const SHELL_STYLE: React.CSSProperties = {
  containerType: 'inline-size' as React.CSSProperties['containerType'],
  containerName: 'home',
  // Page background is set globally; we just lay out within it.
  width: '100%',
  minHeight: '100vh',
};

const HEADER_BAND_STYLE: React.CSSProperties = {
  padding: '24px 32px 20px',
  borderBottom: '1px solid var(--border-base)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
};

const PHASE_PILL_STYLE: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.20em',
  textTransform: 'uppercase',
  padding: '4px 10px',
  borderRadius: 999,
  background: 'rgba(229,168,50,0.10)',
  border: '1px solid rgba(229,168,50,0.30)',
  color: 'var(--amber)',
};

export function HomeUnified() {
  return (
    <div style={SHELL_STYLE}>
      {/* Phase-flag affordance — visible proof the new shell rendered.
          Removed in Phase 7 (cutover) when this becomes the default. */}
      <div style={HEADER_BAND_STYLE}>
        <div>
          <h1 style={{
            fontSize: 26, fontWeight: 900,
            color: 'var(--text-primary)',
            letterSpacing: -0.5, margin: 0,
          }}>
            Command Center
          </h1>
          <div style={{
            fontSize: 11, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', marginTop: 4,
            letterSpacing: '0.08em',
          }}>
            Unified Home · Phase 1 shell · responsive container-query layout
          </div>
        </div>
        <span style={PHASE_PILL_STYLE}>v2 preview</span>
      </div>

      {/* Demo grid — proves the container query is wired. Future phases
          replace this with the real Stat grid + Threat Pulse + Movers
          + Module Hub + Live Activity. The breakpoints below are the
          canonical ones the rest of the rebuild will use. */}
      <section style={{ padding: '20px 32px' }}>
        <div className="home-section-label" style={{
          fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
          letterSpacing: '0.20em', textTransform: 'uppercase',
          color: 'var(--text-tertiary)', marginBottom: 12,
        }}>
          Container query demo · resize to see layout change
        </div>
        <div className="home-demo-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="home-demo-cell">
              <div className="home-demo-cell-num">{String(i + 1).padStart(2, '0')}</div>
              <div className="home-demo-cell-label">slot</div>
            </div>
          ))}
        </div>
      </section>

      {/* All Phase 1 styles live here so the file is self-contained
          and easy to delete at cutover. Subsequent phases will lift
          the @container query patterns into proper component scopes. */}
      <style>{`
        .home-demo-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: 1fr;
        }
        .home-demo-cell {
          padding: 24px 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
          display: flex;
          align-items: baseline;
          gap: 10px;
          opacity: 0;
          animation: home-cell-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .home-demo-cell:nth-child(1) { animation-delay: 0.00s; }
        .home-demo-cell:nth-child(2) { animation-delay: 0.04s; }
        .home-demo-cell:nth-child(3) { animation-delay: 0.08s; }
        .home-demo-cell:nth-child(4) { animation-delay: 0.12s; }
        .home-demo-cell:nth-child(5) { animation-delay: 0.16s; }
        .home-demo-cell:nth-child(6) { animation-delay: 0.20s; }
        .home-demo-cell:nth-child(7) { animation-delay: 0.24s; }
        .home-demo-cell:nth-child(8) { animation-delay: 0.28s; }
        .home-demo-cell-num {
          font-family: var(--font-mono);
          font-size: 24px;
          font-weight: 900;
          color: var(--amber);
          letter-spacing: -0.5px;
        }
        .home-demo-cell-label {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }
        @keyframes home-cell-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        /* Disable entrance animations when the user prefers reduced motion. */
        @media (prefers-reduced-motion: reduce) {
          .home-demo-cell {
            opacity: 1;
            animation: none;
          }
        }

        /* Container query breakpoints — the canonical thresholds the
           rest of the unified Home will use. */
        @container home (min-width: 480px) {
          .home-demo-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @container home (min-width: 800px) {
          .home-demo-grid { grid-template-columns: repeat(4, 1fr); }
        }
        @container home (min-width: 1100px) {
          .home-demo-grid { grid-template-columns: repeat(8, 1fr); }
        }
      `}</style>
    </div>
  );
}
