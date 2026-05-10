// D1 Budget, v3 treatment for /admin/metrics-v3.
//
// v2's D1BudgetSection is one Card with a 2-up meter row + two
// dense lists. The data is well-organised but reads as a wall of
// text — hard to spot the top spender at a glance.
//
// v3 keeps the same data, restructures it for at-a-glance triage:
//
//   - Budget meters surfaced as standalone tiles at the top, with
//     bigger numbers + a percentage gauge bar
//   - Top queries / Top endpoints rendered as ranked cards in a
//     3-up grid. Each card shows a relative-consumption bar so
//     the dominant spender pops visually.
//   - Cards click-to-expand inline for full SQL + per-query
//     stats (queries) or full endpoint URL + request stats.
//
// Same hook (useD1Budget) → same data → same backend cost.

import { Fragment, useState } from 'react';
import { Card } from '@/design-system/components';
import { Badge } from '@/components/ui/Badge';
import { ChevronDown } from 'lucide-react';
import { useD1Budget } from '@/hooks/useMetrics';
import type {
  D1BudgetPayload, D1TopQuery, D1EndpointAttribution,
} from '@/hooks/useMetrics';

export function D1BudgetV3() {
  const { data, isLoading, isError } = useD1Budget();

  if (isError) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
          Failed to load D1 budget. Try again in a moment.
        </p>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Loading D1 budget…
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <BudgetMeters payload={data} />
      <TopQueriesGrid payload={data} />
      <TopEndpointsGrid payload={data} />
    </div>
  );
}

// ─── Budget meters ───────────────────────────────────────────────
function BudgetMeters({ payload }: { payload: D1BudgetPayload }) {
  const daily = payload.budget_state;
  const monthly = payload.metrics_24h;

  const dailyTone =
    daily.threshold_state === 'skip' ? 'critical' :
    daily.threshold_state === 'warn' ? 'high' :
    daily.threshold_state === 'ok'   ? 'green' :
                                       'muted';
  const dailyBadge =
    daily.threshold_state === 'skip' ? { sev: 'critical' as const, label: 'SKIP' } :
    daily.threshold_state === 'warn' ? { sev: 'high'     as const, label: 'WARN' } :
    daily.threshold_state === 'ok'   ? null :
                                       { sev: 'medium'   as const, label: 'NO DATA' };

  const monthlyPct = monthly.pct_of_25b_plan_ceiling ?? 0;
  const monthlyTone =
    monthlyPct >= 90 ? 'critical' :
    monthlyPct >= 75 ? 'high' :
                       'green';
  const monthlyBadge =
    monthlyPct >= 90 ? { sev: 'critical' as const, label: 'AT RISK' } :
    monthlyPct >= 75 ? { sev: 'high'     as const, label: 'WATCH'   } :
                       null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Meter
        label="Today's budget"
        primary={daily.pct_of_daily_budget != null ? `${daily.pct_of_daily_budget}%` : '—'}
        sublabel={daily.rows_read_24h != null
          ? `${daily.rows_read_24h.toLocaleString()} of ${daily.daily_budget.toLocaleString()} rows`
          : 'no data'}
        pct={daily.pct_of_daily_budget}
        tone={dailyTone}
        badge={dailyBadge}
        footnote={daily.skip_count_24h > 0
          ? `${daily.skip_count_24h} Navigator skips in last 24h`
          : 'No Navigator skips in last 24h'}
      />
      <Meter
        label="Monthly projection"
        primary={monthly.pct_of_25b_plan_ceiling != null ? `${monthly.pct_of_25b_plan_ceiling}%` : '—'}
        sublabel={monthly.monthly_rows_read_projection != null
          ? `${formatBig(monthly.monthly_rows_read_projection)} of 25B plan ceiling`
          : 'no data'}
        pct={monthly.pct_of_25b_plan_ceiling}
        tone={monthlyTone}
        badge={monthlyBadge}
        footnote={monthly.read_queries_24h != null && monthly.write_queries_24h != null
          ? `${monthly.read_queries_24h.toLocaleString()} reads · ${monthly.write_queries_24h.toLocaleString()} writes (24h)`
          : ''}
      />
    </div>
  );
}

