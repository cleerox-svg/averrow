// D1 Budget — Metrics page section 2.
//
// Shows the platform's D1 row-read consumption against Cloudflare's
// 25B-rows/month plan ceiling, plus the 24h top-rows-read queries
// and per-endpoint attribution so an operator can immediately
// answer "are we burning budget? where is it going?"

import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { useD1Budget } from '@/hooks/useMetrics';
import { MetricsTile, type MetricsTone } from './MetricsTile';

export function D1BudgetSection() {
  const { data, isLoading, isError } = useD1Budget();

  return (
    <Card style={{ padding: '16px' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="section-label font-mono font-bold">D1 Budget</span>
        {data && (
          <span
            className="font-mono text-[9px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {data.budget_state.stale ? 'stale snapshot' : 'live'}
          </span>
        )}
      </div>

      {isError ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load D1 budget. Try again in a moment.
        </p>
      ) : isLoading || !data ? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading D1 budget…
        </p>
      ) : (
        <div className="space-y-4">
          <BudgetMeters payload={data} />
          <TopQueries payload={data} />
          <TopEndpoints payload={data} />
        </div>
      )}
    </Card>
  );
}

// ─── Daily + monthly meters ──────────────────────────────────────
function BudgetMeters({ payload }: { payload: NonNullable<ReturnType<typeof useD1Budget>['data']> }) {
  const daily = payload.budget_state;
  const monthly = payload.metrics_24h;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {/* Daily */}
      <Meter
        label="Today"
        sublabel={daily.rows_read_24h != null
          ? `${daily.rows_read_24h.toLocaleString()} / ${daily.daily_budget.toLocaleString()}`
          : 'no data'}
        pct={daily.pct_of_daily_budget}
        tone={
          daily.threshold_state === 'skip' ? 'failed'
            : daily.threshold_state === 'warn' ? 'warning'
              : daily.threshold_state === 'ok'   ? 'success'
                : 'inactive'
        }
        toneLabel={daily.threshold_state.toUpperCase()}
        footnote={
          daily.skip_count_24h > 0
            ? `${daily.skip_count_24h} Navigator skips in last 24h`
            : 'No Navigator skips in last 24h'
        }
      />
      {/* Monthly projection */}
      <Meter
        label="Monthly projection"
        sublabel={monthly.monthly_rows_read_projection != null
          ? `${formatBig(monthly.monthly_rows_read_projection)} / 25B plan ceiling`
          : 'no data'}
        pct={monthly.pct_of_25b_plan_ceiling}
        tone={
          (monthly.pct_of_25b_plan_ceiling ?? 0) >= 90 ? 'failed'
            : (monthly.pct_of_25b_plan_ceiling ?? 0) >= 75 ? 'warning'
              : 'success'
        }
        toneLabel={
          (monthly.pct_of_25b_plan_ceiling ?? 0) >= 90 ? 'AT RISK'
            : (monthly.pct_of_25b_plan_ceiling ?? 0) >= 75 ? 'WATCH'
              : 'HEALTHY'
        }
        footnote={
          monthly.read_queries_24h != null && monthly.write_queries_24h != null
            ? `${monthly.read_queries_24h.toLocaleString()} reads · ${monthly.write_queries_24h.toLocaleString()} writes (24h)`
            : ''
        }
      />
    </div>
  );
}

