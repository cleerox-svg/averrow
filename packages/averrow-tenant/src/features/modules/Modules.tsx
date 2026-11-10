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
import { CheckCircle2, Lock, PauseCircle, AlertTriangle, Shield, ShieldAlert, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Banner, Card, PageState, Table, buttonVariants, pageStateKind } from '@averrow/shared/ui';
import { FACELIFT } from '@averrow/shared/theme';
import { cn } from '@/lib/cn';
import './modules.css';

const MODULE_PATHS: Record<ModuleKey, string> = {
  domain:        '/modules/domain',
  social:        '/modules/social',
  app_store:     '/modules/app-store',
  dark_web:      '/modules/dark-web',
  abuse_mailbox: '/modules/abuse-mailbox',
  trademark:     '/modules/trademark',
  threat_actor:  '/modules/threat-actor',
};

// Shared class strings. Tokens only: no hex, rgba or white-alpha.
const SECTION_LABEL = 'text-type-label text-[var(--text-tertiary)] mb-3';
const CARD_TITLE = 'text-type-h2 text-[var(--text-primary)]';
const LINK = 'th-link text-primary-text hover:underline rounded-sm ds-focusable';

/** Severity colours for an exposure score; one mapping for the tile and the table. */
function exposureColor(score: number): string {
  if (score >= 70) return 'var(--sev-critical-text)';
  if (score >= 40) return 'var(--sev-medium-text)';
  return 'var(--healthy)';
}

