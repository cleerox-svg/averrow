// Phase 4 of the unified Home rebuild — Daily Briefing hero.
//
// The differentiator on Home, per the Intelligence consolidation
// decision: this is the AI-curated narrative from the Observer agent.
// Notifications get demoted to a thin "Live Activity" ticker below.
//
// Each briefing item:
//   - Severity-coded left stripe + Severity badge
//   - First line emphasized as a title; rest as supporting body
//   - Native <details> for inline expand/collapse — no JS state
//   - Relative timestamp + agent attribution
//
// Refresh button triggers the daily briefing job; the Observer cron
// runs at 09:00 ET / 13:00 UTC anyway, but operators sometimes want
// to force-refresh after an incident.

import { useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useIntelligenceBriefings } from '@/hooks/useTrends';
import { useDailyBriefing } from '@/hooks/useDailyBriefing';
import { Badge } from '@/components/ui/Badge';

const SEV_COLOR: Record<string, string> = {
  critical: 'var(--sev-critical)',
  high:     'var(--sev-high)',
  medium:   'var(--sev-medium)',
  low:      'var(--sev-low)',
  info:     'var(--amber)',
};

function cleanMarkdown(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/^##\s/gm, '')
    .replace(/^#\s/gm, '');
}

function splitTitle(summary: string): { title: string; body: string } {
  const cleaned = cleanMarkdown(summary).trim();
  // Briefings tend to begin with "Title — body…" or "Title. Body…".
  // Split on the first em-dash or sentence-ender to surface the headline.
  const dash = cleaned.indexOf(' — ');
  if (dash > 0 && dash < 140) {
    return { title: cleaned.slice(0, dash), body: cleaned.slice(dash + 3) };
  }
  const dot = cleaned.search(/\.[ \n]/);
  if (dot > 0 && dot < 140) {
    return { title: cleaned.slice(0, dot), body: cleaned.slice(dot + 1).trim() };
  }
  // No detectable split — treat whole thing as the title preview.
  return { title: cleaned.slice(0, 140), body: cleaned.slice(140).trim() };
}

function relTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function DailyBriefing() {
  const navigate = useNavigate();
  const { data: intelItems } = useIntelligenceBriefings(5);
  const { refetch, isFetching } = useDailyBriefing();

  const list = Array.isArray(intelItems) ? intelItems : [];
  const items = list.slice(0, 4);
  const latest = items[0];

  return (
    <section className="home-briefing">
      <header className="home-briefing-header">
        <div>
          <div className="home-briefing-eyebrow">
            <Badge status="active" label="Observer" size="xs" />
            <span className="home-briefing-eyebrow-text">PLATFORM OPERATIONS BRIEFING</span>
          </div>
          <h2 className="home-briefing-title">Analyst's Briefing</h2>
          {latest && (
            <div className="home-briefing-subtitle">
              Latest{' '}
              {new Date(latest.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh briefing"
          className="home-briefing-refresh"
          style={{ opacity: isFetching ? 0.5 : 1 }}
        >
          <RefreshCw
            size={11}
            style={{ animation: isFetching ? 'home-spin 0.6s linear infinite' : 'none' }}
          />
          Refresh
        </button>
      </header>

      {items.length === 0 ? (
        <div className="home-briefing-empty">
          No briefing generated yet. Observer runs daily at 09:00 ET.
        </div>
      ) : (
        <ol className="home-briefing-items">
          {items.map((item) => {
            const sev = (item.severity || 'info').toLowerCase();
            const stripeColor = SEV_COLOR[sev] ?? SEV_COLOR.info;
            const { title, body } = splitTitle(item.summary);
            const bodyTrunc = body.length > 280 ? body.slice(0, 280) + '…' : body;
            const isCrit = sev === 'critical' || sev === 'high';
            return (
              <li
                key={item.id}
                className="home-briefing-item"
                style={{ borderLeftColor: stripeColor }}
              >
                <div className="home-briefing-item-meta">
                  {isCrit
                    ? <Badge severity={sev as 'critical' | 'high'} size="xs" />
                    : <Badge status="active" size="xs" label="Info" />}
                  <span className="home-briefing-item-time">{relTime(item.created_at)}</span>
                </div>
                <div className="home-briefing-item-title">{title}</div>
                {body && (
                  <details className="home-briefing-item-details">
                    <summary>{bodyTrunc}</summary>
                    <div className="home-briefing-item-fullbody">{body}</div>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <button
        type="button"
        onClick={() => navigate('/trends')}
        className="home-briefing-viewall"
      >
        View full briefing →
      </button>

      <style>{`
        .home-briefing {
          margin: 22px 24px 0;
          padding: 22px 24px;
          border-radius: 14px;
          background: linear-gradient(160deg, var(--bg-card), var(--bg-card-deep));
          border: 1px solid var(--border-base);
          box-shadow: 0 8px 32px rgba(0,0,0,0.45);
          position: relative;
        }
        .home-briefing-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 18px;
        }
        .home-briefing-eyebrow {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .home-briefing-eyebrow-text {
          font-size: 9px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          letter-spacing: 0.18em;
        }
        .home-briefing-title {
          font-size: 18px;
          font-weight: 900;
          color: var(--text-primary);
          margin: 0;
          letter-spacing: -0.2px;
        }
        .home-briefing-subtitle {
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          margin-top: 4px;
        }
        .home-briefing-refresh {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 8px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--border-base);
          color: var(--text-tertiary);
          font-size: 10px;
          font-family: var(--font-mono);
          letter-spacing: 0.10em;
          text-transform: uppercase;
          cursor: pointer;
          flex-shrink: 0;
        }
        .home-briefing-empty {
          padding: 32px 0;
          text-align: center;
          font-size: 13px;
          font-style: italic;
          color: var(--text-muted);
        }
        .home-briefing-items {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .home-briefing-item {
          padding: 4px 0 4px 16px;
          border-left: 3px solid;
        }
        .home-briefing-item-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .home-briefing-item-time {
          font-size: 9px;
          font-family: var(--font-mono);
          color: var(--text-muted);
          letter-spacing: 0.10em;
        }
        .home-briefing-item-title {
          font-size: 14px;
          font-weight: 700;
          color: var(--text-primary);
          letter-spacing: -0.1px;
          line-height: 1.4;
          margin-bottom: 6px;
        }
        .home-briefing-item-details {
          font-size: 13px;
          line-height: 1.65;
          color: var(--text-secondary);
        }
        .home-briefing-item-details > summary {
          cursor: pointer;
          list-style: none;
        }
        .home-briefing-item-details > summary::-webkit-details-marker {
          display: none;
        }
        .home-briefing-item-details[open] > summary {
          color: var(--text-tertiary);
        }
        .home-briefing-item-fullbody {
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--border-base);
          color: var(--text-primary);
          white-space: pre-wrap;
        }
        .home-briefing-viewall {
          margin-top: 16px;
          padding: 0;
          background: none;
          border: none;
          font-size: 10px;
          font-family: var(--font-mono);
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: var(--amber);
          cursor: pointer;
        }

        @keyframes home-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .home-briefing-refresh svg { animation: none !important; }
        }

        @container home (min-width: 480px) {
          .home-briefing { margin: 22px 32px 0; padding: 24px 28px; }
          .home-briefing-title { font-size: 20px; }
        }
      `}</style>
    </section>
  );
}
