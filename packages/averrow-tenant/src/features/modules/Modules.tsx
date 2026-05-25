// averrow-tenant — Workspace Overview.
//
// Real overview of the tenant's brand-protection posture, NOT just an
// entitlement-cards page. Calls two endpoints in parallel:
//   - /api/orgs/:orgId/dashboard — total threats / alerts / brand
//     rollups / 7-day trend / recent alerts. The rich data the user
//     expects when they land on /tenant/.
//   - /api/orgs/:orgId/modules — entitlement status + monthly usage,
//     surfaced as a secondary "modules" section below the overview.
//
// Earlier versions of this page rendered only the modules surface,
// which made the homepage look empty even when the org had 15K+
// threats. The dashboard endpoint always returned the right data;
// the page just didn't call it.

import { useTenantModules, MODULE_LABELS, MODULE_DESCRIPTIONS, type ModuleKey, type TenantModuleSurface } from '@/lib/modules';
import { useTenantDashboard, type DashboardBrand, type DashboardRecentAlert, type DashboardTrendPoint } from '@/lib/dashboard';
import { useAuth } from '@/lib/auth';
import { Link } from 'react-router-dom';
import { CheckCircle2, Lock, AlertTriangle, Shield, ShieldAlert, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/cn';

const MODULE_PATHS: Record<ModuleKey, string> = {
  domain:        '/modules/domain',
  social:        '/modules/social',
  app_store:     '/modules/app-store',
  dark_web:      '/modules/dark-web',
  abuse_mailbox: '/modules/abuse-mailbox',
  trademark:     '/modules/trademark',
  threat_actor:  '/modules/threat-actor',
};

export function Modules() {
  const { user, hasOrg, loading: authLoading } = useAuth();
  const modulesQuery = useTenantModules();
  const dashboardQuery = useTenantDashboard();

  if (authLoading) return <Loading />;
  if (!user) return <NotAuthenticated />;
  if (!hasOrg) return <NoOrg />;

  // Either query loading on first paint = full loader. After first
  // render we let each section show its own state so the page doesn't
  // flicker when one query refetches.
  if (modulesQuery.isLoading && dashboardQuery.isLoading) return <Loading />;
  if (modulesQuery.error && !modulesQuery.data) {
    return <ErrorState error={modulesQuery.error.message} />;
  }

  const modulesData = modulesQuery.data;
  const dashboard = dashboardQuery.data;

  if (!modulesData) return null;

  const active = modulesData.modules.filter((m) => m.status === 'active' || m.status === 'trial');
  const locked = modulesData.modules.filter((m) => m.status === 'not_entitled' || m.status === 'suspended');

  return (
    <div className="space-y-8 max-w-6xl">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Workspace overview</h1>
        <p className="mt-1 text-sm text-white/55">
          {user.organization?.name ?? 'Your organization'} — {active.length} module{active.length === 1 ? '' : 's'} active
        </p>
      </header>

      <AuthorizationBadge data={modulesData.takedown_authorization} />

      {/* Headline stats — drives the eye to the real numbers. */}
      {dashboard && (
        <HeadlineStats dashboard={dashboard} />
      )}
      {dashboardQuery.isLoading && !dashboard && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-white/[0.06] bg-bg-card p-4 h-20 animate-pulse" />
          ))}
        </div>
      )}

      {/* Per-brand rollup — what the org cares about most. */}
      {dashboard && dashboard.brands.length > 0 && (
        <BrandRollup brands={dashboard.brands} />
      )}

      {/* Two-column on wide: 7-day trend + recent alerts. */}
      {dashboard && (dashboard.threat_trend.length > 0 || dashboard.recent_alerts.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {dashboard.threat_trend.length > 0 && <ThreatTrend points={dashboard.threat_trend} />}
          {dashboard.recent_alerts.length > 0 && <RecentAlerts alerts={dashboard.recent_alerts} />}
        </div>
      )}

      {/* Modules section — secondary, but still part of the overview. */}
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">Active modules</h2>
        {active.length === 0 ? (
          <div className="rounded-xl border border-white/[0.06] bg-bg-card p-6 text-center">
            <p className="text-white/55 text-sm">No modules active yet.</p>
            <p className="text-white/35 text-xs mt-1">A super-admin needs to activate modules for your organization.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {active.map((m) => (
              <ModuleCard key={m.module_key} module={m} entitled />
            ))}
          </div>
        )}
      </section>

      {locked.length > 0 && (
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">Available to add</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {locked.map((m) => (
              <ModuleCard key={m.module_key} module={m} entitled={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Headline stats ────────────────────────────────────────────

function HeadlineStats({
  dashboard,
}: {
  dashboard: {
    total_brands:               number;
    total_active_threats:       number;
    total_alerts_open:          number;
    total_impersonation_alerts: number;
    avg_exposure_score:         number | null;
  };
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat
        label="Active threats"
        value={dashboard.total_active_threats}
        icon={ShieldAlert}
        tone={dashboard.total_active_threats > 0 ? 'warn' : 'neutral'}
      />
      <Stat
        label="Open signals"
        value={dashboard.total_alerts_open}
        icon={AlertTriangle}
        tone={dashboard.total_alerts_open > 0 ? 'warn' : 'neutral'}
      />
      <Stat
        label="Impersonations"
        value={dashboard.total_impersonation_alerts}
        icon={Shield}
        tone={dashboard.total_impersonation_alerts > 0 ? 'crit' : 'neutral'}
      />
      <Stat
        label="Exposure score"
        value={dashboard.avg_exposure_score ?? '—'}
        suffix={dashboard.avg_exposure_score != null ? '/100' : undefined}
        icon={TrendingUp}
        tone={
          dashboard.avg_exposure_score != null && dashboard.avg_exposure_score >= 70 ? 'crit' :
          dashboard.avg_exposure_score != null && dashboard.avg_exposure_score >= 40 ? 'warn' :
          'neutral'
        }
      />
    </div>
  );
}

function Stat({
  label, value, suffix, icon: Icon, tone,
}: {
  label:  string;
  value:  number | string;
  suffix?: string;
  icon:   typeof Shield;
  tone:   'neutral' | 'warn' | 'crit';
}) {
  const toneCls =
    tone === 'crit' ? 'text-sev-critical' :
    tone === 'warn' ? 'text-amber'        :
                      'text-white/65';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-widest font-mono text-white/40">{label}</span>
        <Icon size={14} className={toneCls} />
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-bold tabular-nums ${toneCls}`}>
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        {suffix && <span className="text-[11px] text-white/40 font-mono">{suffix}</span>}
      </div>
    </div>
  );
}

// ─── Per-brand rollup ──────────────────────────────────────────

function BrandRollup({ brands }: { brands: DashboardBrand[] }) {
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/45 mb-3">
        Brands ({brands.length})
      </h2>
      <div className="rounded-xl border border-white/[0.06] bg-bg-card overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="text-[10px] uppercase tracking-wider font-mono text-white/40 border-b border-white/[0.06]">
            <tr>
              <th className="text-left px-4 py-2.5">Brand</th>
              <th className="text-right px-4 py-2.5">Active threats</th>
              <th className="text-right px-4 py-2.5 hidden md:table-cell">Social profiles</th>
              <th className="text-right px-4 py-2.5 hidden md:table-cell">Impersonations</th>
              <th className="text-right px-4 py-2.5">Exposure</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => (
              <tr key={b.id} className="border-b border-white/[0.03] last:border-b-0 hover:bg-white/[0.02]">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link to={`/threats?brand=${b.id}`} className="font-medium text-white/90 hover:text-amber transition-colors">
                      {b.name}
                    </Link>
                    {b.is_primary === 1 && (
                      <span className="text-[10px] font-mono uppercase tracking-wider text-amber bg-amber/[0.08] border border-amber/[0.25] rounded px-1.5 py-0.5">
                        Primary
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-white/40 mt-0.5">{b.canonical_domain}</div>
                </td>
                <td className="text-right px-4 py-2.5">
                  <Link
                    to={`/threats?brand=${b.id}`}
                    className={`tabular-nums font-mono hover:underline ${b.active_threats > 0 ? 'text-amber' : 'text-white/55'}`}
                  >
                    {b.active_threats.toLocaleString()}
                  </Link>
                </td>
                <td className="text-right px-4 py-2.5 tabular-nums font-mono text-white/55 hidden md:table-cell">
                  {b.social_profiles_count.toLocaleString()}
                </td>
                <td className={`text-right px-4 py-2.5 tabular-nums font-mono hidden md:table-cell ${b.impersonation_count > 0 ? 'text-sev-critical' : 'text-white/55'}`}>
                  {b.impersonation_count.toLocaleString()}
                </td>
                <td className="text-right px-4 py-2.5">
                  <ExposureScore score={b.exposure_score} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ExposureScore({ score }: { score: number | null }) {
  if (score == null) return <span className="text-white/35 font-mono text-[11px]">—</span>;
  const tone =
    score >= 70 ? 'text-sev-critical' :
    score >= 40 ? 'text-amber'        :
                  'text-green';
  return <span className={`tabular-nums font-mono ${tone}`}>{score}</span>;
}

// ─── 7-day trend ───────────────────────────────────────────────

function ThreatTrend({ points }: { points: DashboardTrendPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((s, p) => s + p.count, 0);
  // Percentage heights collapse to 0 here because the column wrapper has no
  // definite height (items-end on the row doesn't stretch children). Size
  // bars in pixels against an explicit max instead.
  const BAR_MAX_PX = 64;

  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-white/90">7-day threat trend</h2>
        <span className="text-[11px] font-mono text-white/45 tabular-nums">{total.toLocaleString()} total</span>
      </div>
      <div className="flex items-end gap-2 h-24">
        {points.map((p) => {
          const h = Math.max(4, Math.round((p.count / max) * BAR_MAX_PX));
          return (
            <div
              key={p.date}
              className="flex-1 flex flex-col items-center gap-1"
              title={`${p.date} — ${p.count} threats`}
            >
              <div className="text-[10px] font-mono text-white/45 tabular-nums">{p.count}</div>
              <div
                className="w-full rounded-sm bg-amber/[0.40] hover:bg-amber/[0.60] transition-colors"
                style={{ height: `${h}px` }}
              />
              <div className="text-[9px] font-mono text-white/35 uppercase tracking-wider">
                {new Date(p.date).toLocaleDateString('en-US', { weekday: 'short' })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Recent alerts ─────────────────────────────────────────────

function RecentAlerts({ alerts }: { alerts: DashboardRecentAlert[] }) {
  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white/90">Recent signals</h2>
        <Link to="/alerts" className="text-[11px] font-mono text-amber hover:underline">View all →</Link>
      </div>
      <div className="space-y-2">
        {alerts.map((a) => {
          const sev = (a.severity ?? '').toLowerCase();
          const sevTone =
            sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.25]' :
            sev === 'high'     ? 'text-amber        bg-amber/[0.10]        border-amber/[0.25]'        :
            sev === 'medium'   ? 'text-amber/70     bg-amber/[0.06]        border-amber/[0.15]'        :
                                 'text-white/55     bg-white/[0.04]        border-white/[0.08]';
          return (
            <div key={a.id} className="flex items-start justify-between gap-3 py-2 px-2 -mx-2 rounded-lg hover:bg-white/[0.02]">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${sevTone}`}>
                    {sev || 'unknown'}
                  </span>
                  <span className="text-[10px] font-mono text-white/40 uppercase tracking-wider">{a.alert_type.replace(/_/g, ' ')}</span>
                </div>
                <p className="text-[12px] text-white/85 truncate">{a.title}</p>
                <p className="text-[11px] text-white/45 font-mono mt-0.5">{a.brand_name}</p>
              </div>
              <div className="text-[10px] font-mono text-white/40 flex-shrink-0">
                {new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Module card (now secondary) ───────────────────────────────

function ModuleCard({ module: m, entitled }: { module: TenantModuleSurface; entitled: boolean }) {
  const totalUsage = m.metrics.reduce((sum, metric) => sum + (metric.value_this_month ?? 0), 0);
  const trial = m.status === 'trial';

  return (
    <Link
      to={MODULE_PATHS[m.module_key]}
      className={cn(
        'block rounded-xl border bg-bg-card p-4 transition-colors',
        entitled
          ? 'border-white/[0.06] hover:border-amber/[0.30]'
          : 'border-white/[0.04] hover:border-white/[0.10] opacity-70',
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <div className="text-sm font-semibold text-white/90">{MODULE_LABELS[m.module_key]}</div>
          <p className="text-[11px] text-white/45 mt-1 leading-relaxed">{MODULE_DESCRIPTIONS[m.module_key]}</p>
        </div>
        {entitled ? (
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-mono text-amber">
            <CheckCircle2 size={11} />
            {trial ? 'Trial' : 'Active'}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-mono text-white/35">
            <Lock size={11} />
            Locked
          </span>
        )}
      </div>

      {entitled && m.metrics.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/[0.04]">
          <div className="text-[9px] uppercase tracking-widest font-mono text-white/35 mb-1">This month</div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white/90 tabular-nums">{totalUsage}</span>
            <span className="text-[10px] text-white/45">across {m.metrics.length} metric{m.metrics.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      )}
    </Link>
  );
}

function AuthorizationBadge({ data }: { data: { signed: boolean; modules_covered?: ModuleKey[] | undefined } }) {
  if (data.signed) {
    return (
      <div className="rounded-xl border border-green/[0.20] bg-green/[0.06] p-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-white/90">Takedown authorization signed</div>
          <p className="text-[11px] text-white/55 mt-0.5">
            Coverage: {data.modules_covered?.length ?? 0} module{(data.modules_covered?.length ?? 0) === 1 ? '' : 's'}.
            Automated takedowns are running on your behalf within scope.
          </p>
        </div>
        <Link to="/settings/takedown-authorization" className="text-[11px] font-mono text-amber hover:underline">
          Manage →
        </Link>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber/[0.30] bg-amber/[0.06] p-4 flex items-center justify-between">
      <div>
        <div className="text-sm font-semibold text-white/90">Sign your takedown authorization</div>
        <p className="text-[11px] text-white/55 mt-0.5">
          Without your signed authorization, takedowns can be detected but not submitted automatically.
        </p>
      </div>
      <Link to="/settings/takedown-authorization" className="text-[11px] font-mono text-amber hover:underline">
        Sign →
      </Link>
    </div>
  );
}

function Loading() {
  return <div className="text-white/40 text-sm font-mono py-12 text-center">Loading…</div>;
}

function NotAuthenticated() {
  return (
    <div className="max-w-md mx-auto py-16 text-center">
      <h1 className="text-xl font-semibold text-white mb-2">Sign in required</h1>
      <p className="text-sm text-white/55">
        Your session has expired. <a href="/v2/login" className="text-amber hover:underline">Sign in to continue</a>.
      </p>
    </div>
  );
}

function NoOrg() {
  return (
    <div className="max-w-md mx-auto py-16 text-center">
      <h1 className="text-xl font-semibold text-white mb-2">No organization yet</h1>
      <p className="text-sm text-white/55">
        Your account isn't bound to an organization. Contact your admin or{' '}
        <a href="mailto:support@averrow.com" className="text-amber hover:underline">support@averrow.com</a>.
      </p>
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="max-w-md mx-auto py-16 text-center">
      <h1 className="text-xl font-semibold text-white mb-2">Couldn't load your workspace</h1>
      <p className="text-sm text-white/55">{error}</p>
    </div>
  );
}
