// Live Activity ticker — raw event pulse below the Daily Briefing.
//
// Visual language follows BrandMovers / ProviderMovers (the home-page
// polish baseline): outer section with 22px top padding, glass-card
// container, list rows with leading severity glyph + 2-line title/
// time block + click drills to the notification's link.
//
// Pre-2026-05-16 the rows were single-line with white-space:nowrap,
// truncating long notification titles mid-word ("Feed AlienVault OTX
// (TAXII 2.1) at risk of auto-pa…"). Rebuilt to allow titles to
// wrap to 2 lines so the operator can read what fired without
// drilling into the bell tray.

import { useNavigate } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { useNotifications } from '@/hooks/useNotifications';
import { BrandAvatar } from '@/components/ui/BrandAvatar';
import { M } from '@/design-system/tokens';

const SEV_COLOR: Record<string, { fg: string; dim: string }> = {
  critical: { fg: 'var(--sev-critical)', dim: 'var(--sev-critical-dim, rgba(239,68,68,0.30))' },
  high:     { fg: 'var(--sev-high)',     dim: 'var(--sev-high-dim, rgba(245,158,11,0.30))'  },
  medium:   { fg: 'var(--sev-medium)',   dim: 'var(--sev-medium-dim, rgba(234,179,8,0.30))' },
  low:      { fg: 'var(--sev-low)',      dim: 'var(--sev-low-dim, rgba(34,197,94,0.30))'    },
  info:     { fg: 'var(--text-tertiary)', dim: 'var(--border-base)' },
};

// Severity → BrandAvatar accent pair so brand-scoped rows still
// communicate severity via the tint surrounding the favicon.
const SEV_AVATAR_ACCENT: Record<string, { color: string; dim: string }> = {
  critical: { color: M.RED,    dim: M.RED_DIM    },
  high:     { color: M.AMBER,  dim: M.AMBER_DIM  },
  medium:   { color: M.AMBER,  dim: M.AMBER_DIM  },
  low:      { color: M.GREEN,  dim: M.GREEN_DIM  },
  info:     { color: M.BLUE,   dim: M.BLUE_DIM   },
};

function relTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function SevGlyph({ severity }: { severity: string }) {
  const sev = SEV_COLOR[severity] ?? SEV_COLOR.info;
  return (
    <span
      className="home-live-activity-glyph"
      aria-hidden
      style={{
        background: `linear-gradient(160deg, ${sev.fg}28, ${sev.dim}18)`,
        border: `1px solid ${sev.fg}40`,
      }}
    >
      <Activity size={14} color={sev.fg} strokeWidth={2.2} />
    </span>
  );
}

export function LiveActivity() {
  const navigate = useNavigate();
  const { data } = useNotifications(true);

  const items = (data?.notifications ?? []).slice(0, 5);

  return (
    <section className="home-live-activity">
      <div className="home-live-activity-card">
        <div className="home-live-activity-header">
          <span className="home-live-activity-label">Live Activity</span>
          <button
            type="button"
            onClick={() => navigate('/alerts')}
            className="home-live-activity-viewall"
            aria-label="View all alerts"
          >
            View all →
          </button>
        </div>

        {items.length === 0 ? (
          <div className="home-live-activity-empty">
            No recent intelligence events
          </div>
        ) : (
          <ul className="home-live-activity-rows">
            {items.map((item) => {
              const sev = (item.severity || 'info').toLowerCase();
              const hasBrand = !!item.brand_id;
              const accent = SEV_AVATAR_ACCENT[sev] ?? SEV_AVATAR_ACCENT.info;
              const faviconUrl =
                item.brand_logo_url ??
                (item.brand_domain
                  ? `https://www.google.com/s2/favicons?domain=${item.brand_domain}&sz=64`
                  : null);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => item.link ? navigate(item.link) : navigate('/alerts')}
                    className="home-live-activity-row"
                  >
                    {hasBrand ? (
                      <BrandAvatar
                        name={item.brand_name ?? item.title}
                        color={accent.color}
                        dimColor={accent.dim}
                        faviconUrl={faviconUrl}
                      />
                    ) : (
                      <SevGlyph severity={sev} />
                    )}
                    <div className="home-live-activity-row-text">
                      <div className="home-live-activity-row-title">{item.title}</div>
                      <div className="home-live-activity-row-time">{relTime(item.created_at)}</div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <style>{`
        .home-live-activity {
          padding: 22px 24px 0;
        }
        .home-live-activity-card {
          padding: 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .home-live-activity-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .home-live-activity-label {
          font-family: var(--font-mono);
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.20em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }
        .home-live-activity-viewall {
          padding: 0;
          background: none;
          border: none;
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: var(--amber);
          cursor: pointer;
        }
        .home-live-activity-rows {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .home-live-activity-row {
          width: 100%;
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 8px;
          border-radius: 10px;
          background: transparent;
          border: 1px solid transparent;
          cursor: pointer;
          color: inherit;
          font: inherit;
          text-align: left;
          transition: background-color 0.12s ease, border-color 0.12s ease;
        }
        .home-live-activity-row:hover {
          background: var(--border-base);
          border-color: var(--border-base);
        }
        .home-live-activity-glyph {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .home-live-activity-row-text {
          flex: 1;
          min-width: 0;
        }
        .home-live-activity-row-title {
          font-size: 13px;
          color: var(--text-primary);
          line-height: 1.35;
          /* Allow titles to wrap to two lines instead of being
             truncated mid-word like the pre-2026-05-16 version. */
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .home-live-activity-row-time {
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          letter-spacing: 0.04em;
          margin-top: 2px;
        }
        .home-live-activity-empty {
          padding: 14px 0;
          text-align: center;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-muted);
        }

        @container home (min-width: 480px) {
          .home-live-activity { padding: 22px 32px 0; }
        }
      `}</style>
    </section>
  );
}
