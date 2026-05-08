// Phase 6 of the unified Home rebuild — Provider Movers section.
//
// Hosting-provider counterpart to BrandMovers. Same data path
// (daily_snapshots active-threats 7d delta), same UI shape, same
// container-query layout — reads the apples-to-apples /api/providers/movers
// endpoint added in this phase.
//
// Distinct from /api/providers/worst (sorts by absolute current count)
// and /api/providers/improving (raw 7d-vs-14d threat creation ratio) —
// those endpoints stay live for the providers page; the Home uses this
// movers endpoint so brands and providers behave identically.

import { useNavigate } from 'react-router-dom';
import { useProviderMovers, type ProviderMover } from '@/hooks/useProviderMovers';
import { BrandAvatar } from '@/components/ui/BrandAvatar';
import { providerFaviconUrl } from '@/lib/providerFavicon';
import { M } from '@/design-system/tokens';

interface MoverListProps {
  title: string;
  rows: ProviderMover[];
  accent: string;
  accentDim: string;
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
                onClick={() => navigate(`/providers/${encodeURIComponent(row.id)}`)}
                aria-label={`${row.name} — ${formatDelta(row.delta_7d)} threats over 7 days`}
              >
                <BrandAvatar
                  name={row.name}
                  color={accent}
                  dimColor={accentDim}
                  faviconUrl={providerFaviconUrl(row.name)}
                />
                <div className="home-mover-row-text">
                  <div className="home-mover-row-name">{row.name}</div>
                  <div className="home-mover-row-domain">
                    {[row.asn, row.country].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                <div className="home-mover-row-meta">
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

export function ProviderMovers() {
  const { data, isLoading } = useProviderMovers();
  const rising  = data?.rising  ?? [];
  const falling = data?.falling ?? [];

  if (isLoading) return null;

  return (
    <section className="home-provider-movers">
      <div className="home-provider-movers-label">Provider Movers</div>
      <div className="home-mover-grid">
        <MoverList
          title="Heating Up"
          rows={rising}
          accent={M.RED}
          accentDim={M.RED_DIM}
          formatDelta={(n) => `+${n.toLocaleString()}`}
          emptyLabel="No providers trending up over the last 7 days"
        />
        <MoverList
          title="Cooling Down"
          rows={falling}
          accent={M.GREEN}
          accentDim={M.GREEN_DIM}
          formatDelta={(n) => `${n.toLocaleString()}`}
          emptyLabel="No providers trending down over the last 7 days"
        />
      </div>

      {/* Self-contained CSS — same class set as BrandMovers so the
          two visually match exactly. Inlined here (rather than
          shared) so this section keeps working if BrandMovers is
          ever removed or refactored independently. */}
      <style>{`
        .home-provider-movers {
          padding: 22px 24px 0;
        }
        .home-provider-movers-label {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          color: var(--text-tertiary);
          margin-bottom: 12px;
        }
        .home-provider-movers .home-mover-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: 1fr;
        }
        .home-provider-movers .home-mover-list {
          padding: 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .home-provider-movers .home-mover-list-title {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }
        .home-provider-movers .home-mover-empty {
          padding: 16px 4px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
        }
        .home-provider-movers .home-mover-rows {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .home-provider-movers .home-mover-row {
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
        .home-provider-movers .home-mover-row:hover {
          background: rgba(255,255,255,0.03);
          border-color: rgba(255,255,255,0.08);
        }
        .home-provider-movers .home-mover-row-text {
          flex: 1;
          min-width: 0;
        }
        .home-provider-movers .home-mover-row-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-provider-movers .home-mover-row-domain {
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          margin-top: 1px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-provider-movers .home-mover-row-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .home-provider-movers .home-mover-delta {
          font-family: var(--font-mono);
          font-size: 11px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 8px;
          border: 1px solid;
        }

        @container home (min-width: 480px) {
          .home-provider-movers { padding: 22px 32px 0; }
        }
        @container home (min-width: 700px) {
          .home-provider-movers .home-mover-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
      `}</style>
    </section>
  );
}
