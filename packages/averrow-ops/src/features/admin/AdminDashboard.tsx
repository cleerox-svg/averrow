import { useState, useEffect, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  Mail, Rss, Download, Brain, Zap, AlertTriangle, Loader2, Check, X,
  ChevronDown, ChevronUp, BellRing, Activity, Database, Cpu, Shield, DollarSign,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useBudgetConfigMutation } from '@/hooks/useBudget';
import type { BudgetStatus } from '@/hooks/useBudget';
import { useDashboardSnapshot } from '@/hooks/useDashboardSnapshot';
import { useAdminAction } from '@/hooks/useAdminAction';
import { usePushConfig } from '@/hooks/usePushAdmin';
import { api } from '@/lib/api';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge, Button, Card, PageHeader, StatGrid, StatCard } from '@/design-system/components';
import { DailyBriefingWidget } from '@/components/DailyBriefingWidget';
import { VerdictBand } from './components/VerdictBand';

/* ─── Style tokens (resolved once, reused below) ───────────────────────── */

const textPrimary: CSSProperties = { color: 'var(--text-primary)' };
const textSecondary: CSSProperties = { color: 'var(--text-secondary)' };
const textTertiary: CSSProperties = { color: 'var(--text-tertiary)' };
const textMuted: CSSProperties = { color: 'var(--text-muted)' };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };

const sectionEyebrow: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

const dividerLine: CSSProperties = {
  border: 'none',
  height: 1,
  background: 'linear-gradient(90deg, transparent, rgba(229,168,50,0.18), transparent)',
  margin: '14px 0',
};

/* ─── Small helpers ────────────────────────────────────────────────────── */

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
    <div
      className="rounded-lg border px-3 py-2 backdrop-blur-sm"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
    >
      <div style={{ ...mono, fontSize: 10, ...textTertiary }}>{label}</div>
      <div style={{ ...mono, fontSize: 13, fontWeight: 700, ...textPrimary }}>{fmt(payload[0].value)} threats</div>
    </div>
  );
}

/* ─── Card eyebrow ─────────────────────────────────────────────────────── */

function CardEyebrow({ icon: Icon, label, right }: { icon?: LucideIcon; label: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {Icon && <Icon size={12} style={{ color: 'var(--amber)' }} />}
        <div style={sectionEyebrow}>{label}</div>
      </div>
      {right}
    </div>
  );
}

/* ─── Budget panel — tighter, no endless agent list ────────────────────── */

