// Intel Hotlist Home section — PR-A from the 2026-05-16 platform audit.
//
// Surfaces three classes of high-signal intel that already exist
// in the threats table but never reached the UI:
//   1. Mass-impersonation IPs — IPs hitting many distinct brands
//   2. Multi-feed consensus   — IPs flagged by ≥4 independent feeds
//   3. Recent bursts          — domain swarms targeting one brand
//                               in a tight time window
//
// Visual language follows BrandMovers / ProviderMovers (the "Heating
// Up" pattern user pointed at as the home-page polish baseline):
// outer section with 22px top padding, glass-card list container,
// each row = leading icon + 2-line text + right-side metric badge,
// hover row with border-base background. Three list cards stack in
// one column on narrow viewports, 3-column grid at ≥900px.

import { useNavigate } from 'react-router-dom';
import { Server, Layers, Zap } from 'lucide-react';
import { useIntelHotlist } from '@/hooks/useIntelHotlist';
import type { FanoutIp, ConsensusIp, Burst } from '@/hooks/useIntelHotlist';
import { BrandAvatar } from '@/components/ui/BrandAvatar';
import { M } from '@/design-system/tokens';

function relTimeFromSqlite(s: string): string {
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function GlyphIcon({
  Icon,
  color,
  dimColor,
}: {
  Icon: typeof Server;
  color: string;
  dimColor: string;
}) {
  return (
    <span
      className="home-intel-glyph"
      aria-hidden
      style={{
        background: `linear-gradient(160deg, ${color}28, ${dimColor}18)`,
        border: `1px solid ${color}40`,
      }}
    >
      <Icon size={14} color={color} strokeWidth={2.2} />
    </span>
  );
}

function MetricBadge({
  label,
  color,
}: {
  label: string;
  color: string;
}) {
  return (
    <span
      className="home-intel-metric"
      style={{
        color,
        background: `${color}18`,
        borderColor: `${color}40`,
      }}
    >
      {label}
    </span>
  );
}

function HotlistList({
  title,
  count,
  emptyLabel,
  accent,
  accentDim,
  Icon,
  children,
}: {
  title: string;
  count: number;
  emptyLabel: string;
  accent: string;
  accentDim: string;
  Icon: typeof Server;
  children: React.ReactNode;
}) {
  return (
    <div className="home-intel-list">
      <div className="home-intel-list-header">
        <GlyphIcon Icon={Icon} color={accent} dimColor={accentDim} />
        <span className="home-intel-list-title">{title}</span>
        <span className="home-intel-list-count">{count > 0 ? count : ''}</span>
      </div>
      {count === 0 ? (
        <div className="home-intel-empty">{emptyLabel}</div>
      ) : (
        <ul className="home-intel-rows">{children}</ul>
      )}
    </div>
  );
}

export function IntelHotlist() {
  const navigate = useNavigate();
  const { data, isLoading } = useIntelHotlist(5);

  const fanout = data?.top_fanout_ips ?? [];
  const consensus = data?.multi_feed_consensus ?? [];
  const bursts = data?.recent_bursts ?? [];

  // Hide section entirely when fully empty (matches LatestIntel/
  // BrandMovers behavior) so the Home column doesn't show three
  // empty placeholders.
  const allEmpty = !isLoading && fanout.length === 0 && consensus.length === 0 && bursts.length === 0;
  if (allEmpty) return null;

  return (
    <section className="home-intel-hotlist">
      <div className="home-intel-grid">
        <HotlistList
          title="Mass-Impersonation IPs"
          count={fanout.length}
          emptyLabel="No mass-impersonation infrastructure detected"
          accent={M.RED}
          accentDim={M.RED_DIM}
          Icon={Server}
        >
          {fanout.slice(0, 5).map((row: FanoutIp) => (
            <li key={row.ip_address}>
              <button
                type="button"
                className="home-intel-row"
                onClick={() =>
                  navigate(`/threats?ip=${encodeURIComponent(row.ip_address)}`)
                }
                title={`${row.threat_count.toLocaleString()} active threats · last seen ${row.last_seen}`}
              >
                <GlyphIcon Icon={Server} color={M.RED} dimColor={M.RED_DIM} />
                <div className="home-intel-row-text">
                  <div className="home-intel-row-name home-intel-row-name-mono">
                    {row.ip_address}
                  </div>
                  <div className="home-intel-row-sub">
                    {row.threat_count.toLocaleString()} threats
                  </div>
                </div>
                <div className="home-intel-row-meta">
                  <MetricBadge
                    label={`${row.brand_count} brands`}
                    color={M.RED}
                  />
                </div>
              </button>
            </li>
          ))}
        </HotlistList>

        <HotlistList
          title="Multi-Feed Consensus"
          count={consensus.length}
          emptyLabel="No multi-feed corroborated IPs"
          accent={M.AMBER}
          accentDim={M.AMBER_DIM}
          Icon={Layers}
        >
          {consensus.slice(0, 5).map((row: ConsensusIp) => (
            <li key={row.ip_address}>
              <button
                type="button"
                className="home-intel-row"
                onClick={() =>
                  navigate(`/threats?ip=${encodeURIComponent(row.ip_address)}`)
                }
                title={`Flagged by: ${row.feeds}`}
              >
                <GlyphIcon Icon={Layers} color={M.AMBER} dimColor={M.AMBER_DIM} />
                <div className="home-intel-row-text">
                  <div className="home-intel-row-name home-intel-row-name-mono">
                    {row.ip_address}
                  </div>
                  <div className="home-intel-row-sub">
                    {row.threat_count.toLocaleString()} threats
                  </div>
                </div>
                <div className="home-intel-row-meta">
                  <MetricBadge
                    label={`${row.feed_count} feeds`}
                    color={M.AMBER}
                  />
                </div>
              </button>
            </li>
          ))}
        </HotlistList>

        <HotlistList
          title="Recent Bursts · 24h"
          count={bursts.length}
          emptyLabel="No burst events in the last 24h"
          accent={M.AMBER}
          accentDim={M.AMBER_DIM}
          Icon={Zap}
        >
          {bursts.slice(0, 5).map((b: Burst) => (
            <li key={`${b.brand_id}-${b.hour_bucket}`}>
              <button
                type="button"
                className="home-intel-row"
                onClick={() =>
                  navigate(`/brands/${encodeURIComponent(b.brand_id)}`)
                }
                title={`${b.distinct_domains.toLocaleString()} distinct domains · window ${b.burst_start} → ${b.burst_end}`}
              >
                <BrandAvatar
                  name={b.brand_name}
                  color={M.AMBER}
                  dimColor={M.AMBER_DIM}
                  faviconUrl={
                    b.brand_logo_url ??
                    (b.brand_domain
                      ? `https://www.google.com/s2/favicons?domain=${b.brand_domain}&sz=64`
                      : null)
                  }
                />
                <div className="home-intel-row-text">
                  <div className="home-intel-row-name">{b.brand_name}</div>
                  <div className="home-intel-row-sub">
                    {b.distinct_domains.toLocaleString()} domains · {relTimeFromSqlite(b.hour_bucket)}
                  </div>
                </div>
                <div className="home-intel-row-meta">
                  <MetricBadge
                    label={`${b.threat_count} in 1h`}
                    color={M.AMBER}
                  />
                </div>
              </button>
            </li>
          ))}
        </HotlistList>
      </div>

      <style>{`
        .home-intel-hotlist {
          padding: 22px 24px 0;
        }
        .home-intel-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: 1fr;
        }
        .home-intel-list {
          padding: 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .home-intel-list-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .home-intel-list-title {
          flex: 1;
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }
        .home-intel-list-count {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-muted);
          letter-spacing: 0.06em;
        }
        .home-intel-glyph {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .home-intel-empty {
          padding: 16px 4px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
        }
        .home-intel-rows {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .home-intel-row {
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
        .home-intel-row:hover {
          background: var(--border-base);
          border-color: var(--border-base);
        }
        .home-intel-row-text {
          flex: 1;
          min-width: 0;
        }
        .home-intel-row-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-intel-row-name-mono {
          font-family: var(--font-mono);
          font-size: 12px;
        }
        .home-intel-row-sub {
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          margin-top: 1px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-intel-row-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .home-intel-metric {
          font-family: var(--font-mono);
          font-size: 11px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 8px;
          border: 1px solid;
        }

        @container home (min-width: 480px) {
          .home-intel-hotlist { padding: 22px 32px 0; }
        }
        @container home (min-width: 900px) {
          .home-intel-grid { grid-template-columns: repeat(3, 1fr); }
        }
      `}</style>
    </section>
  );
}
