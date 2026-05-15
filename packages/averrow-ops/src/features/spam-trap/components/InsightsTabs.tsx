// Wave-4 PR-AE: Insights tabs for the Spam Trap surface.
//
// Three new tabs that the audit (Wave 4) and follow-up (Wave 1.2 +
// 3.3) called for:
//
//   Trends       — weekly capture chart + per-channel productive
//                   rate + cohort time-to-first-catch
//   Correlations — abuse_mailbox captures with overlap counts
//                   against the seeded-honeypot universe
//                   (the "covert spam trap" payoff)
//   Strategy     — seed_strategist agent state: last run, recent
//                   auto-prune count, recent diagnostic outputs
//
// All three render directly from useSpamTrapInsights() — one
// round-trip, KV-cached at 5min on the backend. Empty states are
// honest (no fake data, no loading skeleton beyond the parent
// page's PageLoader).

import type { CSSProperties } from 'react';
import { TrendingUp, GitBranch, Settings, ArrowRight, AlertCircle } from 'lucide-react';
import { TrendSparkline } from '@/components/ui/TrendSparkline';
import { Badge } from '@/design-system/components';
import type {
  SpamTrapInsights,
  SpamTrapInsightsTrendsWeek,
  SpamTrapInsightsCohort,
  SpamTrapInsightsChannelRate,
  SpamTrapInsightsCorrelation,
  SpamTrapInsightsStrategyRun,
  SpamTrapInsightsStrategyOutput,
} from '@/hooks/useSpamTrap';
import { relativeTime } from '@/lib/time';

const GLASS_CARD: CSSProperties = {
  background: 'rgba(15,23,42,0.50)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid var(--border-base)',
  boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
};

const CHANNEL_COLOURS: Record<string, string> = {
  spider:        '#E5A832',
  broker:        '#A78BFA',
  paste:         '#fb923c',
  honeypot:      '#f87171',
  abuse_mailbox: '#0A8AB5',
  employee:      '#3CB878',
};

// ─── Trends tab ──────────────────────────────────────────────────

export function TrendsTab({ insights }: { insights: SpamTrapInsights | null }) {
  if (!insights) return <EmptyTab message="Loading trends…" />;
  const { weekly, cohorts, channel_rates } = insights.trends;
  return (
    <div className="space-y-4">
      <WeeklyTrendCard weekly={weekly} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChannelRatesCard rates={channel_rates} />
        <CohortsCard cohorts={cohorts} />
      </div>
    </div>
  );
}