function throttleColorVar(level: BudgetStatus['throttle_level']): string {
  switch (level) {
    case 'emergency': return 'var(--red)';
    case 'hard':      return 'var(--sev-high)';
    case 'soft':      return 'var(--sev-medium)';
    default:          return 'var(--green)';
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
  // Tier 2a: reads the `budget` slice off the shared dashboard snapshot
  // instead of a standalone budget-status/breakdown fetch (the old
  // useBudgetStatus/useBudgetBreakdown hooks had no other consumers and
  // were removed — see useBudget.ts). Because useDashboardSnapshot shares
  // one TanStack Query cache entry with VerdictBand (and AdminDashboard
  // itself), mounting all three together still costs a single network
  // request, not three.
  const { data: snapshot } = useDashboardSnapshot();
  const budgetSlice = snapshot?.budget;
  const mutation = useBudgetConfigMutation();
  const [editing, setEditing] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const [showAll, setShowAll] = useState(false);

  if (!budgetSlice) return null;
  const budget = budgetSlice.status;

  const barPct = Math.min(budget.pct_used, 100);
  const accent = throttleColorVar(budget.throttle_level);
  // Server-capped to the top 8 spenders (handleAdminDashboard) — the
  // showAll/top-5 toggle below still makes sense at that size.
  const breakdownItems = budgetSlice.top_agents ?? [];
  const visibleItems = showAll ? breakdownItems : breakdownItems.slice(0, 5);

  return (
    <Card padding="20px">
      <CardEyebrow icon={DollarSign} label="AI Budget" right={<ThrottleBadge level={budget.throttle_level} />} />

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, color: accent, lineHeight: 1, letterSpacing: -0.5 }}>
          ${budget.spent_this_month.toFixed(2)}
        </span>
        <span style={{ ...mono, fontSize: 11, ...textTertiary }}>
          of ${budget.config.monthly_limit_usd.toFixed(2)}
        </span>
      </div>

      <div
        style={{
          height: 6, borderRadius: 999, overflow: 'hidden',
          background: 'rgba(255,255,255,0.06)', marginBottom: 6,
        }}
      >
        <div
          style={{
            height: '100%', width: `${barPct}%`,
            background: `linear-gradient(90deg, ${accent}80, ${accent})`,
            boxShadow: `0 0 12px ${accent}60`,
            transition: 'width 300ms ease',
          }}
        />
      </div>
      <div style={{ ...mono, fontSize: 11, ...textSecondary, marginBottom: 16 }}>
        {budget.pct_used.toFixed(1)}% used
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, ...mono, fontSize: 11 }}>
        <KvRow label="Remaining" value={`$${budget.remaining.toFixed(2)}`} />
        <KvRow label="Daily burn" value={`$${budget.daily_burn_rate.toFixed(2)}/day`} />
        <KvRow
          label="Projected"
          value={`$${budget.projected_monthly.toFixed(2)}`}
          danger={budget.projected_monthly > budget.config.monthly_limit_usd}
        />
        <KvRow label="Days left" value={String(budget.days_in_month - budget.days_elapsed)} />
      </div>

      {breakdownItems.length > 0 && (
        <>
          <hr style={dividerLine} />
          <div style={sectionEyebrow}>Spend by Agent</div>
          <div style={{ marginTop: 8 }}>
            {visibleItems.map((a) => (
              <div
                key={a.agent_id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: '1px solid var(--border-base)', ...mono, fontSize: 11,
                }}
              >
                <span style={textPrimary}>{a.agent_id}</span>
                <span style={textSecondary}>
                  ${a.cost_usd.toFixed(3)} <span style={textMuted}>({a.calls})</span>
                </span>
              </div>
            ))}
          </div>
          {breakdownItems.length > 5 && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              style={{
                marginTop: 8, ...mono, fontSize: 11, fontWeight: 600,
                color: 'var(--amber)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              {showAll ? 'Show top 5 only' : `Show all ${breakdownItems.length} agents`}
            </button>
          )}
        </>
      )}

      <hr style={dividerLine} />
      {!editing ? (
        <button
          type="button"
          onClick={() => { setEditing(true); setLimitInput(String(budget.config.monthly_limit_usd)); }}
          style={{
            ...mono, fontSize: 11, fontWeight: 600,
            color: 'var(--amber)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          }}
        >
          Edit monthly limit →
        </button>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...mono, fontSize: 11, ...textTertiary }}>$</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={limitInput}
            onChange={(e) => setLimitInput(e.target.value)}
            style={{
              width: 80, padding: '4px 8px', border: '1px solid var(--border-strong)',
              borderRadius: 6, ...mono, fontSize: 12, ...textPrimary,
              background: 'var(--bg-elevated)', outline: 'none',
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const val = parseFloat(limitInput);
              if (!isNaN(val) && val >= 0) mutation.mutate({ monthly_limit_usd: val });
              setEditing(false);
            }}
          >
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      )}
    </Card>
  );
}

