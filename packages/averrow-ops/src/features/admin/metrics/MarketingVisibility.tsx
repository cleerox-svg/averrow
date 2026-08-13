// Marketing & AI Visibility — "Marketing" tab of /admin.
//
// Surfaces the marketing-analytics endpoint's human-vs-AI-crawler traffic
// split: how many human page views the marketing site got, how much AI
// crawler/agent traffic hit it (GPTBot/ClaudeBot/PerplexityBot…), how many
// human sessions arrived via an AI referral (chat services sending
// prospects our way), plus CTA clicks and contact-form submissions. Mirrors
// the FeedFailures.tsx idiom (Card, loading/error early returns, Tile/Stat
// sub-components, design-token styling only).

import { Card } from '@/design-system/components';
import { useMarketingAnalytics } from '@/hooks/useMetrics';
import type { MarketingVisibility as MarketingVisibilityPayload } from '@/hooks/useMetrics';

export function MarketingVisibility() {
  const { data, isLoading, isError } = useMarketingAnalytics();

  if (isError) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load marketing analytics. Try again in a moment.
        </p>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading marketing analytics…
        </p>
      </Card>
    );
  }

  const allZero =
    data.humanViews === 0 &&
    data.aiCrawlerViews === 0 &&
    data.otherBotViews === 0 &&
    data.aiReferralSessions === 0 &&
    data.ctaClicks === 0 &&
    data.contactSubs === 0;

  if (allZero) {
    return (
      <Card variant="elevated" className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No marketing traffic recorded yet — beacon + edge logging may still be warming up.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Totals data={data} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <AiCrawlerBreakdown data={data} />
        <AiReferralBySource data={data} />
      </div>
      <TopPages data={data} />
    </div>
  );
}

// ─── Headline totals strip ───────────────────────────────────────
function Totals({ data }: { data: MarketingVisibilityPayload }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <Tile label={`Human views · ${data.windowHours}h`} value={data.humanViews.toLocaleString()} />
      <Tile label="AI crawler hits" value={data.aiCrawlerViews.toLocaleString()} accent="amber" />
      <Tile label="AI referral sessions" value={data.aiReferralSessions.toLocaleString()} accent="blue" />
      <Tile label="CTA clicks" value={data.ctaClicks.toLocaleString()} accent="green" />
      <Tile label="Contact submissions" value={data.contactSubs.toLocaleString()} accent="green" />
    </div>
  );
}

function Tile({
  label, value, accent,
}: {
  label: string;
  value: string;
  accent?: 'green' | 'amber' | 'blue';
}) {
  const color =
    accent === 'green' ? 'var(--green)' :
    accent === 'amber' ? 'var(--amber)' :
    accent === 'blue'  ? 'var(--blue)' :
                          'var(--text-primary)';
  return (
    <Card variant="elevated" className="p-3">
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="font-display text-2xl font-bold" style={{ color }}>
        {value}
      </div>
    </Card>
  );
}

// ─── AI crawler breakdown — "which AI is looking at us" ──────────
function AiCrawlerBreakdown({ data }: { data: MarketingVisibilityPayload }) {
  const rows = [...data.aiCrawlerBreakdown].sort((a, b) => b.hits - a.hits);
  const maxHits = Math.max(...rows.map(r => r.hits), 1);

  return (
    <Card variant="elevated" className="p-4">
      <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
        AI crawler breakdown
      </div>
      <div className="font-mono text-[10px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
        Which AI crawlers are indexing the marketing site
      </div>
      {rows.length === 0 ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No AI crawler activity recorded in this window.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map(row => (
            <div key={row.crawler_name}>
              <div className="flex items-center justify-between font-mono text-[11px] mb-1">
                <span style={{ color: 'var(--text-primary)' }}>{row.crawler_name}</span>
                <span style={{ color: 'var(--amber)' }}>{row.hits.toLocaleString()}</span>
              </div>
              <div className="rounded-full overflow-hidden" style={{ height: 3, background: 'var(--border-base)' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max((row.hits / maxHits) * 100, 2)}%`,
                    background: 'var(--amber)',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── AI referral sources — "AI sending us prospects" ─────────────
function AiReferralBySource({ data }: { data: MarketingVisibilityPayload }) {
  const rows = [...data.aiReferralBySource].sort((a, b) => b.sessions - a.sessions);
  const maxSessions = Math.max(...rows.map(r => r.sessions), 1);

  return (
    <Card variant="elevated" className="p-4">
      <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
        AI referral sources
      </div>
      <div className="font-mono text-[10px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
        Human sessions arriving from AI chat services
      </div>
      {rows.length === 0 ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          No AI-referred sessions recorded in this window.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map(row => (
            <div key={row.ai_source}>
              <div className="flex items-center justify-between font-mono text-[11px] mb-1">
                <span style={{ color: 'var(--text-primary)' }}>{row.ai_source}</span>
                <span style={{ color: 'var(--blue)' }}>{row.sessions.toLocaleString()}</span>
              </div>
              <div className="rounded-full overflow-hidden" style={{ height: 3, background: 'var(--border-base)' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max((row.sessions / maxSessions) * 100, 2)}%`,
                    background: 'var(--blue)',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Top pages table ──────────────────────────────────────────────
function TopPages({ data }: { data: MarketingVisibilityPayload }) {
  const rows = data.topPages;

  return (
    <div className="space-y-3">
      <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
        Top pages
      </div>
      <Card variant="elevated" className="p-4">
        {rows.length === 0 ? (
          <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
            No page-view data recorded in this window.
          </p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {rows.map((row, i) => (
              <div
                key={`${row.page}-${i}`}
                className="flex items-center justify-between gap-3 py-1.5 border-b last:border-b-0"
                style={{ borderColor: 'var(--border-base)' }}
              >
                <span
                  className="font-mono text-[11px] truncate"
                  style={{ color: 'var(--text-secondary)' }}
                  title={row.page}
                >
                  {row.page}
                </span>
                <span className="font-mono text-[11px] flex-shrink-0" style={{ color: 'var(--text-primary)' }}>
                  {row.views.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
