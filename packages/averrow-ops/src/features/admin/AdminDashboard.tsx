import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useBudgetStatus, useBudgetBreakdown, useBudgetConfigMutation } from '@/hooks/useBudget';
import type { BudgetStatus } from '@/hooks/useBudget';
import { useAdminAction } from '@/hooks/useAdminAction';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageLoader } from '@/components/ui/PageLoader';
import { Badge, Button, Card, PageHeader, StatGrid, StatCard } from '@/design-system/components';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { DailyBriefingWidget } from '@/components/DailyBriefingWidget';
import { Mail, Rss, Download, Brain, Zap, ChevronDown, ChevronUp, AlertTriangle, Loader2, Check, X } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

function fmt(n: number): string {
  return n.toLocaleString();
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleString('default', { month: 'short' })} ${d.getDate()}`;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 px-3 py-2 backdrop-blur-sm" style={{ background: 'var(--bg-card)' }}>
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
      <div className="font-mono text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{fmt(payload[0].value)} threats</div>
    </div>
  );
}

function throttleColor(level: BudgetStatus['throttle_level']): string {
  switch (level) {
    case 'emergency': return 'text-accent';
    case 'hard': return 'text-[#fb923c]';
    case 'soft': return 'text-[#fbbf24]';
    default: return 'text-positive';
  }
}

function ThrottleBadge({ level }: { level: BudgetStatus['throttle_level'] }) {
  switch (level) {
    case 'emergency': return <Badge severity="critical" label="Emergency" />;
    case 'hard':      return <Badge status="warning"    label="Hard" />;
    case 'soft':      return <Badge status="warning"    label="Soft" />;
    default:          return <Badge status="active"     label="Normal" />;
  }
}

function BudgetPanel() {
  const { data: budget } = useBudgetStatus();
  const { data: breakdown } = useBudgetBreakdown();
  const mutation = useBudgetConfigMutation();
  const [editing, setEditing] = useState(false);
  const [limitInput, setLimitInput] = useState('');

  if (!budget) return null;

  const barPct = Math.min(budget.pct_used, 100);
  const barColor = budget.throttle_level === 'emergency' ? 'progress-bar-fill-red'
    : budget.throttle_level === 'hard' ? 'progress-bar-fill-amber'
    : budget.throttle_level === 'soft' ? 'progress-bar-fill-amber'
    : 'progress-bar-fill-teal';

  return (
    <Card style={{ padding: '20px', marginBottom: 16 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="section-label">AI Budget</div>
        <ThrottleBadge level={budget.throttle_level} />
      </div>

      {/* Spend bar */}
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className={`font-display text-lg font-bold ${throttleColor(budget.throttle_level)}`}>
            ${budget.spent_this_month.toFixed(2)}
          </span>
          <span className="font-mono text-[10px] text-white/40">
            / ${budget.config.monthly_limit_usd.toFixed(2)}
          </span>
        </div>
        <div className="progress-bar-track h-2 mb-1">
          <div className={barColor} style={{ width: `${barPct}%` }} />
        </div>
        <div className="font-mono text-[10px] text-white/55">{budget.pct_used.toFixed(1)}% used</div>
      </div>

      <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />

      {/* Key metrics */}
      <div className="grid grid-cols-2 gap-3 font-mono text-[10px]">
        <div>
          <div className="text-white/40 mb-0.5">Remaining</div>
          <div className="text-white/95 font-semibold">${budget.remaining.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-white/40 mb-0.5">Daily burn</div>
          <div className="text-white/95 font-semibold">${budget.daily_burn_rate.toFixed(2)}/day</div>
        </div>
        <div>
          <div className="text-white/40 mb-0.5">Projected</div>
          <div className={`font-semibold ${budget.projected_monthly > budget.config.monthly_limit_usd ? 'text-accent' : 'text-white/95'}`}>
            ${budget.projected_monthly.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-white/40 mb-0.5">Days left</div>
          <div className="text-white/95 font-semibold">{budget.days_in_month - budget.days_elapsed}</div>
        </div>
      </div>

      {budget.anthropic_reported > 0 && (
        <>
          <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />
          <div className="font-mono text-[10px] text-white/55">
            Anthropic reported: ${budget.anthropic_reported.toFixed(2)}
          </div>
        </>
      )}

      {/* Agent breakdown */}
      {breakdown && breakdown.length > 0 && (
        <>
          <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />
          <div className="font-mono text-[9px] uppercase tracking-widest text-white/40 mb-2">Spend by Agent</div>
          <div className="space-y-1.5">
            {breakdown.map((a) => (
              <div key={a.agent_id} className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-white/80">{a.agent_id}</span>
                <span className="text-white/60">${a.cost_usd.toFixed(3)} ({a.calls})</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Edit limit */}
      <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />
      {!editing ? (
        <button
          type="button"
          onClick={() => { setEditing(true); setLimitInput(String(budget.config.monthly_limit_usd)); }}
          className="font-mono text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
        >
          Edit monthly limit &rarr;
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-white/40">$</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={limitInput}
            onChange={(e) => setLimitInput(e.target.value)}
            className="w-20 rounded border border-white/10 px-2 py-1 font-mono text-[11px] text-white/95 outline-none focus:border-amber-400"
            style={{ background: 'var(--bg-card)' }}
          />
          <button
            type="button"
            onClick={() => {
              const val = parseFloat(limitInput);
              if (!isNaN(val) && val >= 0) {
                mutation.mutate({ monthly_limit_usd: val });
              }
              setEditing(false);
            }}
            className="font-mono text-[10px] text-positive hover:text-amber-300 transition-colors"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="font-mono text-[10px] text-white/55 hover:text-accent transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </Card>
  );
}

/* ─── Email Security Stats ─── */

interface EmailSecurityStats {
  scanned: number;
  pending: number;
  avg_score: number;
  total_brands: number;
  grades: { grade: string; count: number }[];
}

const GRADE_COLORS: Record<string, string> = {
  'A+': '#4ade80',
  'A': '#2dd4bf',
  'B': '#5eadb0',
  'C': '#fbbf24',
  'D': '#fb923c',
  'F': '#f87171',
};

function EmailSecuritySection() {
  const { data: stats } = useQuery({
    queryKey: ['email-security-stats'],
    queryFn: async () => {
      const res = await api.get<EmailSecurityStats>('/api/email-security/stats');
      return res.data ?? null;
    },
  });

  const scanAction = useAdminAction('/api/email-security/scan-all');

  const scanned = stats?.scanned ?? 0;
  const pending = stats?.pending ?? 0;
  const avgScore = stats?.avg_score ?? 0;
  const total = stats?.total_brands ?? (scanned + pending);
  const grades = stats?.grades ?? [];
  const coveragePct = total > 0 ? ((scanned / total) * 100) : 0;
  const maxGradeCount = Math.max(...grades.map(g => g.count ?? 0), 1);

  return (
    <div className="rounded-xl border border-white/10 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="section-label">Email Security Coverage</div>
        <div>
          {scanAction.state === 'idle' && (
            <button
              type="button"
              onClick={scanAction.confirm}
              className="rounded border border-white/10 hover:bg-white/5 transition-colorsflex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider"
            >
              <Mail className="w-3.5 h-3.5" />
              Scan All Brands &rarr;
            </button>
          )}
          {scanAction.state === 'confirming' && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-amber-400">Scan all pending brands?</span>
              <button
                type="button"
                onClick={scanAction.execute}
                className="rounded border border-white/10 hover:bg-white/5 transition-colorsflex items-center gap-1 px-2 py-1 font-mono text-[10px] text-green-400"
              >
                <Check className="w-3 h-3" /> Confirm
              </button>
              <button
                type="button"
                onClick={scanAction.cancel}
                className="rounded border border-white/10 hover:bg-white/5 transition-colorsflex items-center gap-1 px-2 py-1 font-mono text-[10px] text-white/40"
              >
                <X className="w-3 h-3" /> Cancel
              </button>
            </div>
          )}
          {scanAction.state === 'loading' && (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-amber-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning...
            </span>
          )}
          {scanAction.state === 'success' && (
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-green-400">
              <Check className="w-3.5 h-3.5" /> Email security scan queued for {pending} brands
            </span>
          )}
          {scanAction.state === 'error' && (
            <span className="font-mono text-[10px] text-red-400">{scanAction.error}</span>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="flex items-center gap-4 font-mono text-[11px] text-white/60">
        <span><strong className="text-white/95">{fmt(scanned)}</strong> scanned</span>
        <span>&middot;</span>
        <span><strong className="text-white/95">{fmt(pending)}</strong> pending</span>
        <span>&middot;</span>
        <span>Avg score: <strong className="text-white/95">{avgScore}/100</strong></span>
      </div>

      <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />

      {/* Grade distribution */}
      {grades.length > 0 && (
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-white/40 mb-3">Grade Distribution</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {grades.map((g) => {
              const color = GRADE_COLORS[g.grade] ?? '#78A0C8';
              const barWidth = maxGradeCount > 0 ? Math.max((g.count / maxGradeCount) * 100, 4) : 4;
              const isF = g.grade === 'F';
              return (
                <div key={g.grade} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span
                      className="font-mono text-[12px] font-bold"
                      style={isF
                        ? { color, textShadow: '0 0 20px rgba(200,60,60,0.8)' }
                        : { color }}
                    >
                      {g.grade}
                    </span>
                    <span
                      className={`font-mono text-[11px] ${isF ? 'font-bold' : ''}`}
                      style={{ color: isF ? color : undefined }}
                    >
                      {isF ? (
                        <span className="text-red-400 font-bold">{fmt(g.count)}</span>
                      ) : (
                        <span className="text-white/80">{fmt(g.count)}</span>
                      )}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${barWidth}%`, backgroundColor: color }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />

      {/* Scan coverage bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono text-[9px] uppercase tracking-widest text-white/40">Scan Coverage</span>
          <span className="font-mono text-[10px] text-white/70">
            {coveragePct.toFixed(1)}% &nbsp;({fmt(scanned)} / {fmt(total)})
          </span>
        </div>
        <div className="progress-bar-track h-2.5">
          <div className="progress-bar-fill-amber" style={{ width: `${Math.min(coveragePct, 100)}%` }} />
        </div>
      </div>
    </div>
  );
}

/* ─── Maintenance Operations ─── */

interface OperationConfig {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: string;
  confirmText: string;
  endpoint: string;
}

const OPERATIONS: OperationConfig[] = [
  {
    label: 'Force Feed Pull',
    icon: Rss,
    badge: 'Trigger all 15 active feeds now',
    confirmText: 'Force-pull all active feeds now, ignoring schedules.',
    endpoint: '/api/feeds/trigger-all',
  },
  {
    label: 'Import Top Brands',
    icon: Download,
    badge: 'Import from Tranco list',
    confirmText: 'Import top 10K brands from Tranco domain list. May take several minutes.',
    endpoint: '/api/admin/import-tranco',
  },
  {
    label: 'AI Attribution',
    icon: Brain,
    badge: 'Haiku-powered brand attribution',
    confirmText: 'Run AI attribution on unattributed threats.',
    endpoint: '/api/admin/backfill-ai-attribution',
  },
  {
    label: 'Run 10x Feeds',
    icon: Zap,
    badge: '10 batches with 15s delays',
    confirmText: 'Run feeds 10 times in sequence. Only use for initial data loading.',
    endpoint: '/api/feeds/trigger-all',
  },
];

function OperationCard({ op }: { op: OperationConfig }) {
  const action = useAdminAction(op.endpoint);
  const Icon = op.icon;

  return (
    <div className="rounded-xl border border-white/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-amber-400" />
        <span className="font-mono text-[12px] font-semibold text-white/95">{op.label}</span>
      </div>
      <div className="font-mono text-[10px] text-white/40">{op.badge}</div>

      {action.state === 'idle' && (
        <button
          type="button"
          onClick={action.confirm}
          className="rounded border border-white/10 hover:bg-white/5 transition-colorsw-full px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider"
        >
          Run
        </button>
      )}
      {action.state === 'confirming' && (
        <div className="space-y-2">
          <div className="font-mono text-[10px] text-amber-400/80">{op.confirmText}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={action.execute}
              className="rounded border border-white/10 hover:bg-white/5 transition-colorsflex-1 flex items-center justify-center gap-1 px-2 py-1.5 font-mono text-[10px] text-green-400"
            >
              <Check className="w-3 h-3" /> Confirm
            </button>
            <button
              type="button"
              onClick={action.cancel}
              className="rounded border border-white/10 hover:bg-white/5 transition-colorsflex-1 flex items-center justify-center gap-1 px-2 py-1.5 font-mono text-[10px] text-white/40"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        </div>
      )}
      {action.state === 'loading' && (
        <div className="flex items-center justify-center gap-1.5 py-1.5 font-mono text-[10px] text-amber-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Running...
        </div>
      )}
      {action.state === 'success' && (
        <div className="flex items-center justify-center gap-1.5 py-1.5 font-mono text-[10px] text-green-400">
          <Check className="w-3.5 h-3.5" /> Done
        </div>
      )}
      {action.state === 'error' && (
        <div className="flex items-center justify-center gap-1.5 py-1.5 font-mono text-[10px] text-red-400">
          <X className="w-3.5 h-3.5" /> {action.error || 'Failed'}
        </div>
      )}
    </div>
  );
}

function MaintenanceSection() {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('dashboard-maintenance') === 'true';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('dashboard-maintenance', String(expanded));
    } catch {}
  }, [expanded]);

  const { data: emailStats } = useQuery({
    queryKey: ['email-security-stats'],
    queryFn: async () => {
      const res = await api.get<EmailSecurityStats>('/api/email-security/stats');
      return res.data ?? null;
    },
  });

  const { data: systemHealth } = useSystemHealth();

  const unlinkedThreats = systemHealth?.threats?.total ?? 0;
  const pendingScans = emailStats?.pending ?? 0;

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden">
      {/* Header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4"
      >
        <div className="flex items-center gap-3">
          <span className="section-label !mb-0">Maintenance Operations</span>
          <span className="flex items-center gap-1 font-mono text-[9px] text-amber-400 uppercase tracking-wider">
            <AlertTriangle className="w-3 h-3" /> Super Admin Only
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-white/50" />
        ) : (
          <ChevronDown className="w-4 h-4 text-white/50" />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {OPERATIONS.map((op) => (
              <OperationCard key={op.label} op={op} />
            ))}
          </div>

          <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />

          {/* Stats bar */}
          <div className="flex items-center gap-4 font-mono text-[10px] text-white/40">
            <span>Unlinked threats: <strong className="text-white/95">{fmt(unlinkedThreats)}</strong></span>
            <span>&middot;</span>
            <span>Pending email scans: <strong className="text-white/95">{fmt(pendingScans)}</strong></span>
          </div>
        </div>
      )}
    </div>
  );
}

