/**
 * Observatory v3 Side Panel — situational intelligence for the current map view.
 *
 * Reworked (2026-06) so the panel is pertinent + logical:
 *   - Everything that can respect the map's period does, and section labels are
 *     dynamic to the selected period (no more hard-coded "7d" that lies).
 *   - Leads with a situational SUMMARY (threats mapped · countries · campaigns +
 *     severity split) so you know what you're looking at.
 *   - Adds TOP THREAT ORIGINS (where attacks come from) — the key ranking a
 *     threat map should have, derived from the same geo nodes the globe draws.
 *   - Every entity row pivots into its detail page (real links, keyboard-reachable).
 *   - Respects the map's Source filter where the data supports it (overview, origins,
 *     live feed); each widget distinguishes loading / empty / error.
 *
 * Widgets:
 *   0. Summary (period)            — stats + severity bar
 *   1. Top Threat Origins (period) — countries by threat volume
 *   2. Top Targeted Brands (period)
 *   3. Hosting Providers (7d trend — structurally fixed)
 *   4. Active Operations
 *   5. Geopolitical Campaigns (30d)
 *   6. Agent Intelligence         — v2 parity (observatory-v2 retirement)
 *   7. Live Feed                  — v2 parity (observatory-v2 retirement)
 */

import { memo, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useObservatoryThreats, useObservatoryStats, useObservatoryLive, type ThreatPoint } from '@/hooks/useObservatory';
import { useBrands } from '@/hooks/useBrands';
import { useDashboardProviders } from '@/hooks/useProviders';
import type { DashboardProvider } from '@/hooks/useProviders';
import { useOperations } from '@/hooks/useOperations';
import { useGeopoliticalCampaigns } from '@/hooks/useGeopoliticalCampaign';
import { useAgents } from '@/hooks/useAgents';
import { Card, Badge, Avatar } from '@/design-system/components';
import { AgentAttribution } from '@/components/ui/AgentAttribution';
import { relativeTime } from '@/lib/time';
import { parseStringArray } from '@/lib/safe-json';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { topOrigins } from '../lib/origins';

// ─── Helpers ────────────────────────────────────────────────
function fmtPeriod(p: string): string {
  return (p || '7d').toUpperCase();
}

function countryFlag(code: string | null): string {
  if (!code || code.length !== 2) return '🏳️';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

// Clickable rows are real links (keyboard + middle-click + a11y) with a
// theme-aware hover tint instead of the old dark-only `hover:bg-white/[0.03]`.
const ROW_LINK =
  'ds-focusable block rounded -mx-1 px-1 transition-colors no-underline hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]';

const SOURCE_LABELS: Record<string, string> = { feeds: 'Feeds', spam_trap: 'Spam Trap' };

// Per-widget header row, rendered INSIDE each Card. Deliberately not Card.tsx's
// exported `CardHeader` — that hardcodes amber, which is too loud repeated
// across 8 stacked widget headers in one panel.
function WidgetHeader({ label, count, updating }: { label: string; count?: number; updating?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <span
        className="text-[10px] font-mono font-bold uppercase tracking-[0.20em]"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {label}
      </span>
      <span className="flex items-center gap-2">
        {updating && (
          <span role="status" className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--amber-text)' }}>
            Updating&hellip;
          </span>
        )}
        {count !== undefined && (
          <span className="text-[10px] font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {count}
          </span>
        )}
      </span>
    </div>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded"
      style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)' }}
    >
      <span className="text-[10px] font-mono" style={{ color: 'var(--sev-critical-text)' }}>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="ds-focusable text-[10px] font-mono font-bold uppercase tracking-wide shrink-0"
        style={{ color: 'var(--sev-critical-text)', background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0 }}
      >
        Retry
      </button>
    </div>
  );
}

/**
 * The three widget states, kept visibly distinct:
 *   loading (nothing to show yet) / error (nothing to show, request failed) /
 *   empty (request succeeded, no rows). With data present it renders children
 *   and, if a background refresh failed, a small non-destructive warning.
 */
function WidgetBody({
  hasData, isLoading, error, onRetry, loadingText = 'Loading…', errorText, emptyText, children,
}: {
  hasData: boolean;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  loadingText?: string;
  errorText: string;
  emptyText: string;
  children: ReactNode;
}) {
  if (!hasData) {
    if (isLoading) {
      return <div role="status" className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>{loadingText}</div>;
    }
    if (error) return <InlineError message={errorText} onRetry={onRetry} />;
    return <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>;
  }
  return (
    <>
      {error ? <div className="mb-2"><InlineError message={`${errorText} (showing last data)`} onRetry={onRetry} /></div> : null}
      {children}
    </>
  );
}

