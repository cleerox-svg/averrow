// Latest Intel section — surfaces narrative agent_outputs that
// previously went to /dev/null. Reads /api/insights/latest, which
// returns Analyst + Cartographer + Strategist insights (was dead
// before the 2026-05-16 platform audit: Analyst's "External Validation"
// / "Risk Score Spike" / "Active Phishing + No DMARC" rows and
// Cartographer's per-provider Haiku narratives never reached a UI).
//
// Complementary to:
//   - DailyBriefing   (Observer/Narrator AI synthesis, daily cadence)
//   - LiveActivity    (system_notifications, event-driven)
//
// This section is the steady drip of agent-narrative intel that
// neither of those covers.

import { useNavigate } from 'react-router-dom';
import { useLatestInsights } from '@/hooks/useInsights';

const SEV_DOT_COLOR: Record<string, string> = {
  critical: 'var(--sev-critical)',
  high:     'var(--sev-high)',
  medium:   'var(--sev-medium)',
  low:      'var(--sev-low)',
  info:     'var(--text-tertiary)',
};

const AGENT_LABEL: Record<string, string> = {
  analyst:      'Analyst',
  cartographer: 'Cartographer',
  strategist:   'Strategist',
  narrator:     'Narrator',
  observer:     'Observer',
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

// Strip markdown bold delimiters from summary text — the agents emit
// `**Risk Score Spike** — Brand …` and we want the bare text since
// we render the title in our own type style.
function cleanSummary(s: string): string {
  return s.replace(/\*\*/g, '').trim();
}

export function LatestIntel() {
  const navigate = useNavigate();
  const { data, isLoading } = useLatestInsights(5);

  const items = data ?? [];

  return (
    <section className="home-latest-intel">
      <header className="home-latest-intel-header">
        <span className="home-latest-intel-label">Latest Intel</span>
        <button
          type="button"
          onClick={() => navigate('/agents')}
          className="home-latest-intel-viewall"
          aria-label="View all agent outputs"
        >
          View all →
        </button>
      </header>

      {isLoading && items.length === 0 ? (
        <div className="home-latest-intel-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="home-latest-intel-empty">
          No new agent insights yet. Cartographer + Analyst run hourly.
        </div>
      ) : (
        <ul className="home-latest-intel-rows">
          {items.map((item) => {
            const sev = (item.severity || 'info').toLowerCase();
            const dotColor = SEV_DOT_COLOR[sev] ?? SEV_DOT_COLOR.info;
            const agentLabel = AGENT_LABEL[item.agent_name] ?? item.agent_name;
            return (
              <li key={item.id}>
                <div className="home-latest-intel-row">
                  <span
                    className="home-latest-intel-dot"
                    style={{ background: dotColor }}
                    aria-hidden
                  />
                  <div className="home-latest-intel-content">
                    <div className="home-latest-intel-meta">
                      <span className="home-latest-intel-agent">{agentLabel}</span>
                      <span className="home-latest-intel-time">{relTime(item.created_at)}</span>
                    </div>
                    <div className="home-latest-intel-summary">
                      {cleanSummary(item.summary_text)}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <style>{`
        .home-latest-intel {
          margin: 12px 24px 0;
          padding: 12px 16px;
          border-radius: 12px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
        }
        .home-latest-intel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
        }
        .home-latest-intel-label {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }
        .home-latest-intel-viewall {
          background: none;
          border: none;
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-secondary);
          cursor: pointer;
          padding: 2px 4px;
        }
        .home-latest-intel-viewall:hover {
          color: var(--text-primary);
        }
        .home-latest-intel-empty {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--text-muted);
          padding: 6px 0;
        }
        .home-latest-intel-rows {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .home-latest-intel-row {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 6px 0;
          border-top: 1px solid var(--border-base);
        }
        .home-latest-intel-rows li:first-child .home-latest-intel-row {
          border-top: none;
          padding-top: 0;
        }
        .home-latest-intel-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-top: 6px;
          flex-shrink: 0;
        }
        .home-latest-intel-content {
          flex: 1;
          min-width: 0;
        }
        .home-latest-intel-meta {
          display: flex;
          justify-content: space-between;
          margin-bottom: 2px;
          font-family: var(--font-mono);
          font-size: 9px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }
        .home-latest-intel-agent {
          color: var(--amber);
        }
        .home-latest-intel-time {
          color: var(--text-muted);
        }
        .home-latest-intel-summary {
          font-size: 13px;
          line-height: 1.4;
          color: var(--text-primary);
        }
      `}</style>
    </section>
  );
}
