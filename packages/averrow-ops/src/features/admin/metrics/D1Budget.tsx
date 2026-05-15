// D1 Budget, v3 treatment for /admin/metrics.
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
  D1BudgetPayload, D1TopQuery, D1EndpointAttribution, D1DatabaseUsage,
} from '@/hooks/useMetrics';

export function D1Budget() {
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
      <BillingCycleBreakdown payload={data} />
      <TopQueriesGrid payload={data} />
      <TopEndpointsGrid payload={data} />
    </div>
  );
}

// ─── Budget meters ───────────────────────────────────────────────
function BudgetMeters({ payload }: { payload: D1BudgetPayload }) {
  const daily = payload.budget_state;
  const cycle = payload.billing_cycle;

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

  // PR-X: cycle-aware monthly meter. The previous version used a 24h × 30
  // rolling projection that filtered on a single databaseId and under-
  // reported by ~6x vs the actual Cloudflare invoice. The cycle meter
  // sums across all D1 databases on the account over the actual cycle
  // window (18th → 17th).
  const cyclePct = cycle.setup_required || cycle.error ? null : cycle.pct_of_25b_plan_ceiling;
  const cycleTone: Tone =
    cyclePct == null     ? 'muted' :
    cyclePct >= 100      ? 'critical' :
    cyclePct >= 90       ? 'critical' :
    cyclePct >= 75       ? 'high'     :
                           'green';
  const cycleBadge =
    cyclePct == null ? { sev: 'medium' as const, label: 'NO DATA' } :
    cyclePct >= 100  ? { sev: 'critical' as const, label: 'OVER' }    :
    cyclePct >= 90   ? { sev: 'critical' as const, label: 'AT RISK' } :
    cyclePct >= 75   ? { sev: 'high'     as const, label: 'WATCH'   } :
                       null;

  const cycleSublabel = cycle.setup_required
    ? cycle.setup_instructions ?? 'CF credentials not configured'
    : cycle.error
      ? `error: ${cycle.error.slice(0, 60)}`
      : `${formatBig(cycle.cycle_projection_rows_read)} projected of 25B ceiling`;

  const cycleFootnote = cycle.setup_required || cycle.error
    ? ''
    : `${formatBig(cycle.rows_read_cycle)} so far · day ${cycle.cycle.days_elapsed} of ${cycle.cycle.days_total} · cycle ${formatCycleRange(cycle.cycle.start, cycle.cycle.end)}`;

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
        label="Billing-cycle projection"
        primary={cyclePct != null ? `${cyclePct}%` : '—'}
        sublabel={cycleSublabel}
        pct={cyclePct}
        tone={cycleTone}
        badge={cycleBadge}
        footnote={cycleFootnote}
      />
    </div>
  );
}

// ─── Billing-cycle breakdown ────────────────────────────────────
// Per-D1-database rows_read/written split across the current cycle.
// Surfaces "which database is eating budget?" — historically the
// monthly meter filtered on the primary DB only, so the audit + geoip
// DBs were invisible even when they spiked.
function BillingCycleBreakdown({ payload }: { payload: D1BudgetPayload }) {
  const cycle = payload.billing_cycle;
  if (cycle.setup_required || cycle.error || cycle.per_database.length === 0) return null;

  const total = cycle.rows_read_cycle || 1;

  return (
    <div className="space-y-3">
      <SectionHeader title="Billing cycle · per-database reads" count={cycle.per_database.length} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cycle.per_database.map((db, i) => {
          const pct = (db.rows_read / total) * 100;
          return <DatabaseCard key={db.database_id} rank={i + 1} db={db} pctOfTotal={pct} />;
        })}
      </div>
    </div>
  );
}