export function AdminDashboard() {
  const { data, isLoading, isError } = useSystemHealth();

  const [classifying, setClassifying] = useState(false);
  const [classifyResult, setClassifyResult] = useState<string | null>(null);

  async function handleClassifySaasTechniques() {
    setClassifying(true);
    setClassifyResult(null);
    let total = 0;
    try {
      while (true) {
        const res = await api.post<{
          processed: number;
          classified: number;
          remaining: number;
        }>('/api/admin/backfill-saas-techniques');
        total += res.data?.classified ?? 0;
        if ((res.data?.processed ?? 0) < 5000 || (res.data?.remaining ?? 0) === 0) break;
        await new Promise(r => setTimeout(r, 300));
      }
      setClassifyResult(`${total.toLocaleString()} threats classified`);
    } catch {
      setClassifyResult('Failed — check console');
    } finally {
      setClassifying(false);
    }
  }

  if (isLoading) return <PageLoader />;

  const threats = data?.threats ?? { total: 0, today: 0, week: 0 };
  const agents = data?.agents ?? { total: 0, successes: 0, errors: 0 };
  const feeds = data?.feeds ?? { pulls: 0, ingested: 0 };
  const sessions = data?.sessions ?? { count: 0 };
  const migrations = data?.migrations ?? { total: 0, last_run: null, last_name: null };
  const audit = data?.audit ?? { count: 0 };
  const trend = Array.isArray(data?.trend) ? data.trend : [];
  const infra = data?.infrastructure ?? {
    mainDb: { name: 'trust-radar-v2', sizeMb: 79.5, tables: 57, region: 'ENAM' },
    auditDb: { name: 'trust-radar-v2-audit', sizeKb: 180, tables: 2, region: 'ENAM' },
    worker: { name: 'trust-radar', platform: 'Cloudflare Workers' },
    kvNamespaces: [{ name: 'trust-radar-cache' }, { name: 'SESSIONS' }, { name: 'CACHE' }],
  };

  const successRate = agents.total > 0 ? Math.round((agents.successes / agents.total) * 100) : 100;
  const isHealthy = agents.errors === 0;
  const trendTotal = trend.reduce((s, t) => s + t.count, 0);
  const trendAvg = trend.length > 0 ? Math.round(trendTotal / trend.length) : 0;
  const trendPeak = trend.reduce((max, t) => t.count > max.count ? t : max, { day: '', count: 0 });

  const chartData = trend.map((t) => ({
    date: shortDate(t.day),
    threats: t.count,
  }));

  const dbSizePercent = Math.min((infra.mainDb.sizeMb / 500) * 100, 100);

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader
        title="Admin Dashboard"
        subtitle="Platform health and operations"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              System Health
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                padding: '3px 8px',
                borderRadius: 4,
                border: `1px solid ${agents.errors > 0 ? 'var(--sev-high)' : 'var(--green)'}`,
                color: agents.errors > 0 ? 'var(--sev-high)' : 'var(--green)',
                background: agents.errors > 0 ? 'rgba(251,146,60,0.1)' : 'rgba(60,184,120,0.1)',
              }}
            >
              {agents.errors > 0 ? 'DEGRADED' : 'OPERATIONAL'}
            </span>
          </div>
        }
      />

      {/* ── DAILY BRIEFING WIDGET ─────────────────── */}
      <DailyBriefingWidget />

      {/* ── ADMIN ACTIONS ─────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleClassifySaasTechniques}
          disabled={classifying}
          loading={classifying}
        >
          {classifying ? 'Classifying...' : 'Classify SaaS Techniques'}
        </Button>
        {classifyResult && (
          <span style={{
            fontSize: 11,
            color: 'var(--sev-info)',
            fontFamily: 'var(--font-mono)',
            marginLeft: 8,
          }}>
            ✓ {classifyResult}
          </span>
        )}
      </div>

      {/* ── TOP STAT ROW ────────────────────────── */}
      <StatGrid cols={4}>
        <StatCard label="Threats Today" value={fmt(threats.today)} accentColor="var(--red)" sublabel={`${fmt(threats.total)} total`} />
        <StatCard label="Feed Ingestion" value={fmt(feeds.ingested)} accentColor="var(--amber)" sublabel="records (24h)" />
        <StatCard label="Agent Runs" value={fmt(agents.total)} accentColor="var(--blue)" sublabel={`${fmt(agents.successes)} success / ${agents.errors} errors`} />
        <StatCard label="Active Sessions" value={fmt(sessions.count)} accentColor="var(--green)" sublabel="authenticated" />
      </StatGrid>

      {/* ── THREE-COLUMN LAYOUT ─────────────────── */}
      <div className="flex flex-col lg:grid lg:grid-cols-3 gap-6">
        {/* LEFT — Infrastructure */}
        <div className="space-y-4">
          <SectionLabel>Infrastructure</SectionLabel>

          {/* Database */}
          <div className="rounded-xl border border-white/10 p-4 space-y-4">
            <div className="section-label">Database</div>

            {/* Main DB */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-mono text-[11px] font-semibold text-white/95">{infra.mainDb.name}</span>
                <Badge status="active" label="PRIMARY" size="xs" />
              </div>
              <div className="progress-bar-track h-2 mb-1.5">
                <div className="progress-bar-fill-teal" style={{ width: `${dbSizePercent}%` }} />
              </div>
              <div className="font-mono text-[10px] text-white/40">{infra.mainDb.sizeMb} MB</div>
              <div className="font-mono text-[10px] text-white/55 mt-0.5">
                {infra.mainDb.tables} tables &middot; {migrations.total} migrations
              </div>
              <div className="font-mono text-[10px] text-white/55">
                Region: {infra.mainDb.region} &middot; Created Mar 13
              </div>
              {migrations.last_run && (
                <div className="font-mono text-[10px] text-white/55">
                  Last migration: {shortDate(migrations.last_run)}
                </div>
              )}
            </div>

            <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />

            {/* Audit DB */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[11px] font-semibold text-white/95">{infra.auditDb.name}</span>
                <Badge status="inactive" label="AUDIT" size="xs" />
              </div>
              <div className="font-mono text-[10px] text-white/55">
                {infra.auditDb.sizeKb} KB &middot; {infra.auditDb.tables} tables &middot; {infra.auditDb.region}
              </div>
            </div>
          </div>

          {/* Worker */}
          <div className="rounded-xl border border-white/10 p-4">
            <div className="section-label mb-3">Worker</div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="dot-pulse-green" />
                <span className="font-mono text-[11px] font-semibold text-white/95">{infra.worker.name}</span>
              </div>
              <Badge status="active" label="ACTIVE" size="xs" />
            </div>
            <div className="font-mono text-[10px] text-white/55 mt-1.5">{infra.worker.platform}</div>
            <div className="font-mono text-[10px] text-white/50 mt-0.5">ID: 5a136591...</div>
            <div className="font-mono text-[10px] text-white/55 mt-0.5">Region: ENAM</div>
          </div>

          {/* KV Namespaces */}
          <div className="rounded-xl border border-white/10 p-4">
            <div className="section-label mb-3">KV Namespaces ({infra.kvNamespaces.length})</div>
            <div className="space-y-2">
              {infra.kvNamespaces.map((kv) => (
                <div key={kv.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="dot-pulse-green" />
                    <span className="font-mono text-[11px] text-white/95">{kv.name}</span>
                  </div>
                  <Badge status="active" label="ACTIVE" size="xs" />
                </div>
              ))}
              <div className="font-mono text-[10px] text-white/55 mt-1 ml-5">
                {fmt(sessions.count)} active sessions
              </div>
            </div>
          </div>
        </div>

        {/* CENTER — Activity */}
        <div className="space-y-4">
          <SectionLabel>Activity</SectionLabel>

          {/* Threat Ingestion Chart */}
          <div className="rounded-xl border border-white/10 p-4">
            <div className="section-label mb-3">Threat Ingestion (14D)</div>
            <div className="h-[180px]">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                    <defs>
                      <linearGradient id="tealGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#00D4FF" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#00D4FF" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      tick={{ fill: 'rgba(120,160,200,0.4)', fontSize: 9, fontFamily: 'IBM Plex Mono' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: 'rgba(120,160,200,0.3)', fontSize: 9, fontFamily: 'IBM Plex Mono' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="threats"
                      stroke="#00D4FF"
                      strokeWidth={2}
                      fill="url(#tealGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <span className="font-mono text-[11px] text-white/40">No trend data</span>
                </div>
              )}
            </div>
            <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />
            <div className="flex items-center justify-between font-mono text-[10px] text-white/40">
              <span>Total: {fmt(trendTotal)}</span>
              <span>Avg/day: {fmt(trendAvg)}</span>
              {trendPeak.day && <span>Peak: {shortDate(trendPeak.day)}</span>}
            </div>
          </div>

          {/* Agent Performance */}
          <div className="rounded-xl border border-white/10 p-4">
            <div className="section-label mb-3">Agent Performance (24H)</div>
            <div className="flex gap-4 mb-3">
              <div>
                <div className="font-display text-lg font-bold text-white/95">{fmt(agents.total)}</div>
                <div className="font-mono text-[9px] text-white/55 uppercase">Runs</div>
              </div>
              <div>
                <div className="font-display text-lg font-bold text-white/95">{fmt(agents.successes)}</div>
                <div className="font-mono text-[9px] text-white/55 uppercase">Success</div>
              </div>
              <div>
                <div className={`font-display text-lg font-bold ${agents.errors > 0 ? 'text-accent' : 'text-white/95'}`}>
                  {agents.errors}
                </div>
                <div className="font-mono text-[9px] text-white/55 uppercase">Errors</div>
              </div>
            </div>
            <div className="progress-bar-track h-2 mb-1.5">
              <div
                className={successRate >= 90 ? 'progress-bar-fill-teal' : successRate >= 50 ? 'progress-bar-fill-amber' : 'progress-bar-fill-red'}
                style={{ width: `${successRate}%` }}
              />
            </div>
            <div className="font-mono text-[10px] text-white/40 mb-3">{successRate}% success rate</div>
            <hr style={{ border: 'none', height: 1, background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.2), transparent)', margin: '12px 0' }} />
            <div className="font-mono text-[10px] text-white/40 mt-2">
              {fmt(feeds.pulls)} feed pulls &middot; {fmt(feeds.ingested)} ingested
            </div>
          </div>
        </div>

        {/* RIGHT — Security & Compliance */}
        <div className="space-y-4">
          <SectionLabel>Security &amp; Compliance</SectionLabel>

          {/* AI Budget */}
          <BudgetPanel />

          {/* Sessions */}
          <div className="rounded-xl border border-white/10 p-4">
            <div className="section-label mb-3">Sessions</div>
            <div className="font-display text-2xl font-bold text-white/95 mb-1">{fmt(sessions.count)}</div>
            <div className="font-mono text-[10px] text-white/55 mb-3">active sessions &middot; 1 total user</div>
            <Link
              to="/profile"
              className="font-mono text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
            >
              Revoke all sessions &rarr;
            </Link>
          </div>

          {/* Compliance */}
          <div className="rounded-xl border border-white/10 p-4">
            <div className="section-label mb-3">Compliance</div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-positive">&#10003;</span>
                <span className="text-white/80">Data residency: ENAM</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-positive">&#10003;</span>
                <span className="text-white/80">Audit logging: Active</span>
              </div>
              <div className="font-mono text-[10px] text-white/55 ml-5">
                {fmt(audit.count)} events recorded
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-positive">&#10003;</span>
                <span className="text-white/80">Encryption at rest: D1 managed</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-positive">&#10003;</span>
                <span className="text-white/80">TLS: Cloudflare managed</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-positive">&#10003;</span>
                <span className="text-white/80">Auth: Google OAuth</span>
              </div>
            </div>
            <div className="mt-3">
              <Link
                to="/admin/audit"
                className="font-mono text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
              >
                View Audit Log &rarr;
              </Link>
            </div>
          </div>

          {/* Migrations */}
          <div className="rounded-xl border border-white/10 p-4">
            <div className="section-label mb-3">Migrations</div>
            <div className="font-display text-lg font-bold text-white/95">{migrations.total}</div>
            <div className="font-mono text-[10px] text-white/55 mt-0.5">migrations run</div>
            {migrations.last_run && (
              <div className="font-mono text-[10px] text-white/55 mt-1.5">
                Last: {shortDate(migrations.last_run)}
              </div>
            )}
            {migrations.last_name && (
              <div className="font-mono text-[10px] text-white/50 mt-0.5 truncate">
                {migrations.last_name}
              </div>
            )}
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-positive font-mono text-[11px]">&#10003;</span>
              <span className="font-mono text-[10px] text-white/70">Up to date</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── EMAIL SECURITY COVERAGE ────────────────── */}
      <EmailSecuritySection />

      {/* ── MAINTENANCE OPERATIONS ─────────────────── */}
      <MaintenanceSection />
    </div>
  );
}