function Meter({
  label,
  sublabel,
  pct,
  tone,
  toneLabel,
  footnote,
}: {
  label: string;
  sublabel: string;
  pct: number | null;
  tone: MetricsTone;
  toneLabel: string;
  footnote: string;
}) {
  const safe = Math.max(0, Math.min(100, pct ?? 0));
  const barColor =
    tone === 'failed'  ? 'var(--sev-critical)'
      : tone === 'warning' ? 'var(--sev-medium)'
        : tone === 'success' ? 'var(--sev-info)'
          : 'var(--text-muted)';
  return (
    <MetricsTile
      label={label}
      tone={tone}
      badge={<Badge status={badgeStatusFor(tone)} label={toneLabel} size="xs" />}
    >
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="font-display text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
          {pct != null ? `${pct}%` : '—'}
        </span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {sublabel}
        </span>
      </div>
      <div
        className="rounded-full overflow-hidden mb-1"
        style={{ height: 4, background: 'rgba(255,255,255,0.06)' }}
      >
        <div
          style={{
            height: '100%',
            width: `${safe}%`,
            background: barColor,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      {footnote ? (
        <span className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
          {footnote}
        </span>
      ) : null}
    </MetricsTile>
  );
}

// ─── Top queries (rows_read 24h) ─────────────────────────────────
function TopQueries({ payload }: { payload: NonNullable<ReturnType<typeof useD1Budget>['data']> }) {
  const queries = payload.top_queries;
  if (queries.length === 0) {
    return (
      <Section
        title="Top queries (rows read · 24h)"
        emptyMessage={
          payload.top_queries_error
            ? `Top-queries probe error: ${payload.top_queries_error}`
            : 'No queries in the rolling 24h window.'
        }
      />
    );
  }
  return (
    <Section title="Top queries (rows read · 24h)">
      <ul className="space-y-1">
        {queries.map((q, i) => (
          <li key={`${q.query_hash}-${i}`} className="flex items-start gap-3 py-1 border-b border-white/[0.04]">
            <span
              className="font-mono text-[10px] font-bold shrink-0"
              style={{ color: 'var(--text-primary)', minWidth: 70 }}
            >
              {formatBig(q.rows_read)}
            </span>
            <span
              className="font-mono text-[9px] flex-1 line-clamp-2"
              style={{ color: 'var(--text-secondary)' }}
              title={q.query_sample}
            >
              {q.query_sample.replace(/\s+/g, ' ').trim()}
            </span>
            <span
              className="font-mono text-[9px] shrink-0"
              style={{ color: 'var(--text-muted)' }}
              title={`${q.query_count} runs · avg ${q.avg_rows_per_query.toLocaleString()} rows/query`}
            >
              ×{q.query_count}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ─── Top endpoints (rows_read 24h) ───────────────────────────────
function TopEndpoints({ payload }: { payload: NonNullable<ReturnType<typeof useD1Budget>['data']> }) {
  const { by_endpoint, setup_required, setup_instructions, error } = payload.attribution;

  if (setup_required) {
    return (
      <Section
        title="Top endpoints (rows read · 24h)"
        emptyMessage={setup_instructions ?? 'Endpoint attribution not configured.'}
      />
    );
  }
  if (error) {
    return (
      <Section
        title="Top endpoints (rows read · 24h)"
        emptyMessage={`Attribution probe error: ${error}`}
      />
    );
  }
  if (by_endpoint.length === 0) {
    return (
      <Section
        title="Top endpoints (rows read · 24h)"
        emptyMessage="No endpoint reads recorded in the last 24h."
      />
    );
  }

  return (
    <Section title="Top endpoints (rows read · 24h)">
      <ul className="space-y-1">
        {by_endpoint.map((e) => (
          <li
            key={e.endpoint}
            className="flex items-baseline gap-3 py-1 border-b border-white/[0.04]"
          >
            <span
              className="font-mono text-[10px] font-bold shrink-0"
              style={{ color: 'var(--text-primary)', minWidth: 70 }}
            >
              {formatBig(e.total_rows_read)}
            </span>
            <span
              className="font-mono text-[10px] flex-1 truncate"
              style={{ color: 'var(--text-secondary)' }}
              title={e.endpoint}
            >
              {e.endpoint}
            </span>
            <span
              className="font-mono text-[9px] shrink-0"
              style={{ color: 'var(--text-muted)' }}
              title={`${e.request_count} requests · avg ${e.avg_rows_per_request.toLocaleString()} rows/request`}
            >
              {e.request_count} req
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Section({
  title,
  children,
  emptyMessage,
}: {
  title: string;
  children?: React.ReactNode;
  emptyMessage?: string;
}) {
  return (
    <div>
      <div
        className="font-mono text-[9px] uppercase tracking-[0.18em] mb-1.5"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {title}
      </div>
      {children ?? (
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {emptyMessage}
        </p>
      )}
    </div>
  );
}

function badgeStatusFor(tone: MetricsTone): 'success' | 'warning' | 'failed' | 'pending' | 'inactive' {
  if (tone === 'failed')   return 'failed';
  if (tone === 'warning')  return 'warning';
  if (tone === 'success')  return 'success';
  if (tone === 'info')     return 'success';
  return 'inactive';
}

function formatBig(n: number): string {
  if (n >= 1e9)  return `${(n / 1e9 ).toFixed(1)}B`;
  if (n >= 1e6)  return `${(n / 1e6 ).toFixed(1)}M`;
  if (n >= 1e3)  return `${(n / 1e3 ).toFixed(1)}K`;
  return n.toLocaleString();
}
