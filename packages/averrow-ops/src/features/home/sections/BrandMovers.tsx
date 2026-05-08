// Phase 3 of the unified Home rebuild — Brand Movers section.
//
// Two stacked lists (or side-by-side on wider containers):
//   - "Heating Up"   → top brands with the largest 7-day positive
//                       delta in active threat count (red accent)
//   - "Cooling Down" → top brands with the largest 7-day negative
//                       delta (green accent)
//
// Each row drills into /brands/:id. Avatar tints by accent so the
// list reads at a glance. Empty-state copy when the snapshot job
// hasn't produced enough history yet.
//
// Container query: stacks under 700px (rising on top, falling below),
// 2-column above. Backend computes deltas from daily_snapshots and
// caches in KV for 5 min — see handlers/brands.ts handleBrandMovers.

import { useNavigate } from 'react-router-dom';
import { useBrandMovers, type BrandMover } from '@/hooks/useBrandMovers';
import { BrandAvatar } from '@/components/ui/BrandAvatar';
import { GradeBadge } from '@/components/ui/GradeBadge';
import { M } from '@/design-system/tokens';

interface MoverListProps {
  title: string;
  rows: BrandMover[];
  /** Hex color for the avatar gradient + delta-badge tint. */
  accent: string;
  accentDim: string;
  /** "+12" for rising, "-8" for cooling — controls leading sign. */
  formatDelta: (n: number) => string;
  emptyLabel: string;
}

function MoverList({ title, rows, accent, accentDim, formatDelta, emptyLabel }: MoverListProps) {
  const navigate = useNavigate();
  return (
    <div className="home-mover-list">
      <div className="home-mover-list-title">{title}</div>
      {rows.length === 0 ? (
        <div className="home-mover-empty">{emptyLabel}</div>
      ) : (
        <ul className="home-mover-rows">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="home-mover-row"
                onClick={() => navigate(`/brands/${row.id}`)}
                aria-label={`${row.name} — ${formatDelta(row.delta_7d)} threats over 7 days`}
              >
                <BrandAvatar
                  name={row.name}
                  color={accent}
                  dimColor={accentDim}
                  faviconUrl={
                    row.logo_url ??
                    (row.canonical_domain
                      ? `https://www.google.com/s2/favicons?domain=${row.canonical_domain}&sz=64`
                      : null)
                  }
                />
                <div className="home-mover-row-text">
                  <div className="home-mover-row-name">{row.name}</div>
                  <div className="home-mover-row-domain">{row.canonical_domain}</div>
                </div>
                <div className="home-mover-row-meta">
                  <GradeBadge grade={row.email_security_grade} />
                  <span
                    className="home-mover-delta"
                    style={{
                      color: accent,
                      background: `${accent}18`,
                      borderColor: `${accent}40`,
                    }}
                  >
                    {formatDelta(row.delta_7d)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BrandMovers() {
  const { data, isLoading } = useBrandMovers();
  const rising  = data?.rising  ?? [];
  const falling = data?.falling ?? [];

  // Skip the section entirely on the very first paint to avoid layout
  // shift; show empty-state inside each list only when the request has
  // settled with no data.
  if (isLoading) return null;

  return (
    <section className="home-brand-movers">
      <div className="home-mover-grid">
        <MoverList
          title="Heating Up"
          rows={rising}
          accent={M.RED}
          accentDim={M.RED_DIM}
          formatDelta={(n) => `+${n.toLocaleString()}`}
          emptyLabel="No brands trending up over the last 7 days"
        />
        <MoverList
          title="Cooling Down"
          rows={falling}
          accent={M.GREEN}
          accentDim={M.GREEN_DIM}
          formatDelta={(n) => `${n.toLocaleString()}`}
          emptyLabel="No brands trending down over the last 7 days"
        />
      </div>

      <style>{`
        .home-brand-movers {
          padding: 22px 24px 0;
        }
        .home-mover-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: 1fr;
        }
        .home-mover-list {
          padding: 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .home-mover-list-title {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }
        .home-mover-empty {
          padding: 16px 4px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
        }
        .home-mover-rows {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .home-mover-row {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px;
          border-radius: 10px;
          background: transparent;
          border: 1px solid transparent;
          cursor: pointer;
          text-align: left;
          color: inherit;
          font: inherit;
          transition: background-color 0.12s ease, border-color 0.12s ease;
        }
        .home-mover-row:hover {
          background: rgba(255,255,255,0.03);
          border-color: rgba(255,255,255,0.08);
        }
        .home-mover-row-text {
          flex: 1;
          min-width: 0;
        }
        .home-mover-row-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-mover-row-domain {
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          margin-top: 1px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-mover-row-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .home-mover-delta {
          font-family: var(--font-mono);
          font-size: 11px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 8px;
          border: 1px solid;
        }

        @container home (min-width: 480px) {
          .home-brand-movers { padding: 22px 32px 0; }
        }
        @container home (min-width: 700px) {
          .home-mover-grid { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>
    </section>
  );
}