function WeeklyTrendCard({ weekly }: { weekly: SpamTrapInsightsTrendsWeek[] }) {
  if (weekly.length === 0) {
    return (
      <div className="rounded-xl p-4" style={GLASS_CARD}>
        <SectionLabel>Weekly captures · 8 weeks</SectionLabel>
        <EmptyInline message="No captures recorded in the last 8 weeks." />
      </div>
    );
  }
  const totals = weekly.map((w) => w.total);
  return (
    <div className="rounded-xl p-4" style={GLASS_CARD}>
      <div className="flex items-center justify-between">
        <SectionLabel>Weekly captures · 8 weeks</SectionLabel>
        <span className="text-[10px] font-mono text-white/40">
          {totals.reduce((s, v) => s + v, 0)} total
        </span>
      </div>
      <div className="mt-3">
        <TrendSparkline data={totals} color="#fb923c" height={48} fill />
      </div>
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
        {weekly.slice(-4).map((w) => (
          <div key={w.week_start} className="rounded p-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-base)' }}>
            <div className="text-white/40 text-[9px] uppercase tracking-wider">{w.week_start}</div>
            <div className="text-white text-base font-bold tabular-nums mt-0.5">{w.total}</div>
            <div className="text-white/40 text-[10px] mt-0.5">
              top: {pickTopChannel(w)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function pickTopChannel(w: SpamTrapInsightsTrendsWeek): string {
  const channels = [
    { name: 'spider',         v: w.spider },
    { name: 'broker',         v: w.broker },
    { name: 'paste',          v: w.paste },
    { name: 'honeypot',       v: w.honeypot },
    { name: 'abuse_mailbox',  v: w.abuse_mailbox },
    { name: 'employee',       v: w.employee },
  ].filter((c) => c.v > 0).sort((a, b) => b.v - a.v);
  if (channels.length === 0) return '—';
  return `${channels[0]!.name} (${channels[0]!.v})`;
}

function ChannelRatesCard({ rates }: { rates: SpamTrapInsightsChannelRate[] }) {
  if (rates.length === 0) {
    return (
      <div className="rounded-xl p-4" style={GLASS_CARD}>
        <SectionLabel>Productive rate per channel</SectionLabel>
        <EmptyInline message="No active seeds across any channel." />
      </div>
    );
  }
  const max = Math.max(...rates.map((r) => r.total_seeds), 1);
  return (
    <div className="rounded-xl p-4" style={GLASS_CARD}>
      <SectionLabel>Productive rate per channel</SectionLabel>
      <div className="mt-3 space-y-2">
        {rates.map((r) => {
          const pct = r.total_seeds > 0 ? (r.productive_seeds / r.total_seeds) * 100 : 0;
          const colour = CHANNEL_COLOURS[r.channel] ?? '#78A0C8';
          return (
            <div key={r.channel} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-white/55 w-[100px] truncate capitalize">
                {r.channel}
              </span>
              <div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <div
                  className="h-full rounded-sm transition-all"
                  style={{
                    width: `${(r.total_seeds / max) * 100}%`,
                    background: colour,
                    opacity: r.productive_seeds > 0 ? 1 : 0.35,
                  }}
                />
              </div>
              <span className="font-mono text-[10px] tabular-nums text-white/55 w-[55px] text-right">
                {r.productive_seeds}/{r.total_seeds}
              </span>
              <span
                className="font-mono text-[10px] tabular-nums w-[40px] text-right"
                style={{ color: pct > 0 ? '#4ADE80' : 'var(--text-muted)' }}
              >
                {pct.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CohortsCard({ cohorts }: { cohorts: SpamTrapInsightsCohort[] }) {
  if (cohorts.length === 0) {
    return (
      <div className="rounded-xl p-4" style={GLASS_CARD}>
        <SectionLabel>Cohort time-to-first-catch</SectionLabel>
        <EmptyInline message="No seed cohorts in the last 8 weeks." />
      </div>
    );
  }
  return (
    <div className="rounded-xl p-4" style={GLASS_CARD}>
      <SectionLabel>Cohort time-to-first-catch · 8 weeks</SectionLabel>
      <table className="mt-3 w-full text-left">
        <thead>
          <tr className="border-b border-white/[0.06]">
            <th className="font-mono text-[9px] uppercase tracking-wider text-white/45 pb-1.5">Cohort</th>
            <th className="font-mono text-[9px] uppercase tracking-wider text-white/45 pb-1.5 text-right">Seeds</th>
            <th className="font-mono text-[9px] uppercase tracking-wider text-white/45 pb-1.5 text-right">Caught</th>
            <th className="font-mono text-[9px] uppercase tracking-wider text-white/45 pb-1.5 text-right">Avg days</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.cohort_week} className="border-b border-white/[0.03]">
              <td className="py-1.5 font-mono text-[11px] text-white/65">{c.cohort_week}</td>
              <td className="py-1.5 font-mono text-[11px] text-white/55 text-right tabular-nums">{c.seeds_in_cohort}</td>
              <td className="py-1.5 font-mono text-[11px] text-right tabular-nums" style={{ color: c.caught > 0 ? '#4ADE80' : 'var(--text-muted)' }}>
                {c.caught}
              </td>
              <td className="py-1.5 font-mono text-[11px] text-white/55 text-right tabular-nums">
                {c.avg_days_to_first_catch != null ? c.avg_days_to_first_catch.toFixed(1) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Correlations tab ────────────────────────────────────────────

export function CorrelationsTab({ insights }: { insights: SpamTrapInsights | null }) {
  if (!insights) return <EmptyTab message="Loading correlations…" />;
  const rows = insights.correlations.recent;
  return (
    <div className="rounded-xl p-4" style={GLASS_CARD}>
      <div className="flex items-center justify-between">
        <SectionLabel>Abuse-mailbox ↔ honeypot correlations</SectionLabel>
        <span className="text-[10px] font-mono text-white/40">{rows.length} recent</span>
      </div>
      <p className="text-[11px] text-white/45 mt-2 leading-relaxed">
        For each public abuse-mailbox submission, counts how many seeded-honeypot captures share the same sender domain or sending IP. Non-zero values mean the submitter is on infrastructure we already see attacking other surfaces — strong signal.
      </p>
      {rows.length === 0
        ? <EmptyInline message="No abuse-mailbox captures yet. Submissions to abuse@ / phishing@ / report@ / security@ on production domains will appear here." />
        : (
          <div className="mt-3 space-y-2">
            {rows.map((r) => <CorrelationRow key={r.id} row={r} />)}
          </div>
        )}
    </div>
  );
}

function CorrelationRow({ row }: { row: SpamTrapInsightsCorrelation }) {
  const sevColour = severityColour(row.severity);
  const correlated = row.by_domain > 0 || row.by_ip > 0;
  return (
    <div
      className="rounded-lg px-3 py-2"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.04)',
        ...(correlated ? { borderTop: '1px solid rgba(248,113,113,0.50)' } : {}),
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: sevColour, boxShadow: `0 0 6px ${sevColour}` }} />
          <span className="text-[12px] text-white/80 truncate">
            {row.subject ?? <span className="italic text-white/40">(no subject)</span>}
          </span>
        </div>
        <span className="text-[10px] font-mono text-white/40 shrink-0">{relativeTime(row.captured_at)}</span>
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-white/45">
        {row.from_domain && <span>domain: <span className="text-white/65">{row.from_domain}</span></span>}
        {row.sending_ip && <span>ip: <span className="text-white/65">{row.sending_ip}</span></span>}
      </div>
      {correlated && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono">
          <Badge severity="critical" size="xs">CORRELATED</Badge>
          {row.by_domain > 0 && <span className="text-white/55">{row.by_domain} same-domain honeypot capture{row.by_domain === 1 ? '' : 's'}</span>}
          {row.by_ip > 0 && <span className="text-white/55">{row.by_ip} same-IP honeypot capture{row.by_ip === 1 ? '' : 's'}</span>}
        </div>
      )}
    </div>
  );
}

function severityColour(s: string): string {
  switch (s.toLowerCase()) {
    case 'critical': return '#f87171';
    case 'high':     return '#fb923c';
    case 'medium':   return '#fbbf24';
    case 'low':      return '#78A0C8';
    default:         return '#78A0C8';
  }
}

// ─── Strategy tab ────────────────────────────────────────────────

export function StrategyTab({ insights }: { insights: SpamTrapInsights | null }) {
  if (!insights) return <EmptyTab message="Loading strategy state…" />;
  const { last_run, recent_prunes_30d, recent_outputs } = insights.strategy;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatTile label="Last run" value={last_run ? relativeTime(last_run.started_at) : 'never'} colour="#E5A832" />
        <StatTile label="Last status" value={last_run?.status ?? '—'} colour={last_run?.status === 'success' ? '#4ADE80' : '#fb923c'} />
        <StatTile label="Auto-pruned · 30d" value={String(recent_prunes_30d)} colour="#A78BFA" />
      </div>
      {last_run && (
        <div className="rounded-xl p-4" style={GLASS_CARD}>
          <SectionLabel>Last run detail</SectionLabel>
          <div className="mt-2 space-y-1 font-mono text-[11px] text-white/55">
            <div>id: <span className="text-white/80">{last_run.id}</span></div>
            <div>started: <span className="text-white/80">{last_run.started_at}</span></div>
            <div>completed: <span className="text-white/80">{last_run.completed_at ?? '—'}</span></div>
            <div>records processed: <span className="text-white/80">{last_run.records_processed}</span></div>
            {last_run.error_message && (
              <div className="flex items-start gap-2 mt-1.5 text-red-400">
                <AlertCircle size={12} className="shrink-0 mt-0.5" />
                <span>{last_run.error_message}</span>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="rounded-xl p-4" style={GLASS_CARD}>
        <SectionLabel>Recent strategist outputs</SectionLabel>
        {recent_outputs.length === 0
          ? <EmptyInline message="No strategist outputs yet. Agent runs every 6 hours." />
          : (
            <div className="mt-2 space-y-2">
              {recent_outputs.map((o) => <OutputRow key={o.id} output={o} />)}
            </div>
          )}
      </div>
    </div>
  );
}

function OutputRow({ output }: { output: SpamTrapInsightsStrategyOutput }) {
  return (
    <div
      className="rounded-lg px-3 py-2"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/45">
          {output.type}
        </span>
        <span className="text-[10px] font-mono text-white/40">{relativeTime(output.created_at)}</span>
      </div>
      <p className="text-[12px] text-white/75 leading-snug">{output.summary}</p>
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[9px] uppercase tracking-widest text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

function StatTile({ label, value, colour }: { label: string; value: string; colour: string }) {
  return (
    <div className="rounded-xl p-3" style={GLASS_CARD}>
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/40">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums" style={{ color: colour }}>
        {value}
      </div>
    </div>
  );
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="text-center text-white/40 text-sm font-mono py-12">
      {message}
    </div>
  );
}

function EmptyInline({ message }: { message: string }) {
  return (
    <p className="text-[11px] text-white/45 mt-3 leading-relaxed">{message}</p>
  );
}