// ─── Summary header ─────────────────────────────────────────
function Stat({ label, value, loading }: { label: string; value: number | null | undefined; loading: boolean }) {
  return (
    <div>
      <div className="text-sm font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
        {value != null ? value.toLocaleString() : loading ? '…' : '—'}
      </div>
      <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

const SummaryHeader = memo(function SummaryHeader({ period, source }: { period: string; source: string }) {
  const stats = useObservatoryStats({ period, source });
  const nodesQ = useObservatoryThreats({ period, source });
  const nodes = nodesQ.data ?? [];
  const summaryError = stats.error || nodesQ.error;
  const updating = stats.isUpdating || nodesQ.isUpdating;

  const sev = nodes.reduce(
    (a, n) => ({
      critical: a.critical + (n.critical || 0),
      high: a.high + (n.high || 0),
      medium: a.medium + (n.medium || 0),
      low: a.low + (n.low || 0),
    }),
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
  const sevTotal = sev.critical + sev.high + sev.medium + sev.low;

  const segs: Array<{ k: keyof typeof sev; color: string }> = [
    { k: 'critical', color: 'var(--sev-critical)' },
    { k: 'high', color: 'var(--sev-high)' },
    { k: 'medium', color: 'var(--sev-medium)' },
    { k: 'low', color: 'var(--sev-low)' },
  ];

  return (
    <div>
      <WidgetHeader label={`Overview · ${fmtPeriod(period)}`} updating={updating} />
      {summaryError && (
        <div className="mb-2">
          <InlineError
            message="Summary failed to load"
            onRetry={() => { if (stats.error) void stats.refetch(); if (nodesQ.error) void nodesQ.refetch(); }}
          />
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 mb-2">
        <Stat label="Threats" value={stats.data?.threats_mapped} loading={stats.isLoading} />
        <Stat label="Countries" value={stats.data?.countries} loading={stats.isLoading} />
        <Stat label="Campaigns" value={stats.data?.active_campaigns} loading={stats.isLoading} />
      </div>
      {sevTotal > 0 && (
        <>
          <div className="flex h-1.5 rounded-full overflow-hidden mb-1">
            {segs.map(s => sev[s.k] > 0 && (
              <div key={s.k} style={{ width: `${(sev[s.k] / sevTotal) * 100}%`, background: s.color }} />
            ))}
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            {segs.map(s => sev[s.k] > 0 && (
              <span key={s.k} className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                {sev[s.k].toLocaleString()}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
});

// ─── Top Threat Origins ─────────────────────────────────────
const TopOriginsWidget = memo(function TopOriginsWidget({
  period, source, onSelectNode,
}: { period: string; source: string; onSelectNode?: (node: ThreatPoint) => void }) {
  const q = useObservatoryThreats({ period, source });

  const top = useMemo(() => topOrigins(q.data), [q.data]);
  const max = top[0]?.count ?? 1;

  return (
    <div>
      <WidgetHeader label={`Top Threat Origins · ${fmtPeriod(period)}`} updating={q.isUpdating} />
      <WidgetBody
        hasData={top.length > 0}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        errorText="Origins failed to load"
        emptyText="No geolocated threats in this period"
      >
        {top.map(({ code, count, node }) => {
          const row = (
            <>
            <span className="text-sm shrink-0" aria-hidden>{countryFlag(code)}</span>
            <span className="text-xs font-mono shrink-0 w-6" style={{ color: 'var(--text-secondary)' }}>{code}</span>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}>
              <div className="h-full rounded-full" style={{ width: `${(count / max) * 100}%`, background: 'var(--amber)' }} />
            </div>
            <span className="text-xs font-mono font-bold tabular-nums shrink-0" style={{ color: 'var(--text-primary)' }}>
              {count.toLocaleString()}
            </span>
            </>
          );
          return onSelectNode && node ? (
            <button
              key={code}
              type="button"
              onClick={() => onSelectNode(node)}
              aria-label={`${code}: ${count.toLocaleString()} threats. Show busiest node on map`}
              className={`${ROW_LINK} flex items-center gap-2.5 py-1 w-full text-left min-h-[24px]`}
              style={{ background: 'none', border: 'none', cursor: 'pointer' }}
            >
              {row}
            </button>
          ) : (
            <div key={code} className="flex items-center gap-2.5 py-1">{row}</div>
          );
        })}
      </WidgetBody>
    </div>
  );
});

// ─── Provider row ───────────────────────────────────────────
function ProviderRow({ p, direction }: { p: DashboardProvider; direction: 'worsening' | 'improving' }) {
  const trendPct = p.trend_7d_pct;
  const trendColor = direction === 'worsening' ? 'var(--sev-critical-text)' : 'var(--sev-info-text)';
  const arrow = direction === 'worsening' ? '↑' : '↓';

  return (
    <Link
      to={`/explore?tab=providers&focus=${encodeURIComponent(p.provider_id)}`}
      className={`${ROW_LINK} flex items-center justify-between py-1.5`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</div>
        {p.asn && (
          <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{p.asn}</div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        <span className="text-xs font-mono font-bold" style={{ color: 'var(--text-secondary)' }}>
          {p.threat_count.toLocaleString()}
        </span>
        {trendPct != null && (
          <span className="text-[10px] font-mono font-bold" style={{ color: trendColor }}>
            {arrow} {Math.abs(Math.round(trendPct))}%
          </span>
        )}
      </div>
    </Link>
  );
}

// ─── Top Targeted Brands ────────────────────────────────────
const TopBrandsWidget = memo(function TopBrandsWidget({ period }: { period: string }) {
  const q = useBrands({ view: 'top', limit: 8, timeRange: period });
  const brands = q.data ?? [];

  return (
    <div>
      <WidgetHeader label={`Top Targeted Brands · ${fmtPeriod(period)}`} count={brands.length} updating={q.isPlaceholderData} />
      <WidgetBody
        hasData={brands.length > 0}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        errorText="Brands failed to load"
        emptyText="No targeted brands in this period"
      >
        {brands.map((brand) => (
          <Link key={brand.id} to={`/brands/${encodeURIComponent(String(brand.id))}`} className={`${ROW_LINK} flex items-center gap-2.5 py-1.5`}>
            <Avatar
              name={brand.name}
              color="var(--amber)"
              dimColor="var(--amber-dim)"
              faviconUrl={brand.canonical_domain ? `https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=32` : undefined}
              size={24}
              glow
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{brand.name}</div>
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{brand.canonical_domain}</div>
            </div>
            <div className="flex-shrink-0">
              <span className="text-xs font-mono font-bold" style={{ color: 'var(--sev-critical-text)' }}>
                {(brand.threat_count ?? 0).toLocaleString()}
              </span>
            </div>
          </Link>
        ))}
      </WidgetBody>
    </div>
  );
});

// ─── Providers Worsening / Improving (7d trend) ─────────────
const ProvidersWidget = memo(function ProvidersWidget() {
  const worse = useDashboardProviders('worst', 3);
  const better = useDashboardProviders('improving', 3);
  const worsening = worse.data ?? [];
  const improving = better.data ?? [];

  return (
    <div>
      <WidgetHeader label="Hosting Providers · 7d trend" />
      <div className="mb-2">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--sev-critical)' }} />
          <span className="text-[10px] font-mono tracking-wider uppercase" style={{ color: 'var(--sev-critical-text)' }}>Worsening</span>
        </div>
        <WidgetBody
          hasData={worsening.length > 0}
          isLoading={worse.isLoading}
          error={worse.error}
          onRetry={() => void worse.refetch()}
          errorText="Providers failed to load"
          emptyText="No worsening providers"
        >
          {worsening.map((p) => <ProviderRow key={p.provider_id} p={p} direction="worsening" />)}
        </WidgetBody>
      </div>
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--sev-info)' }} />
          <span className="text-[10px] font-mono tracking-wider uppercase" style={{ color: 'var(--sev-info-text)' }}>Improving</span>
        </div>
        <WidgetBody
          hasData={improving.length > 0}
          isLoading={better.isLoading}
          error={better.error}
          onRetry={() => void better.refetch()}
          errorText="Providers failed to load"
          emptyText="No improving providers"
        >
          {improving.map((p) => <ProviderRow key={p.provider_id} p={p} direction="improving" />)}
        </WidgetBody>
      </div>
    </div>
  );
});

// ─── Active Operations ──────────────────────────────────────
const OperationsWidget = memo(function OperationsWidget() {
  const q = useOperations({ status: 'active', limit: 4 });
  const operations = q.data ?? [];

  return (
    <div>
      <WidgetHeader label="Active Operations" count={operations.length} />
      <WidgetBody
        hasData={operations.length > 0}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        errorText="Operations failed to load"
        emptyText="No active operations"
      >
        {operations.map((op) => {
          const countries = parseStringArray(op.countries);
          const asns = parseStringArray(op.asns);
          const isAccelerating = op.agent_notes?.includes('ACCELERATING');
          return (
            <Link key={op.id} to={`/campaigns/${encodeURIComponent(String(op.id))}`} className={`${ROW_LINK} py-2`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {op.cluster_name || 'Unnamed Cluster'}
                </span>
                {isAccelerating && <Badge severity="high" label="ACCEL" size="xs" />}
              </div>
              <div className="flex items-center gap-3 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                <span>{op.threat_count.toLocaleString()} threats</span>
                {countries.length > 0 && <span>{countries.slice(0, 3).join(', ')}</span>}
              </div>
              {(asns.length > 0 || op.confidence_score != null) && (
                <div className="flex items-center gap-3 text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {asns.length > 0 && (
                    <span className="truncate">{asns.slice(0, 2).join(', ')}</span>
                  )}
                  {op.confidence_score != null && (
                    <span className="shrink-0 ml-auto tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {op.confidence_score}% conf
                    </span>
                  )}
                </div>
              )}
            </Link>
          );
        })}
      </WidgetBody>
    </div>
  );
});

// ─── Geopolitical Campaigns ─────────────────────────────────
const GeoCampaignsWidget = memo(function GeoCampaignsWidget() {
  const q = useGeopoliticalCampaigns('active');
  const campaigns = q.data ?? [];

  const recent = useMemo(() => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return campaigns.filter(c => {
      if (!c.start_date) return true;
      const start = new Date(c.start_date).getTime();
      return start > thirtyDaysAgo || !c.end_date;
    });
  }, [campaigns]);

  return (
    <div>
      <WidgetHeader label="Geopolitical Campaigns · 30d" />
      <WidgetBody
        hasData={recent.length > 0}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        errorText="Campaigns failed to load"
        emptyText="No active campaigns"
      >
        {recent.map((c) => {
          const adversary = parseStringArray(c.adversary_countries);
          const targets = parseStringArray(c.target_sectors);
          return (
            <Link
              key={c.id}
              to={`/campaigns/geo/${encodeURIComponent(c.name.toLowerCase().replace(/\s+/g, '-'))}`}
              className={`${ROW_LINK} py-2`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Badge status="active" label={c.status} size="xs" pulse />
                <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {c.name}
                </span>
              </div>
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {adversary.length > 0 && <span>{adversary.join(', ')}</span>}
                {targets.length > 0 && <span> {'→'} {targets.slice(0, 2).join(', ')}</span>}
              </div>
            </Link>
          );
        })}
      </WidgetBody>
    </div>
  );
});

// ─── Agent Intelligence (v2 parity) ─────────────────────────
const AgentIntelWidget = memo(function AgentIntelWidget() {
  const q = useAgents();
  const recentOutputs = useMemo(
    () =>
      (q.data ?? [])
        .filter(a => a.last_output_at)
        .sort((a, b) => new Date(b.last_output_at!).getTime() - new Date(a.last_output_at!).getTime())
        .slice(0, 5),
    [q.data],
  );

  return (
    <div>
      <WidgetHeader label="Agent Intelligence" />
      <AgentAttribution agent="Observer + Sentinel" />
      <div className="mt-2">
        <WidgetBody
          hasData={recentOutputs.length > 0}
          isLoading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          errorText="Agent feed failed to load"
          emptyText="No recent agent output"
        >
          <div className="space-y-1.5">
            {recentOutputs.map(agent => (
              <div key={agent.agent_id} className="flex items-center gap-2 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: agent.color }} />
                <span className="text-[10px] font-mono font-bold uppercase truncate flex-1" style={{ color: agent.color }}>
                  {agent.display_name}
                </span>
                <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                  {agent.outputs_24h} out &middot; {relativeTime(agent.last_output_at)}
                </span>
              </div>
            ))}
          </div>
        </WidgetBody>
      </div>
    </div>
  );
});

// ─── Live Feed (v2 parity) ───────────────────────────────────
const LIVE_SEVERITY_COLOR: Record<string, string> = {
  critical: 'var(--sev-critical)',
  high: 'var(--sev-high)',
  medium: 'var(--sev-medium)',
  low: 'var(--sev-low)',
};

const LiveFeedWidget = memo(function LiveFeedWidget({ source }: { source: string }) {
  const q = useObservatoryLive({ source });
  const entries = q.data ?? [];

  return (
    <div>
      <WidgetHeader label="Live Feed" updating={q.isUpdating} />
      <WidgetBody
        hasData={entries.length > 0}
        isLoading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        errorText="Live feed failed to load"
        emptyText="Waiting for threats..."
      >
        <div className="space-y-1">
          {entries.slice(0, 8).map(entry => (
            <div key={entry.id} className="flex items-center gap-2 py-0.5">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: LIVE_SEVERITY_COLOR[entry.severity?.toLowerCase() ?? ''] ?? 'var(--sev-low)' }}
                role="img"
                aria-label={entry.severity ?? 'unknown severity'}
                title={entry.severity ?? undefined}
              />
              <span className="text-[10px] font-mono truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                {entry.threat_type?.replace(/_/g, ' ')}
              </span>
              {entry.country_code && (
                <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-secondary)' }}>{entry.country_code}</span>
              )}
              <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>
                {relativeTime(entry.created_at)}
              </span>
            </div>
          ))}
        </div>
      </WidgetBody>
    </div>
  );
});

// ─── Main SidePanel ─────────────────────────────────────────
interface SidePanelProps {
  period: string;
  /** Map source filter. Applied to the widgets whose data supports it (overview, origins, live feed). */
  source?: string;
  visible: boolean;
  /**
   * A map data filter (severity / threat type / brand) is set. The panel's endpoints take no such filters, so its
   * widgets stay unfiltered; when this is true the panel says so instead of silently disagreeing with the map.
   */
  mapFiltered?: boolean;
  /** Selects a node on the map (keyboard path from the Top Threat Origins rows). */
  onSelectNode?: (node: ThreatPoint) => void;
  /**
   * R10 mobile chrome (C2): when true, the widgets are wrapped full-width for the
   * phone's PeekSheet. Either way they are in-flow content: the PanelDock (desktop)
   * or the sheet (phone) supplies the background and the scroll container — see
   * ObservatoryV3.tsx.
   */
  mobile?: boolean;
}

export function SidePanel({ period, source = 'all', visible, mapFiltered = false, mobile = false, onSelectNode }: SidePanelProps) {
  if (!visible) return null;

  const filtered = source !== 'all';

  // In-flow widgets with no scroller of their own: the PanelDock (desktop) or the sheet (phone) owns the single scroll
  // container — a second one here would double-scroll.
  const widgets = (
    <div // Cards are `overflow:hidden`, so as flex items they would shrink to fit and clip their
    // content instead of letting the container scroll — `[&>*]:shrink-0` keeps natural height.
    className="flex flex-col gap-3 px-3 pb-3 pt-2 [&>*]:shrink-0">
      {filtered && (
        <div
          className="px-2 py-1.5 rounded text-[10px] font-mono"
          style={{ background: 'var(--amber-glow)', border: '1px solid var(--amber-border)', color: 'var(--amber-text)' }}
        >
          Source: {SOURCE_LABELS[source] ?? source}. Applies to overview, origins and live feed;
          brands, providers, operations and campaigns cover all sources.
        </div>
      )}

      {mapFiltered && (
        <div
          role="status"
          data-unfiltered-hint
          className="px-2 py-1.5 rounded text-[10px] font-mono"
          style={{ background: 'var(--amber-glow)', border: '1px solid var(--amber-border)', color: 'var(--amber-text)' }}
        >
          Unfiltered: the map&apos;s severity, type and brand filters don&apos;t apply to this panel.
        </div>
      )}

      <Card variant="active" padding="16px">
        <SummaryHeader period={period} source={source} />
      </Card>

      <Card variant="base" padding="16px">
        <TopOriginsWidget period={period} source={source} onSelectNode={onSelectNode} />
      </Card>

      <Card variant="base" padding="16px">
        <TopBrandsWidget period={period} />
      </Card>

      <Card variant="base" padding="16px">
        <ProvidersWidget />
      </Card>

      <Card variant="base" padding="16px">
        <OperationsWidget />
      </Card>

      <Card variant="base" padding="16px">
        <GeoCampaignsWidget />
      </Card>

      <Card variant="base" padding="16px">
        <AgentIntelWidget />
      </Card>

      <Card variant="base" padding="16px">
        <LiveFeedWidget source={source} />
      </Card>
    </div>
  );

  const panel = <PanelErrorBoundary label="Intelligence panel">{widgets}</PanelErrorBoundary>;
  // Full-width, in-flow — the drawer shell (ObservatoryV3.tsx) owns background, border, positioning and the scroll.
  return mobile ? <div className="w-full">{panel}</div> : panel;
}