type Tone = 'critical' | 'high' | 'green' | 'muted';
function toneColor(t: Tone): string {
  if (t === 'critical') return 'var(--sev-critical)';
  if (t === 'high')     return 'var(--sev-high)';
  if (t === 'green')    return 'var(--green)';
  return 'var(--text-muted)';
}

function Meter({
  label, primary, sublabel, pct, tone, badge, footnote,
}: {
  label:    string;
  primary:  string;
  sublabel: string;
  pct:      number | null;
  tone:     Tone;
  badge:    { sev: 'critical' | 'high' | 'medium'; label: string } | null;
  footnote: string;
}) {
  const safe = Math.max(0, Math.min(100, pct ?? 0));
  const bar = toneColor(tone);
  const variant: 'elevated' | 'critical' | 'active' =
    tone === 'critical' ? 'critical' :
    tone === 'high'     ? 'critical' :
                          'elevated';
  return (
    <Card variant={variant} className="p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: 'var(--text-tertiary)' }}>
          {label}
        </span>
        {badge && <Badge severity={badge.sev}>{badge.label}</Badge>}
      </div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="font-display text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {primary}
        </span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          {sublabel}
        </span>
      </div>
      <div
        className="rounded-full overflow-hidden mb-2"
        style={{ height: 6, background: 'var(--border-base)' }}
      >
        <div
          style={{
            height: '100%',
            width: `${safe}%`,
            background: bar,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      {footnote && (
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {footnote}
        </span>
      )}
    </Card>
  );
}

// ─── Top queries grid ────────────────────────────────────────────
function TopQueriesGrid({ payload }: { payload: D1BudgetPayload }) {
  const queries = payload.top_queries;
  const total = queries.reduce((s, q) => s + q.rows_read, 0);
  const [selected, setSelected] = useState<string | null>(null);

  if (queries.length === 0) {
    return (
      <SectionEmpty
        title="Top queries · rows read · 24h"
        message={payload.top_queries_error
          ? `Top-queries probe error: ${payload.top_queries_error}`
          : 'No queries in the rolling 24h window.'}
      />
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeader title="Top queries · rows read · 24h" count={queries.length} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {queries.map((q, i) => {
          const pct = total > 0 ? (q.rows_read / total) * 100 : 0;
          const isSel = selected === q.query_hash;
          return (
            <Fragment key={`${q.query_hash}-${i}`}>
              <QueryCard
                rank={i + 1}
                query={q}
                pctOfTotal={pct}
                isSelected={isSel}
                onSelect={() => setSelected(prev => prev === q.query_hash ? null : q.query_hash)}
              />
              {isSel && <QueryDetail query={q} pctOfTotal={pct} />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function QueryCard({
  rank, query, pctOfTotal, isSelected, onSelect,
}: {
  rank:       number;
  query:      D1TopQuery;
  pctOfTotal: number;
  isSelected: boolean;
  onSelect:   () => void;
}) {
  // Tier the card by how much of the top-N total this query consumes.
  const tone: Tone =
    pctOfTotal >= 30 ? 'critical' :
    pctOfTotal >= 15 ? 'high' :
                       'green';
  const variant: 'elevated' | 'critical' = tone === 'critical' ? 'critical' : 'elevated';
  const barColor = toneColor(tone);

  return (
    <Card
      variant={variant}
      className="p-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="font-mono text-[10px] font-bold w-5 h-5 rounded grid place-items-center flex-shrink-0"
          style={{ background: 'var(--bg-input)', color: 'var(--text-tertiary)' }}
        >
          {rank}
        </span>
        <span
          className="font-display text-base font-bold flex-1"
          style={{ color: 'var(--text-primary)' }}
        >
          {formatBig(query.rows_read)}
        </span>
        <span
          className="font-mono text-[10px] font-bold flex-shrink-0"
          style={{ color: barColor }}
        >
          {pctOfTotal.toFixed(0)}%
        </span>
        <ChevronDown
          size={12}
          style={{
            color:      'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </div>

      {/* % of top-N total bar */}
      <div
        className="rounded-full overflow-hidden mb-2"
        style={{ height: 3, background: 'var(--border-base)' }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, pctOfTotal)}%`,
            background: barColor,
          }}
        />
      </div>

      <div
        className="font-mono text-[10px] line-clamp-2"
        style={{ color: 'var(--text-secondary)' }}
        title={query.query_sample}
      >
        {query.query_sample.replace(/\s+/g, ' ').trim()}
      </div>

      <div className="flex items-center gap-3 mt-1.5 font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
        <span>{query.query_count.toLocaleString()} runs</span>
        <span>·</span>
        <span>{formatBig(query.avg_rows_per_query)} rows/run avg</span>
      </div>
    </Card>
  );
}

function QueryDetail({ query, pctOfTotal }: { query: D1TopQuery; pctOfTotal: number }) {
  return (
    <Card variant="elevated" className="p-4 col-span-full">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
        <Stat label="Total rows read" value={query.rows_read.toLocaleString()} />
        <Stat label="% of top-N total" value={`${pctOfTotal.toFixed(1)}%`} />
        <Stat label="Runs · 24h" value={query.query_count.toLocaleString()} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-3">
        <Stat label="Avg rows / run" value={formatBig(query.avg_rows_per_query)} />
        <Stat label="Rows written" value={query.rows_written.toLocaleString()} />
        <Stat label="Query hash" value={query.query_hash.slice(0, 12)} mono />
      </div>
      <div>
        <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
          Full SQL
        </div>
        <pre
          className="font-mono text-[11px] p-3 rounded overflow-x-auto whitespace-pre-wrap break-words"
          style={{
            background: 'var(--bg-input)',
            color:      'var(--text-primary)',
            border:     '1px solid var(--border-base)',
            maxHeight:  240,
          }}
        >
          {query.query_sample}
        </pre>
      </div>
    </Card>
  );
}

// ─── Top endpoints grid ──────────────────────────────────────────
function TopEndpointsGrid({ payload }: { payload: D1BudgetPayload }) {
  const { by_endpoint, setup_required, setup_instructions, error } = payload.attribution;
  const total = by_endpoint.reduce((s, e) => s + e.total_rows_read, 0);
  const [selected, setSelected] = useState<string | null>(null);

  if (setup_required) {
    return (
      <SectionEmpty
        title="Top endpoints · rows read · 24h"
        message={setup_instructions ?? 'Endpoint attribution not configured.'}
      />
    );
  }
  if (error) {
    return (
      <SectionEmpty
        title="Top endpoints · rows read · 24h"
        message={`Attribution probe error: ${error}`}
      />
    );
  }
  if (by_endpoint.length === 0) {
    return (
      <SectionEmpty
        title="Top endpoints · rows read · 24h"
        message="No endpoint reads recorded in the last 24h."
      />
    );
  }

  return (
    <div className="space-y-3">
      <SectionHeader title="Top endpoints · rows read · 24h" count={by_endpoint.length} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {by_endpoint.map((e, i) => {
          const pct = total > 0 ? (e.total_rows_read / total) * 100 : 0;
          const isSel = selected === e.endpoint;
          return (
            <Fragment key={e.endpoint}>
              <EndpointCard
                rank={i + 1}
                endpoint={e}
                pctOfTotal={pct}
                isSelected={isSel}
                onSelect={() => setSelected(prev => prev === e.endpoint ? null : e.endpoint)}
              />
              {isSel && <EndpointDetail endpoint={e} pctOfTotal={pct} />}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function EndpointCard({
  rank, endpoint, pctOfTotal, isSelected, onSelect,
}: {
  rank:       number;
  endpoint:   D1EndpointAttribution;
  pctOfTotal: number;
  isSelected: boolean;
  onSelect:   () => void;
}) {
  const tone: Tone =
    pctOfTotal >= 30 ? 'critical' :
    pctOfTotal >= 15 ? 'high' :
                       'green';
  const variant: 'elevated' | 'critical' = tone === 'critical' ? 'critical' : 'elevated';
  const barColor = toneColor(tone);

  return (
    <Card
      variant={variant}
      className="p-3 cursor-pointer transition-all"
      onClick={onSelect}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="font-mono text-[10px] font-bold w-5 h-5 rounded grid place-items-center flex-shrink-0"
          style={{ background: 'var(--bg-input)', color: 'var(--text-tertiary)' }}
        >
          {rank}
        </span>
        <span
          className="font-display text-base font-bold flex-1"
          style={{ color: 'var(--text-primary)' }}
        >
          {formatBig(endpoint.total_rows_read)}
        </span>
        <span
          className="font-mono text-[10px] font-bold flex-shrink-0"
          style={{ color: barColor }}
        >
          {pctOfTotal.toFixed(0)}%
        </span>
        <ChevronDown
          size={12}
          style={{
            color:      'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform:  isSelected ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </div>
      <div
        className="rounded-full overflow-hidden mb-2"
        style={{ height: 3, background: 'var(--border-base)' }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.min(100, pctOfTotal)}%`,
            background: barColor,
          }}
        />
      </div>
      <div
        className="font-mono text-[10px] truncate"
        style={{ color: 'var(--text-secondary)' }}
        title={endpoint.endpoint}
      >
        {endpoint.endpoint}
      </div>
      <div className="flex items-center gap-3 mt-1.5 font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
        <span>{endpoint.request_count} requests</span>
        <span>·</span>
        <span>{formatBig(endpoint.avg_rows_per_request)} rows/req avg</span>
      </div>
    </Card>
  );
}

function EndpointDetail({ endpoint, pctOfTotal }: { endpoint: D1EndpointAttribution; pctOfTotal: number }) {
  return (
    <Card variant="elevated" className="p-4 col-span-full">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-3">
        <Stat label="Total rows read" value={endpoint.total_rows_read.toLocaleString()} />
        <Stat label="% of top-N total" value={`${pctOfTotal.toFixed(1)}%`} />
        <Stat label="Requests · 24h" value={endpoint.request_count.toString()} />
        <Stat label="Avg rows / req" value={formatBig(endpoint.avg_rows_per_request)} />
      </div>
      <div>
        <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
          Full endpoint
        </div>
        <div
          className="font-mono text-[12px] p-2 rounded break-all"
          style={{
            background: 'var(--bg-input)',
            color:      'var(--text-primary)',
            border:     '1px solid var(--border-base)',
          }}
        >
          {endpoint.endpoint}
        </div>
      </div>
    </Card>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────
function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <span
        className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold"
        style={{ color: 'var(--text-primary)' }}
      >
        {title}
      </span>
      <span
        className="font-mono text-[10px] px-2 py-0.5 rounded"
        style={{
          background: 'var(--bg-input)',
          color:      'var(--text-secondary)',
          border:     '1px solid var(--border-base)',
        }}
      >
        {count}
      </span>
    </div>
  );
}

function SectionEmpty({ title, message }: { title: string; message: string }) {
  return (
    <div className="space-y-2">
      <div
        className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold"
        style={{ color: 'var(--text-primary)' }}
      >
        {title}
      </div>
      <p className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {message}
      </p>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.15em] uppercase" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div
        className={mono ? 'text-sm font-mono' : 'text-lg font-mono'}
        style={{ color: 'var(--text-primary)' }}
      >
        {value}
      </div>
    </div>
  );
}

function formatBig(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}