function sentenceCase(s: string): string {
  const t = s.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Flat card under the facelift; the pre-facelift tokenised card otherwise. */
function Surface({ padding = 20, className, children }: { padding?: number; className?: string; children: ReactNode }) {
  if (FACELIFT) {
    return <Card variant="flat" padding={padding} className={className}>{children}</Card>;
  }
  return (
    <div
      className={cn('overflow-hidden rounded-xl border border-[var(--border-base)] bg-bg-card', className)}
      style={{ padding }}
    >
      {children}
    </div>
  );
}

export function Modules() {
  const { user, hasOrg, loading: authLoading } = useAuth();
  const modulesQuery = useTenantModules();
  const dashboardQuery = useTenantDashboard();

  if (authLoading) return <PageState kind="loading" />;
  if (!user) return <NotAuthenticated />;
  if (!hasOrg) return <NoOrg />;

  // Either query loading on first paint = full loader. After first
  // render we let each section show its own state so the page doesn't
  // flicker when one query refetches.
  const kind = pageStateKind({
    isLoading: modulesQuery.isLoading && dashboardQuery.isLoading,
    isError: Boolean(modulesQuery.error) && !modulesQuery.data,
  });
  if (kind === 'loading') return <PageState kind="loading" />;
  if (kind === 'error') {
    return (
      <PageState
        kind="error"
        title="Couldn't load your workspace"
        description={modulesQuery.error?.message}
        onRetry={() => { void modulesQuery.refetch(); }}
      />
    );
  }

  const modulesData = modulesQuery.data;
  const dashboard = dashboardQuery.data;

  if (!modulesData) return <PageState kind="loading" />;

  const active = modulesData.modules.filter((m) => m.status === 'active' || m.status === 'trial');
  // Suspended modules are still the customer's own: listed with active ones, never under "Available to add".
  const owned = modulesData.modules.filter((m) => m.status === 'active' || m.status === 'trial' || m.status === 'suspended');
  const locked = modulesData.modules.filter((m) => m.status === 'not_entitled');

  return (
    <div className="tenant-home space-y-8 max-w-6xl">
      <header>
        <h1 className="text-type-display text-[var(--text-primary)]">Workspace overview</h1>
        <p className="mt-1 text-type-body text-[var(--text-secondary)]">
          {user.organization?.name ?? 'Your organization'} — {active.length} module{active.length === 1 ? '' : 's'} active
        </p>
      </header>

      <AuthorizationBadge data={modulesData.takedown_authorization} />

      {/* Headline stats — drives the eye to the real numbers. */}
      {dashboard && (
        <HeadlineStats dashboard={dashboard} />
      )}
      {dashboardQuery.error && !dashboard && (
        <PageState
          kind="error"
          layout="card"
          compact
          title="Couldn't load your summary"
          onRetry={() => { void dashboardQuery.refetch(); }}
        />
      )}
      {dashboardQuery.isLoading && !dashboard && (
        <div role="status" aria-busy="true" className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <span className="sr-only">Loading summary…</span>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} aria-hidden="true" className="rounded-xl border border-[var(--border-base)] bg-[var(--border-base)] h-20" />
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
      <section aria-labelledby="th-active-modules">
        <h2 id="th-active-modules" className={SECTION_LABEL}>Active modules</h2>
        {owned.length === 0 ? (
          <Surface padding={24} className="text-center">
            <p className="text-[var(--text-secondary)] text-type-small">No modules active yet.</p>
            <p className="text-[var(--text-secondary)] text-type-label mt-1">A super-admin needs to activate modules for your organization.</p>
          </Surface>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {owned.map((m) => (
              <ModuleCard key={m.module_key} module={m} entitled />
            ))}
          </div>
        )}
      </section>

      {locked.length > 0 && (
        <section aria-labelledby="th-available-modules">
          <h2 id="th-available-modules" className={SECTION_LABEL}>Available to add</h2>
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
  const exposure = dashboard.avg_exposure_score;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat label="Active threats" value={dashboard.total_active_threats} icon={ShieldAlert} />
      <Stat label="Open signals" value={dashboard.total_alerts_open} icon={AlertTriangle} />
      <Stat
        label="Impersonations"
        value={dashboard.total_impersonation_alerts}
        icon={Shield}
        color={dashboard.total_impersonation_alerts > 0 ? 'var(--sev-critical-text)' : undefined}
      />
      <Stat
        label="Exposure score"
        value={exposure ?? '—'}
        suffix={exposure != null ? '/100' : undefined}
        icon={TrendingUp}
        color={exposure != null ? exposureColor(exposure) : undefined}
      />
    </div>
  );
}

// Not the kit StatTile: it only tints a dot, and these need a flat card with a severity-coloured value.
// Counts are neutral by default; colour is reserved for severity (critical
// impersonations, the exposure band). Amber is a status colour, never an accent.
function Stat({
  label, value, suffix, icon: Icon, color,
}: {
  label:   string;
  value:   number | string;
  suffix?: string | undefined;
  icon:    typeof Shield;
  color?:  string | undefined;
}) {
  return (
    <Surface padding={16}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-type-label text-[var(--text-secondary)]">{label}</span>
        <Icon size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className="text-type-h1 tabular-nums text-[var(--text-primary)]"
          style={color ? { color } : undefined}
        >
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        {suffix && <span className="text-type-label text-[var(--text-secondary)] tabular-nums">{suffix}</span>}
      </div>
    </Surface>
  );
}

// ─── Per-brand rollup ──────────────────────────────────────────

function BrandRollup({ brands }: { brands: DashboardBrand[] }) {
  const th = 'px-4 py-2.5 text-type-label text-[var(--text-secondary)]';
  return (
    <section aria-labelledby="th-brands">
      <h2 id="th-brands" className={SECTION_LABEL}>
        Brands ({brands.length})
      </h2>
      <Surface padding={0}>
        <Table label="Brands" className="min-w-[36rem] text-type-small">
          <caption className="sr-only">Brands with active threats, social profiles, impersonations and exposure score</caption>
          <thead className="border-b border-[var(--border-base)]">
            <tr>
              <th scope="col" className={cn(th, 'text-left')}>Brand</th>
              <th scope="col" className={cn(th, 'text-right')}>Active threats</th>
              <th scope="col" className={cn(th, 'text-right')}>Exposure</th>
              <th scope="col" className={cn(th, 'text-right')}>Impersonations</th>
              <th scope="col" className={cn(th, 'text-right')}>Social profiles</th>
            </tr>
          </thead>
          <tbody>
            {brands.map((b) => (
              <tr key={b.id} className="th-row border-b border-[var(--border-base)] last:border-b-0 hover:bg-[var(--bg-page)]">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/threats?brand=${b.id}`}
                      className="th-tap font-medium text-[var(--text-primary)] hover:underline rounded-sm ds-focusable"
                    >
                      {b.name}
                    </Link>
                    {b.is_primary === 1 && (
                      <Badge font="sans" size="md" label="Primary" />
                    )}
                  </div>
                  <div className="text-type-label font-mono text-[var(--text-secondary)] mt-0.5">{b.canonical_domain}</div>
                </td>
                <td className="text-right px-4 py-2.5 tabular-nums text-[var(--text-primary)]">
                  {b.active_threats.toLocaleString()}
                </td>
                <td className="text-right px-4 py-2.5">
                  <ExposureScore score={b.exposure_score} />
                </td>
                <td
                  className="text-right px-4 py-2.5 tabular-nums text-[var(--text-secondary)]"
                  style={b.impersonation_count > 0 ? { color: 'var(--sev-critical-text)' } : undefined}
                >
                  {b.impersonation_count.toLocaleString()}
                </td>
                <td className="text-right px-4 py-2.5 tabular-nums text-[var(--text-secondary)]">
                  {b.social_profiles_count.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Surface>
    </section>
  );
}

function ExposureScore({ score }: { score: number | null }) {
  if (score == null) return <span className="text-[var(--text-secondary)]"><span aria-hidden="true">—</span><span className="sr-only">No score</span></span>;
  return <span className="tabular-nums" style={{ color: exposureColor(score) }}>{score}</span>;
}

// ─── 7-day trend ───────────────────────────────────────────────

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const DAY_MS = 86_400_000;

/**
 * Exactly the last `days` UTC calendar days ending on `now`'s UTC day, oldest
 * first. The API returns only days that had threats, so gaps are filled with 0.
 */
export function fillTrendDays(points: DashboardTrendPoint[], now: Date = new Date(), days = 7): DashboardTrendPoint[] {
  const byDay = new Map(points.map((p) => [p.date.slice(0, 10), p.count]));
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(todayUtc - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10);
    return { date, count: byDay.get(date) ?? 0 };
  });
}

/** Short weekday for a YYYY-MM-DD calendar day, always in UTC. */
export function weekdayUtc(date: string): string {
  return WEEKDAY.format(new Date(date));
}

function ThreatTrend({ points: sparse }: { points: DashboardTrendPoint[] }) {
  const points = fillTrendDays(sparse);
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((s, p) => s + p.count, 0);
  // Percentage heights collapse to 0 here because the column wrapper has no
  // definite height (items-end on the row doesn't stretch children). Size
  // bars in pixels against an explicit max instead.
  const BAR_MAX_PX = 64;
  const summary = `Threats per day, last 7 days: ${points
    .map((p) => `${weekdayUtc(p.date)} ${p.count.toLocaleString()}`)
    .join(', ')}. ${total.toLocaleString()} total.`;

  return (
    <Surface className="self-start">
      <section aria-labelledby="th-trend">
        <div className="flex items-baseline justify-between mb-4">
          <h2 id="th-trend" className={CARD_TITLE}>7-day threat trend</h2>
          <span className="text-type-label text-[var(--text-secondary)] tabular-nums">{total.toLocaleString()} total</span>
        </div>
        <div role="img" aria-label={summary} className="flex items-end gap-2 h-28">
          {points.map((p) => {
            const h = Math.max(4, Math.round((p.count / max) * BAR_MAX_PX));
            return (
              <div key={p.date} className="flex-1 min-w-0 flex flex-col items-center gap-1">
                <div className="text-type-label text-[var(--text-secondary)] tabular-nums">{p.count}</div>
                <div
                  data-testid="trend-bar"
                  className="w-full rounded-sm bg-[var(--primary)] hover:bg-[var(--primary-hover)] transition-colors motion-reduce:transition-none"
                  style={{ height: `${h}px` }}
                />
                <div className="text-type-label text-[var(--text-tertiary)]">{weekdayUtc(p.date)}</div>
              </div>
            );
          })}
        </div>
      </section>
    </Surface>
  );
}

// ─── Recent alerts ─────────────────────────────────────────────

function RecentAlerts({ alerts }: { alerts: DashboardRecentAlert[] }) {
  return (
    <Surface>
      <section aria-labelledby="th-signals">
        <div className="flex items-center justify-between mb-3">
          <h2 id="th-signals" className={CARD_TITLE}>Recent signals</h2>
          <Link to="/alerts" className={cn(LINK, 'th-tap text-type-small')}>
            View all<span aria-hidden="true">&nbsp;→</span>
          </Link>
        </div>
        <ul className="space-y-3">
          {alerts.map((a) => {
            const sev = (a.severity ?? '').trim().toLowerCase();
            return (
              <li key={a.id} className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <Badge severity={sev || null} label={sev ? sentenceCase(sev) : 'Unknown'} font="sans" size="md" />
                    <span className="text-type-label text-[var(--text-secondary)]">{sentenceCase(a.alert_type)}</span>
                  </div>
                  <p className="text-type-small text-[var(--text-primary)] truncate">{a.title}</p>
                  <p className="text-type-label text-[var(--text-secondary)] mt-0.5">{a.brand_name}</p>
                </div>
                <div className="text-type-label font-mono text-[var(--text-secondary)] flex-shrink-0">
                  {new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </Surface>
  );
}

// ─── Module card (now secondary) ───────────────────────────────

function ModuleCard({ module: m, entitled }: { module: TenantModuleSurface; entitled: boolean }) {
  const totalUsage = m.metrics.reduce((sum, metric) => sum + (metric.value_this_month ?? 0), 0);
  // Trial is informational (blue 'running' status), deliberately not amber/pending.
  const trial = m.status === 'trial';
  const suspended = m.status === 'suspended';

  return (
    <Link
      to={MODULE_PATHS[m.module_key]}
      className={cn(
        'th-module block rounded-xl border border-[var(--border-base)] bg-bg-card p-4 transition-colors motion-reduce:transition-none',
        'hover:border-[var(--border-strong)] ds-focusable',
        !entitled && 'th-module--locked',
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-type-body font-semibold text-[var(--text-primary)]">{MODULE_LABELS[m.module_key]}</div>
          <p className="text-type-small text-[var(--text-secondary)] mt-1">{MODULE_DESCRIPTIONS[m.module_key]}</p>
        </div>
        {suspended ? (
          <Badge status="warning" font="sans" size="md" className="flex-shrink-0">
            <PauseCircle size={12} aria-hidden="true" className="mr-1" />
            Suspended
          </Badge>
        ) : entitled ? (
          <Badge status={trial ? 'running' : 'active'} font="sans" size="md" className="flex-shrink-0">
            <CheckCircle2 size={12} aria-hidden="true" className="mr-1" />
            {trial ? 'Trial' : 'Active'}
          </Badge>
        ) : (
          <Badge status="inactive" font="sans" size="md" className="flex-shrink-0">
            <Lock size={12} aria-hidden="true" className="mr-1" />
            Locked
          </Badge>
        )}
      </div>

      {suspended && (
        <p className="mt-2 text-type-small text-[var(--text-secondary)]">Access paused. Contact your admin.</p>
      )}

      {entitled && !suspended && m.metrics.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[var(--border-base)]">
          <div className="text-type-label text-[var(--text-tertiary)] mb-1">This month</div>
          <div className="flex items-baseline gap-2">
            <span className="text-type-h2 text-[var(--text-primary)] tabular-nums">{totalUsage}</span>
            <span className="text-type-label text-[var(--text-secondary)]">across {m.metrics.length} metric{m.metrics.length === 1 ? '' : 's'}</span>
          </div>
        </div>
      )}
    </Link>
  );
}

function AuthorizationBadge({ data }: { data: { signed: boolean; modules_covered?: ModuleKey[] | undefined } }) {
  if (data.signed) {
    const n = data.modules_covered?.length ?? 0;
    return (
      <Banner
        tone="success"
        title="Takedown authorization signed"
        actions={
          <Link
            to="/settings/takedown-authorization"
            aria-label="Manage takedown authorization"
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'ds-focusable')}
          >
            Manage
          </Link>
        }
      >
        Coverage: {n} module{n === 1 ? '' : 's'}.
        Automated takedowns are running on your behalf within scope.
      </Banner>
    );
  }
  return (
    <Banner
      tone="medium"
      title="Sign your takedown authorization"
      actions={
        <Link
          to="/settings/takedown-authorization"
          aria-label="Sign your takedown authorization"
          className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'ds-focusable')}
        >
          Sign
        </Link>
      }
    >
      Without your signed authorization, takedowns can be detected but not submitted automatically.
    </Banner>
  );
}

function NotAuthenticated() {
  return (
    <div className="max-w-md mx-auto py-16 text-center">
      <h1 className="text-type-h2 text-[var(--text-primary)] mb-2">Sign in required</h1>
      <p className="text-type-small text-[var(--text-secondary)]">
        Your session has expired. <a href="/v2/login" className={LINK}>Sign in to continue</a>.
      </p>
    </div>
  );
}

function NoOrg() {
  return (
    <div className="max-w-md mx-auto py-16 text-center">
      <h1 className="text-type-h2 text-[var(--text-primary)] mb-2">No organization yet</h1>
      <p className="text-type-small text-[var(--text-secondary)]">
        Your account isn't bound to an organization. Contact your admin or{' '}
        <a href="mailto:support@averrow.com" className={LINK}>support@averrow.com</a>.
      </p>
    </div>
  );
}