function DatabaseCard({ rank, db, pctOfTotal }: { rank: number; db: D1DatabaseUsage; pctOfTotal: number }) {
  const tone: Tone =
    pctOfTotal >= 50 ? 'critical' :
    pctOfTotal >= 25 ? 'high' :
                       'green';
  const variant: 'elevated' | 'critical' = tone === 'critical' ? 'critical' : 'elevated';
  const barColor = toneColor(tone);
  const name = friendlyDatabaseName(db.database_id);
  return (
    <Card variant={variant} className="p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="font-mono text-[10px] font-bold w-5 h-5 rounded grid place-items-center flex-shrink-0"
          style={{ background: 'var(--bg-input)', color: 'var(--text-tertiary)' }}
        >
          {rank}
        </span>
        <span className="font-display text-base font-bold flex-1" style={{ color: 'var(--text-primary)' }}>
          {formatBig(db.rows_read)}
        </span>
        <span className="font-mono text-[10px] font-bold flex-shrink-0" style={{ color: barColor }}>
          {pctOfTotal.toFixed(0)}%
        </span>
      </div>
      <div className="rounded-full overflow-hidden mb-2" style={{ height: 3, background: 'var(--border-base)' }}>
        <div style={{ height: '100%', width: `${Math.min(100, pctOfTotal)}%`, background: barColor }} />
      </div>
      <div className="font-mono text-[10px] truncate" style={{ color: 'var(--text-secondary)' }} title={db.database_id}>
        {name}
      </div>
      <div className="flex items-center gap-3 mt-1.5 font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
        <span>{formatBig(db.rows_written)} writes</span>
        <span>·</span>
        <span>{db.read_queries.toLocaleString()} read queries</span>
      </div>
    </Card>
  );
}

// Resolve a friendlier label from the database id. Covers every D1
// database on the Cloudflare account `cleerox@gmail.com` per the
// dashboard snapshot — `trust-radar-v2` is this Worker's primary
// binding (DB in wrangler.toml); the others belong to sibling
// workers (imprsn8-db, mtrade-db, farmtrack-db) or are reference
// databases (geoip-db).
//
// Anything else is genuinely external (a future worker, an orphan
// from a deleted binding, etc.) — surfaced as `external · <id>`
// so the operator can tell at a glance it's not one of ours.
function friendlyDatabaseName(id: string): string {
  const map: Record<string, string> = {
    'a3776a5f-c07c-4e20-9f3b-8d7f8c7f90c6': 'trust-radar-v2 (DB)',
    '55d58eff-47f3-4533-afa4-e52d494376e0': 'trust-radar-v2-audit (AUDIT_DB)',
    'f47a6b18-b343-46d9-87e8-ef8ef4aa8521': 'geoip-db (GEOIP_DB)',
    '54ffc831-f9ff-4d24-bfbf-1b6f8f580261': 'mtrade-db',
    '57191073-aec7-4035-8cbb-689d4de647e6': 'farmtrack-db',
    'adf45280-e596-4e44-a9c2-963342ac4596': 'imprsn8-db',
  };
  return map[id] ?? `external · ${id.slice(0, 8)}`;
}

function formatCycleRange(startIso: string, endIso: string): string {
  const fmt = (d: Date) => `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`;
  return `${fmt(new Date(startIso))} → ${fmt(new Date(endIso))}`;
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

      {/* PR-Y: which database this query came from. Helps the operator
          distinguish trust-radar-v2 / AUDIT_DB / GEOIP_DB / other
          account DBs in the same top-queries leaderboard. */}
      {query.database_id && (
        <div
          className="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono"
          style={{
            background: 'var(--bg-input)',
            color:      'var(--text-secondary)',
            border:     '1px solid var(--border-base)',
            maxWidth:   '100%',
          }}
          title={query.database_id}
        >
          <span style={{ color: 'var(--text-muted)' }}>db</span>
          <span className="truncate">{friendlyDatabaseName(query.database_id)}</span>
        </div>
      )}

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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
        <Stat
          label="Database"
          value={query.database_id ? friendlyDatabaseName(query.database_id) : 'unknown'}
        />
        <Stat
          label="Database id"
          value={query.database_id ?? '—'}
          mono
        />
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
