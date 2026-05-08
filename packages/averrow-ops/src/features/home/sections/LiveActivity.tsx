// Phase 4 of the unified Home rebuild — Live Activity ticker.
//
// Demoted from co-equal "Latest Intelligence" to a thin notification
// stream below the Daily Briefing, per the Intelligence consolidation
// decision. The Briefing is the differentiator (AI synthesis); this
// is just the raw event pulse so operators can scan recent activity
// without leaving Home.
//
// Each row is single-line: severity dot, title, relative time. Click
// drills to the notification's link, falling back to /alerts.

import { useNavigate } from 'react-router-dom';
import { useNotifications } from '@/hooks/useNotifications';

const SEV_DOT_COLOR: Record<string, string> = {
  critical: 'var(--sev-critical)',
  high:     'var(--sev-high)',
  medium:   'var(--sev-medium)',
  low:      'var(--sev-low)',
  info:     'var(--text-tertiary)',
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

export function LiveActivity() {
  const navigate = useNavigate();
  const { data } = useNotifications(true);

  const items = (data?.notifications ?? []).slice(0, 5);

  return (
    <section className="home-live-activity">
      <header className="home-live-activity-header">
        <span className="home-live-activity-label">Live Activity</span>
        <button
          type="button"
          onClick={() => navigate('/alerts')}
          className="home-live-activity-viewall"
          aria-label="View all alerts"
        >
          View all →
        </button>
      </header>

      {items.length === 0 ? (
        <div className="home-live-activity-empty">
          No recent intelligence events
        </div>
      ) : (
        <ul className="home-live-activity-rows">
          {items.map((item) => {
            const sev = (item.severity || 'info').toLowerCase();
            const dotColor = SEV_DOT_COLOR[sev] ?? SEV_DOT_COLOR.info;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => item.link ? navigate(item.link) : navigate('/alerts')}
                  className="home-live-activity-row"
                >
                  <span className="home-live-activity-dot" style={{ background: dotColor }} aria-hidden />
                  <span className="home-live-activity-title">{item.title}</span>
                  <span className="home-live-activity-time">{relTime(item.created_at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <style>{`
        .home-live-activity {
          margin: 12px 24px 0;
          padding: 12px 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
        }
        .home-live-activity-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 4px;
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
        }
        .home-live-activity-row {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 7px 6px;
          border-radius: 6px;
          background: transparent;
          border: none;
          cursor: pointer;
          color: inherit;
          font: inherit;
          text-align: left;
          transition: background-color 0.12s ease;
        }
        .home-live-activity-row:hover {
          background: rgba(255,255,255,0.03);
        }
        .home-live-activity-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .home-live-activity-title {
          flex: 1;
          min-width: 0;
          font-size: 12px;
          color: var(--text-primary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .home-live-activity-time {
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }
        .home-live-activity-empty {
          padding: 14px 0;
          text-align: center;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-muted);
        }

        @container home (min-width: 480px) {
          .home-live-activity { margin: 12px 32px 0; padding: 14px 20px; }
        }
      `}</style>
    </section>
  );
}