function KvRow({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <div style={{ ...textTertiary, marginBottom: 2 }}>{label}</div>
      <div style={{ color: danger ? 'var(--red)' : 'var(--text-primary)', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

/* ─── Email Security Section ──────────────────────────────────────────── */

const GRADE_COLORS: Record<string, string> = {
  'A+': '#4ade80',
  'A':  '#2dd4bf',
  'B':  '#5eadb0',
  'C':  '#fbbf24',
  'D':  '#fb923c',
  'F':  '#f87171',
};

function EmailSecuritySection() {
  // Tier 2a fix pass: reads the `email_security` slice off the shared
  // dashboard snapshot instead of its own useQuery(['email-security-stats'])
  // — the slice already covers everything this section renders, so this
  // drops a request from the /admin landing rather than duplicating one
  // the snapshot already fetches. Shares the same query cache entry as
  // VerdictBand/BudgetPanel/MaintenanceSection via useDashboardSnapshot.
  const { data: snapshot } = useDashboardSnapshot();
  const emailSecurity = snapshot?.email_security;

  const scanAction = useAdminAction('/api/email-security/scan-all');

  const scanned = emailSecurity?.total_scanned ?? 0;
  const pending = emailSecurity?.total_unscanned ?? 0;
  const avgScore = emailSecurity?.average_score ?? 0;
  const total = scanned + pending;
  const grades = emailSecurity?.grade_distribution ?? [];
  const coveragePct = total > 0 ? (scanned / total) * 100 : 0;
  const maxGradeCount = Math.max(...grades.map((g) => g.count ?? 0), 1);

  return (
    <Card padding="20px">
      <CardEyebrow
        icon={Mail}
        label="Email Security Coverage"
        right={
          <>
            {scanAction.state === 'idle' && (
              <Button variant="ghost" size="sm" onClick={scanAction.confirm}>
                Scan all brands →
              </Button>
            )}
            {scanAction.state === 'confirming' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...mono, fontSize: 11, color: 'var(--amber)' }}>Scan all pending?</span>
                <Button variant="ghost" size="sm" onClick={scanAction.execute}>
                  <Check size={12} /> Confirm
                </Button>
                <Button variant="ghost" size="sm" onClick={scanAction.cancel}>
                  <X size={12} /> Cancel
                </Button>
              </div>
            )}
            {scanAction.state === 'loading' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 11, color: 'var(--amber)' }}>
                <Loader2 size={12} className="animate-spin" /> Scanning...
              </span>
            )}
            {scanAction.state === 'success' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 11, color: 'var(--green)' }}>
                <Check size={12} /> Queued for {pending} brands
              </span>
            )}
            {scanAction.state === 'error' && (
              <span style={{ ...mono, fontSize: 11, color: 'var(--red)' }}>{scanAction.error}</span>
            )}
          </>
        }
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 18, marginBottom: 18 }}>
        <Metric value={fmt(scanned)} label="scanned" />
        <Metric value={fmt(pending)} label="pending" />
        <Metric value={`${avgScore}/100`} label="avg score" />
      </div>

      {grades.length > 0 && (
        <>
          <div style={sectionEyebrow}>Grade Distribution</div>
          <div style={{
            display: 'grid', gap: 12, marginTop: 10,
            gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))',
          }}>
            {grades.map((g) => {
              const color = GRADE_COLORS[g.grade] ?? '#78A0C8';
              const barWidth = Math.max((g.count / maxGradeCount) * 100, 4);
              const isF = g.grade === 'F';
              return (
                <div key={g.grade}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{
                      ...mono, fontSize: 13, fontWeight: 700, color,
                      textShadow: isF ? '0 0 16px rgba(248,113,113,0.6)' : undefined,
                    }}>
                      {g.grade}
                    </span>
                    <span style={{ ...mono, fontSize: 12, fontWeight: isF ? 700 : 500, color: isF ? color : 'var(--text-primary)' }}>
                      {fmt(g.count)}
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${barWidth}%`, background: color, transition: 'width 300ms' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <hr style={dividerLine} />

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={sectionEyebrow}>Scan Coverage</span>
        <span style={{ ...mono, fontSize: 11, ...textSecondary }}>
          {coveragePct.toFixed(1)}% &middot; {fmt(scanned)} / {fmt(total)}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%', width: `${Math.min(coveragePct, 100)}%`,
            background: 'linear-gradient(90deg, var(--amber-dim), var(--amber))',
            transition: 'width 300ms',
          }}
        />
      </div>
    </Card>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <span style={{ ...mono, fontSize: 18, fontWeight: 700, ...textPrimary, marginRight: 6 }}>{value}</span>
      <span style={{ ...mono, fontSize: 11, ...textTertiary, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        {label}
      </span>
    </div>
  );
}

/* ─── Maintenance Operations (collapsible) ─────────────────────────────── */

interface OperationConfig {
  label: string;
  icon: LucideIcon;
  badge: string;
  confirmText: string;
  endpoint: string;
}

const OPERATIONS: OperationConfig[] = [
  {
    label: 'Force Feed Pull',
    icon: Rss,
    badge: 'Trigger all active feeds now',
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
    label: 'Run 10× Feeds',
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
    <Card padding="16px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Icon size={14} style={{ color: 'var(--amber)' }} />
        <span style={{ ...mono, fontSize: 12, fontWeight: 700, ...textPrimary }}>{op.label}</span>
      </div>
      <div style={{ ...mono, fontSize: 11, ...textTertiary, marginBottom: 12 }}>{op.badge}</div>

      {action.state === 'idle' && (
        <Button variant="secondary" size="sm" onClick={action.confirm}>
          Run
        </Button>
      )}
      {action.state === 'confirming' && (
        <div>
          <div style={{ ...mono, fontSize: 11, color: 'var(--amber)', marginBottom: 8, lineHeight: 1.5 }}>
            {op.confirmText}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button variant="primary" size="sm" onClick={action.execute}>
              <Check size={12} /> Confirm
            </Button>
            <Button variant="ghost" size="sm" onClick={action.cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {action.state === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 11, color: 'var(--amber)' }}>
          <Loader2 size={12} className="animate-spin" /> Running…
        </div>
      )}
      {action.state === 'success' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 11, color: 'var(--green)' }}>
          <Check size={12} /> Done
        </div>
      )}
      {action.state === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono, fontSize: 11, color: 'var(--red)' }}>
          <X size={12} /> {action.error || 'Failed'}
        </div>
      )}
    </Card>
  );
}

function MaintenanceSection() {
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem('dashboard-maintenance') === 'true'; }
    catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem('dashboard-maintenance', String(expanded)); }
    catch { /* noop */ }
  }, [expanded]);

  // Same rationale as EmailSecuritySection above — reuse the snapshot's
  // `email_security` slice instead of a second independent
  // ['email-security-stats'] fetch (this was the OTHER consumer of that
  // query; without this the "drops one request" win above wouldn't
  // materialize, since this hook would still keep it alive).
  const { data: snapshot } = useDashboardSnapshot();
  const { data: systemHealth } = useSystemHealth();
  const unlinkedThreats = systemHealth?.threats?.total ?? 0;
  const pendingScans = snapshot?.email_security?.total_unscanned ?? 0;

  return (
    <Card padding={0}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Cpu size={14} style={{ color: 'var(--amber)' }} />
            <div style={sectionEyebrow}>Maintenance Operations</div>
          </div>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, ...mono, fontSize: 10, color: 'var(--amber)', letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            <AlertTriangle size={11} /> Super Admin
          </span>
        </div>
        {expanded
          ? <ChevronUp size={16} style={{ color: 'var(--text-secondary)' }} />
          : <ChevronDown size={16} style={{ color: 'var(--text-secondary)' }} />}
      </button>

      {expanded && (
        <div style={{ padding: '0 20px 20px' }}>
          <div style={{
            display: 'grid', gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          }}>
            {OPERATIONS.map((op) => <OperationCard key={op.label} op={op} />)}
          </div>
          <hr style={dividerLine} />
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 16, ...mono, fontSize: 11, ...textTertiary }}>
            <span>Unlinked threats: <strong style={textPrimary}>{fmt(unlinkedThreats)}</strong></span>
            <span style={textMuted}>·</span>
            <span>Pending email scans: <strong style={textPrimary}>{fmt(pendingScans)}</strong></span>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ─── Push bootstrap nudge ─────────────────────────────────────────────── */

function PushBootstrapCard() {
  const navigate = useNavigate();
  const { data: config, isLoading } = usePushConfig();
  if (isLoading || !config) return null;
  const fullyConfigured = config.push_enabled
    && config.vapid_public_key.length > 0
    && config.vapid_private_key_configured;

  // Discoverability (GM7): once configured, the bootstrap nudge used to vanish,
  // leaving /admin/push (off-nav by design) unreachable. Keep a compact
  // "configured" row with a Manage link so operators can still get back to it.
  if (fullyConfigured) {
    return (
      <Card variant="elevated" padding="12px 16px">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <BellRing size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
            <span style={{ ...mono, fontSize: 11, ...textTertiary }}>Push notifications · configured</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate('/admin/push')}>
            Manage
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card variant="elevated" padding="16px">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div
            style={{
              flexShrink: 0, width: 36, height: 36, borderRadius: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--amber-glow)', color: 'var(--amber)',
            }}
          >
            <BellRing size={16} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, ...textPrimary }}>Push notifications not configured</div>
            <div style={{ ...mono, fontSize: 11, marginTop: 2, ...textTertiary }}>
              {!config.vapid_public_key
                ? 'Generate a VAPID keypair to enable web push.'
                : !config.vapid_private_key_configured
                  ? 'Private key not set as Worker secret. Run wrangler secret put.'
                  : 'Enable push in the bootstrap panel to start delivering to subscribed devices.'}
            </div>
          </div>
        </div>
        <Button variant="primary" size="sm" onClick={() => navigate('/admin/push')}>
          Open bootstrap
        </Button>
      </div>
    </Card>
  );
}

/* ─── Main dashboard ───────────────────────────────────────────────────── */

export function AdminDashboard() {
  // P1 fix: this dashboard used to gate its ENTIRE return on
  // useSystemHealth().isLoading, which meant every other child fetch
  // (budget, push, email, briefing) couldn't fire until system-health
  // returned — a serial waterfall. Now only the pieces that actually need
  // `data` (top StatGrid, 14d Activity section, Compliance & Sessions,
  // Infrastructure tiles) are gated below; everything else (VerdictBand,
  // PushBootstrapCard, DailyBriefingWidget, BudgetPanel,
  // EmailSecuritySection, MaintenanceSection) mounts immediately and
  // null-guards its own data via its own hook.
  //
  // Tier 2a: the top StatGrid + 14d Activity row now read off the
  // dashboard snapshot's `threat_health` slice instead of a dedicated
  // useSystemHealth() call — one fewer independent fetch, shared with
  // VerdictBand/BudgetPanel via the same query cache entry.
  // `threat_health` is null for plain admins (RBAC — see
  // handleAdminDashboard) and for any whole-snapshot fetch failure; both
  // read as "unavailable" below, never as fake zeros.
  const { data: snapshot, isLoading: snapshotLoading, isError: snapshotError } = useDashboardSnapshot();
  const threatHealth = snapshot?.threat_health ?? null;
  const healthReady = !snapshotLoading && !snapshotError && !!threatHealth;

  // Migrations / audit / infrastructure are NOT part of the snapshot
  // contract (DashboardThreatHealthSlice only carries threats/agents_24h/
  // feeds_24h/active_sessions/trend_14d — see useDashboardSnapshot.ts), so
  // Compliance & Sessions and Infrastructure below stay on the full
  // system-health endpoint, independently gated.
  const { data: systemHealth, isLoading: systemHealthLoading, isError: systemHealthError } = useSystemHealth();
  const systemHealthReady = !systemHealthLoading && !systemHealthError && !!systemHealth;

  const [classifying, setClassifying] = useState(false);
  const [classifyResult, setClassifyResult] = useState<string | null>(null);

  // VerdictBand's "AI budget" contributor deep-links to #budget-panel.
  // React Router's <Link> intercepts the click and pushState()s instead of
  // letting the browser do its native hash-scroll. VerdictBand renders at
  // the top of THIS SAME page, so the common case is a same-page click —
  // the route doesn't remount, only the hash changes — which a mount-only
  // effect ([]) would miss entirely. Depend on `location.hash` (from
  // react-router, which re-renders on every hash-only navigation, unlike
  // the native `hashchange` event which pushState() doesn't fire) so this
  // re-runs on both fresh arrival AND same-page clicks.
  const location = useLocation();
  useEffect(() => {
    if (location.hash === '#budget-panel') {
      document.getElementById('budget-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.hash]);

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

  // threat_health-derived — drives the top StatGrid + 14d Activity row,
  // gated by `healthReady` above.
  const threats = threatHealth?.threats ?? { total: 0, today: 0, week: 0 };
  const agents = threatHealth?.agents_24h ?? { total: 0, successes: 0, errors: 0 };
  const feeds = threatHealth?.feeds_24h ?? { pulls: 0, ingested: 0 };
  const activeSessions = threatHealth?.active_sessions ?? 0;
  const trend = Array.isArray(threatHealth?.trend_14d) ? threatHealth.trend_14d : [];

  // Full system-health-derived — drives Compliance & Sessions and
  // Infrastructure, gated by `systemHealthReady` above (not covered by the
  // snapshot contract).
  const migrations = systemHealth?.migrations ?? { total: 0, last_run: null, last_name: null };
  const audit = systemHealth?.audit ?? { count: 0 };
  const sessions = systemHealth?.sessions ?? { count: 0 };
  const infra = systemHealth?.infrastructure ?? {
    mainDb: { name: 'trust-radar-v2', sizeMb: 79.5, tables: 57, region: 'ENAM' },
    auditDb: { name: 'trust-radar-v2-audit', sizeKb: 180, tables: 2, region: 'ENAM' },
    worker: { name: 'trust-radar', platform: 'Cloudflare Workers' },
    kvNamespaces: [{ name: 'trust-radar-cache' }, { name: 'SESSIONS' }, { name: 'CACHE' }],
  };

  const successRate = agents.total > 0 ? Math.round((agents.successes / agents.total) * 100) : 100;
  const trendTotal = trend.reduce((s, t) => s + t.count, 0);
  const trendAvg = trend.length > 0 ? Math.round(trendTotal / trend.length) : 0;
  const trendPeak = trend.reduce((max, t) => (t.count > max.count ? t : max), { day: '', count: 0 });
  const chartData = trend.map((t) => ({ date: shortDate(t.day), threats: t.count }));
  const dbSizePercent = Math.min((infra.mainDb.sizeMb / 500) * 100, 100);

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <PageHeader
        title="Admin Dashboard"
        subtitle="Platform health and operations"
      />

      {/* Single honest health verdict — worst-of across agents, AI budget,
          feeds, and pipelines. Replaces the old agents-errors-only pill. */}
      <VerdictBand />

      <PushBootstrapCard />

      {/* TOP STAT ROW — needs the snapshot's `threat_health` slice, so it's
          gated on `healthReady` (dashboard-snapshot-derived). */}
      {healthReady ? (
        <StatGrid cols={4}>
          <StatCard label="Threats Today" value={fmt(threats.today)} accentColor="var(--red)" sublabel={`${fmt(threats.total)} total`} />
          <StatCard label="Feed Ingestion" value={fmt(feeds.ingested)} accentColor="var(--amber)" sublabel="records (24h)" />
          <StatCard label="Agent Runs" value={fmt(agents.total)} accentColor="var(--blue)" sublabel={`${fmt(agents.successes)} success / ${agents.errors} errors`} />
          <StatCard label="Active Sessions" value={fmt(activeSessions)} accentColor="var(--green)" sublabel="authenticated" />
        </StatGrid>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      )}

      {/* DAILY BRIEFING — its own hook, mounts immediately */}
      <section>
        <SectionLabel label="Daily Briefing" attribution="Generated by the briefing agent" />
        <DailyBriefingWidget />
      </section>

      {/* ACTIVITY ROW — chart spans 2/3, agent perf 1/3. Both derive from
          the snapshot's `threat_health` slice, so both stay gated together
          on `healthReady`. */}
      <section>
        <SectionLabel label="Activity (14d)" />
        {healthReady ? (
        <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>
          <div style={{ gridColumn: 'span 12', minWidth: 0 }} className="lg:col-span-8">
            <Card padding="20px" style={{ height: '100%' }}>
              <CardEyebrow
                icon={Activity}
                label="Threat Ingestion · 14 Days"
                right={
                  <span style={{ ...mono, fontSize: 11, ...textSecondary }}>
                    Total <strong style={textPrimary}>{fmt(trendTotal)}</strong>
                    {' · '}Avg <strong style={textPrimary}>{fmt(trendAvg)}</strong>/day
                    {trendPeak.day && <>{' · '}Peak <strong style={textPrimary}>{shortDate(trendPeak.day)}</strong></>}
                  </span>
                }
              />
              <div style={{ height: 220 }}>
                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                      <defs>
                        <linearGradient id="amberGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--amber)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--amber)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="date"
                        tick={{ fill: 'rgba(255,255,255,0.45)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
                      />
                      <Tooltip content={<CustomTooltip />} />
                      <Area
                        type="monotone"
                        dataKey="threats"
                        stroke="var(--amber)"
                        strokeWidth={2}
                        fill="url(#amberGradient)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', ...mono, fontSize: 12, ...textTertiary }}>
                    No trend data
                  </div>
                )}
              </div>
            </Card>
          </div>

          <div style={{ gridColumn: 'span 12', minWidth: 0 }} className="lg:col-span-4">
            <Card padding="20px" style={{ height: '100%' }}>
              <CardEyebrow icon={Cpu} label="Agent Performance · 24h" />
              <div style={{ display: 'flex', gap: 18, marginBottom: 14 }}>
                <BigStat value={fmt(agents.total)} label="Runs" />
                <BigStat value={fmt(agents.successes)} label="Success" tone="green" />
                <BigStat value={String(agents.errors)} label="Errors" tone={agents.errors > 0 ? 'red' : undefined} />
              </div>
              <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 6 }}>
                <div
                  style={{
                    height: '100%', width: `${successRate}%`,
                    background: successRate >= 90
                      ? 'linear-gradient(90deg, var(--green-dim), var(--green))'
                      : successRate >= 50
                        ? 'linear-gradient(90deg, var(--amber-dim), var(--amber))'
                        : 'linear-gradient(90deg, var(--red-dim), var(--red))',
                    transition: 'width 300ms',
                  }}
                />
              </div>
              <div style={{ ...mono, fontSize: 11, ...textSecondary, marginBottom: 14 }}>
                {successRate}% success rate
              </div>
              <hr style={dividerLine} />
              <div style={{ ...mono, fontSize: 11, ...textTertiary, lineHeight: 1.7 }}>
                <div><strong style={textPrimary}>{fmt(feeds.pulls)}</strong> feed pulls</div>
                <div><strong style={textPrimary}>{fmt(feeds.ingested)}</strong> records ingested</div>
              </div>
            </Card>
          </div>
        </div>
        ) : (
          <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>
            <div style={{ gridColumn: 'span 12', minWidth: 0 }} className="lg:col-span-8">
              <Skeleton className="h-64 rounded-xl" />
            </div>
            <div style={{ gridColumn: 'span 12', minWidth: 0 }} className="lg:col-span-4">
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </div>
        )}
      </section>

      {/* SECURITY ROW — Budget + Compliance. BudgetPanel owns its own
          snapshot read and mounts immediately; Compliance & Sessions needs
          migrations/audit/sessions from the full system-health endpoint
          (not in the snapshot contract), so it's gated on
          `systemHealthReady` instead. */}
      <section>
        <SectionLabel label="Security &amp; Spend" />
        <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' }}>
          <div id="budget-panel" style={{ gridColumn: 'span 12', minWidth: 0 }} className="lg:col-span-5">
            <BudgetPanel />
          </div>
          <div style={{ gridColumn: 'span 12', minWidth: 0 }} className="lg:col-span-7">
            {systemHealthReady ? (
            <Card padding="20px" style={{ height: '100%' }}>
              <CardEyebrow
                icon={Shield}
                label="Compliance & Sessions"
                right={
                  <Link
                    to="/admin/audit"
                    style={{ ...mono, fontSize: 11, fontWeight: 600, color: 'var(--amber)', textDecoration: 'none' }}
                  >
                    Audit Log →
                  </Link>
                }
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
                <ComplianceItem ok label="Data residency: ENAM" />
                <ComplianceItem ok label="Audit logging: Active" sub={`${fmt(audit.count)} events recorded`} />
                <ComplianceItem ok label="Encryption at rest: D1 managed" />
                <ComplianceItem ok label="TLS: Cloudflare managed" />
                <ComplianceItem ok label="Auth: Google OAuth" />
                <ComplianceItem ok label={`${fmt(sessions.count)} active sessions`} sub="1 total user · revoke from profile" />
              </div>
              <hr style={dividerLine} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleClassifySaasTechniques}
                  disabled={classifying}
                  loading={classifying}
                >
                  {classifying ? 'Classifying…' : 'Classify SaaS Techniques'}
                </Button>
                {classifyResult && (
                  <span style={{ ...mono, fontSize: 11, color: 'var(--green)' }}>✓ {classifyResult}</span>
                )}
                <Link
                  to="/profile"
                  style={{ ...mono, fontSize: 11, color: 'var(--amber)', textDecoration: 'none' }}
                >
                  Revoke all sessions →
                </Link>
              </div>
            </Card>
            ) : (
              <Skeleton className="h-64 rounded-xl" />
            )}
          </div>
        </div>
      </section>

      {/* INFRASTRUCTURE — single compact row instead of an endless column.
          Reads `infra`/`migrations` off the full system-health endpoint
          (not in the snapshot contract) — gated on `systemHealthReady`. */}
      <section>
        <SectionLabel label="Infrastructure" />
        {systemHealthReady ? (
        <Card padding="20px">
          <div
            style={{
              display: 'grid', gap: 20,
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            }}
          >
            <InfraTile
              icon={Database}
              title={infra.mainDb.name}
              badge={<Badge status="active" label="PRIMARY" size="xs" />}
              progress={dbSizePercent}
              progressColor="var(--blue)"
              lines={[
                `${infra.mainDb.sizeMb} MB · ${infra.mainDb.tables} tables`,
                `${migrations.total} migrations · ${infra.mainDb.region}`,
                migrations.last_run
                  ? `Last migration: ${shortDate(migrations.last_run)}`
                  : 'Never migrated',
              ]}
            />
            <InfraTile
              icon={Database}
              title={infra.auditDb.name}
              badge={<Badge status="inactive" label="AUDIT" size="xs" />}
              lines={[
                `${infra.auditDb.sizeKb} KB · ${infra.auditDb.tables} tables`,
                `Region: ${infra.auditDb.region}`,
              ]}
            />
            <InfraTile
              icon={Cpu}
              title={infra.worker.name}
              badge={<Badge status="active" label="ACTIVE" size="xs" />}
              lines={[infra.worker.platform, 'Region: ENAM']}
              pulseColor="var(--green)"
            />
            <InfraTile
              icon={Activity}
              title={`KV · ${infra.kvNamespaces.length} namespaces`}
              badge={<Badge status="active" label="ACTIVE" size="xs" />}
              lines={[
                infra.kvNamespaces.map(k => k.name).join(', '),
                `${fmt(sessions.count)} active sessions`,
              ]}
            />
            <InfraTile
              icon={Shield}
              title="Migrations"
              badge={<Badge status="active" label="UP TO DATE" size="xs" />}
              lines={[
                `${migrations.total} migrations run`,
                migrations.last_run ? `Last: ${shortDate(migrations.last_run)}` : 'No prior runs',
                migrations.last_name ?? '—',
              ]}
            />
          </div>
        </Card>
        ) : (
          <Skeleton className="h-40 rounded-xl" />
        )}
      </section>

      {/* EMAIL SECURITY */}
      <EmailSecuritySection />

      {/* MAINTENANCE — collapsible */}
      <MaintenanceSection />
    </div>
  );
}

function BigStat({ value, label, tone }: { value: string; label: string; tone?: 'green' | 'red' }) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'red' ? 'var(--red)' : 'var(--text-primary)';
  return (
    <div>
      <div style={{
        fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, lineHeight: 1, color,
      }}>
        {value}
      </div>
      <div style={{ ...sectionEyebrow, marginTop: 6 }}>{label}</div>
    </div>
  );
}

function InfraTile({
  icon: Icon, title, badge, progress, progressColor, lines, pulseColor,
}: {
  icon: LucideIcon;
  title: string;
  badge?: React.ReactNode;
  progress?: number;
  progressColor?: string;
  lines: (string | null)[];
  pulseColor?: string;
}) {
  return (
    <div style={{
      borderRadius: 10, border: '1px solid var(--border-base)',
      background: 'var(--bg-elevated)', padding: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {pulseColor ? (
            <span style={{
              width: 8, height: 8, borderRadius: 999, background: pulseColor,
              boxShadow: `0 0 10px ${pulseColor}`, flexShrink: 0,
            }} />
          ) : (
            <Icon size={13} style={{ color: 'var(--amber)' }} />
          )}
          <span style={{
            ...mono, fontSize: 12, fontWeight: 700, ...textPrimary,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {title}
          </span>
        </div>
        {badge}
      </div>
      {progress != null && (
        <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.05)', overflow: 'hidden', marginBottom: 8 }}>
          <div style={{
            height: '100%', width: `${progress}%`,
            background: `linear-gradient(90deg, ${progressColor}55, ${progressColor})`,
            transition: 'width 300ms',
          }} />
        </div>
      )}
      <div style={{ ...mono, fontSize: 11, ...textSecondary, lineHeight: 1.6 }}>
        {lines.filter(Boolean).map((line, i) => (
          <div key={i} style={i === 0 ? undefined : textTertiary}>{line}</div>
        ))}
      </div>
    </div>
  );
}

function ComplianceItem({ ok, label, sub }: { ok: boolean; label: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <span style={{
        flexShrink: 0, width: 18, height: 18, borderRadius: 999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
        background: ok ? 'rgba(60,184,120,0.15)' : 'rgba(248,113,113,0.15)',
        color: ok ? 'var(--green)' : 'var(--red)',
        fontSize: 11, fontWeight: 700,
      }}>
        {ok ? '✓' : '!'}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, ...textPrimary }}>{label}</div>
        {sub && <div style={{ ...mono, fontSize: 11, ...textTertiary, marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}
