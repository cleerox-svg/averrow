import { Fragment, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from 'recharts';
import {
  useIntelligenceBriefings,
  useThreatVolume,
  useBrandMomentum,
  useProviderMomentum,
  useNexusActive,
} from '@/hooks/useTrends';
import type { IntelligenceBriefing, VolumePoint } from '@/hooks/useTrends';
import { Card } from '@/components/ui/Card';
import { Button } from '@/design-system/components';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageLoader } from '@/components/ui/PageLoader';
import { AgentAttribution } from '@/components/ui/AgentAttribution';
import { ExecutiveSummary } from '@/components/trends/ExecutiveSummary';
import { Badge } from '@/components/ui/Badge';
/* ── Constants ── */

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#f87171',
  high: '#fb923c',
  medium: '#fbbf24',
  low: '#78A0C8',
  clean: '#4ade80',
};

const WINDOWS = ['7d', '30d', '90d'] as const;

const THREAT_TYPE_COLORS: Record<string, string> = {
  phishing: '#C83C3C',
  malware_distribution: '#9333ea',
  malicious_ip: '#78A0C8',
  c2: '#ef4444',
  typosquatting: '#DCAA32',
  credential_harvesting: '#E8923C',
};

const THREAT_TYPE_LABELS: Record<string, string> = {
  phishing: 'Phishing',
  malware_distribution: 'Malware Distribution',
  malicious_ip: 'Malicious IP',
  c2: 'C2',
  typosquatting: 'Typosquatting',
  credential_harvesting: 'Credential Harvesting',
};

const THREAT_TYPES = Object.keys(THREAT_TYPE_COLORS);

// Briefing summaries arrive as markdown — typically `**Title** — body…`.
// Cards want a clean preview, not raw markdown asterisks. Split into
// title (bold prefix) + body (everything after the em-dash / dash
// separator). The inline detail panel renders the body verbatim with
// any remaining asterisks stripped.
function splitBriefing(summary: string | undefined): { title: string; body: string } {
  if (!summary) return { title: 'Untitled', body: '' };
  const boldMatch = summary.match(/^\*\*(.+?)\*\*\s*[—–-]?\s*(.*)$/s);
  if (boldMatch) {
    return { title: boldMatch[1] ?? 'Untitled', body: boldMatch[2] ?? '' };
  }
  // No bold prefix — first 100 chars become the title, rest is body.
  return {
    title: summary.slice(0, 100),
    body: summary.length > 100 ? summary.slice(100) : '',
  };
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/_(.+?)_/g, '$1')       // italic
    .replace(/^#+\s+/gm, '');        // headings
}

function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    if (typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    // Comma-separated fallback
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
}

interface ParsedDetails {
  category?: string;
  title?: string;
  recommendations?: string[];
  // Anything else the Observer wrote — surface as a key/value table
  // so we never lose data we don't yet have a tailored renderer for.
  [k: string]: unknown;
}

function parseDetails(raw: string | null | undefined): ParsedDetails | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ParsedDetails;
    }
    return null;
  } catch {
    return null;
  }
}

/* ── Tooltip ── */

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg px-3 py-2 text-xs" style={{ background:'var(--bg-card)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid var(--border-base)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)' }}>
      <div className="font-mono mb-1" style={{ color: 'var(--text-secondary)' }}>{label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }}>{THREAT_TYPE_LABELS[p.name] ?? p.name}</span>
          <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{(p.value ?? 0).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Section 1: Observer Intelligence Briefings ── */

function BriefingCard({
  briefing,
  isSelected,
  onSelect,
}: {
  briefing: IntelligenceBriefing;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const sev = briefing.severity?.toLowerCase() ?? 'low';
  const dotColor = SEVERITY_COLORS[sev] ?? '#78A0C8';
  const { title } = splitBriefing(briefing.summary);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left rounded-xl p-4 transition-all cursor-pointer hover:bg-white/[0.03]"
      style={{
        background: isSelected ? 'rgba(229,168,50,0.06)' : 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: isSelected
          ? '1px solid rgba(229,168,50,0.45)'
          : sev === 'critical' ? '1px solid rgba(200,60,60,0.30)'
          : sev === 'high'     ? '1px solid rgba(229,168,50,0.30)'
                               : '1px solid var(--border-base)',
        borderRadius: '0.75rem',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)',
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug font-medium" style={{ color: 'var(--text-primary)' }}>
            {title}
          </p>
          <div className="mt-2 font-mono text-[10px] flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
            <span>
              {new Date(briefing.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </span>
            <span style={{ color: 'var(--amber)' }}>
              {isSelected ? '▾ Collapse' : '▸ View context'}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

// Inline detail panel — replaces the right-side ReportPanel drawer. Renders
// beneath the selected card via grid `col-span-full` so all the context
// is in the page flow, not behind an overlay.
function BriefingDetailPanel({ briefing }: { briefing: IntelligenceBriefing }) {
  const { title, body } = splitBriefing(briefing.summary);
  const cleanBody = stripMarkdown(body).trim();
  const details = parseDetails(briefing.details);
  const brandIds = parseIdList(briefing.related_brand_ids);
  const providerIds = parseIdList(briefing.related_provider_ids);
  const campaignId = briefing.related_campaign_id ?? null;

  const sev = briefing.severity?.toLowerCase() ?? 'low';
  const sevBadge: 'critical' | 'high' | 'medium' | 'low' =
    sev === 'critical' ? 'critical'
      : sev === 'high' ? 'high'
      : sev === 'medium' ? 'medium'
      : 'low';

  // Known structured fields. Everything else falls into a generic
  // key/value table so we surface whatever the agent wrote without
  // needing per-category renderers for each.
  const KNOWN_KEYS = new Set(['title', 'category', 'recommendations']);
  const extraEntries = details
    ? Object.entries(details).filter(([k, v]) => !KNOWN_KEYS.has(k) && v != null && v !== '' && (typeof v !== 'object' || Array.isArray(v)))
    : [];

  return (
    <Card hover={false} variant="elevated">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <Badge status="active" label="Observer" size="xs" />
            <Badge severity={sevBadge} size="xs" />
            {details?.category && (
              <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: 'var(--border-base)', color: 'var(--text-tertiary)' }}>
                {details.category.replace(/_/g, ' ')}
              </span>
            )}
          </div>
          <h3 className="font-display text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h3>
          <div className="font-mono text-[10px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            Generated {new Date(briefing.created_at).toLocaleString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </div>
        </div>
      </div>

      {cleanBody && (
        <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
          {cleanBody}
        </p>
      )}

      {/* Structured detail rows (counts, conflict, etc.) */}
      {extraEntries.length > 0 && (
        <div className="mb-4 pt-3" style={{ borderTop: '1px solid var(--border-base)' }}>
          <div className="font-mono text-[9px] uppercase tracking-widest mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Signals
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {extraEntries.map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {k.replace(/_/g, ' ')}
                </span>
                <span className="font-mono text-sm" style={{ color: 'var(--text-primary)' }}>
                  {Array.isArray(v)
                    ? v.length === 0 ? '—' : v.join(', ')
                    : typeof v === 'number' || typeof v === 'string'
                      ? String(v)
                      : JSON.stringify(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recommendations list */}
      {details?.recommendations && details.recommendations.length > 0 && (
        <div className="mb-4 pt-3" style={{ borderTop: '1px solid var(--border-base)' }}>
          <div className="font-mono text-[9px] uppercase tracking-widest mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Recommended actions
          </div>
          <ul className="space-y-1.5">
            {details.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--amber)' }} />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Related entity chips */}
      {(brandIds.length > 0 || providerIds.length > 0 || campaignId) && (
        <div className="pt-3" style={{ borderTop: '1px solid var(--border-base)' }}>
          <div className="font-mono text-[9px] uppercase tracking-widest mb-2" style={{ color: 'var(--text-tertiary)' }}>
            Related
          </div>
          <div className="flex flex-wrap gap-1.5">
            {brandIds.slice(0, 12).map(id => (
              <Link key={`b-${id}`} to={`/brands/${id}`} className="font-mono text-[10px] px-2 py-1 rounded transition-colors hover:underline" style={{ background: 'var(--border-base)', color: 'var(--text-primary)' }}>
                Brand · {id}
              </Link>
            ))}
            {brandIds.length > 12 && (
              <span className="font-mono text-[10px] px-2 py-1" style={{ color: 'var(--text-muted)' }}>
                +{brandIds.length - 12} more
              </span>
            )}
            {providerIds.slice(0, 6).map(id => (
              <Link key={`p-${id}`} to={`/providers/${id}`} className="font-mono text-[10px] px-2 py-1 rounded transition-colors hover:underline" style={{ background: 'var(--border-base)', color: 'var(--text-primary)' }}>
                Provider · {id}
              </Link>
            ))}
            {campaignId && (
              <Link to={`/campaigns/${campaignId}`} className="font-mono text-[10px] px-2 py-1 rounded transition-colors hover:underline" style={{ background: 'var(--border-base)', color: 'var(--text-primary)' }}>
                Campaign · {campaignId.slice(0, 8)}
              </Link>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function IntelligenceBriefings() {
  const { data: briefings, isLoading } = useIntelligenceBriefings(6);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <section>
      <SectionLabel className="mb-4">Observer Intelligence Briefings</SectionLabel>
      <AgentAttribution agent="Observer" />
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : !briefings?.length ? (
        <Card hover={false}>
          <p className="text-sm text-white/40">No intelligence briefings available</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {briefings.map(b => (
            <Fragment key={b.id}>
              <BriefingCard
                briefing={b}
                isSelected={selectedId === b.id}
                onSelect={() => setSelectedId(prev => prev === b.id ? null : b.id)}
              />
              {selectedId === b.id && (
                <div className="col-span-full">
                  <BriefingDetailPanel briefing={b} />
                </div>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Section 2: Threat Volume Chart ── */

function ThreatVolumeChart({ window }: { window: string }) {
  const { data: volume, isLoading } = useThreatVolume(window);

  return (
    <section>
      <SectionLabel className="mb-4">Threat Volume</SectionLabel>
      <Card hover={false}>
        {isLoading ? (
          <Skeleton className="h-[280px] lg:h-[280px] h-[200px] rounded-lg" />
        ) : !volume?.length ? (
          <p className="text-sm text-white/40 py-8 text-center">No volume data</p>
        ) : (
          <ResponsiveContainer width="100%" height={280} className="max-md:!h-[200px]">
            <AreaChart data={volume}>
              <XAxis
                dataKey="date"
                tick={{ fill: '#78A0C8', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                axisLine={{ stroke: 'var(--border-base)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#78A0C8', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              {THREAT_TYPES.map((type) => (
                <Area
                  key={type}
                  type="monotone"
                  dataKey={type}
                  stackId="1"
                  fill={THREAT_TYPE_COLORS[type]}
                  stroke={THREAT_TYPE_COLORS[type]}
                  fillOpacity={0.3}
                  name={type}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>
    </section>
  );
}

/* ── Section 3 Left: Brand Risk Momentum ── */

function BrandRiskMomentum() {
  const { data: brands, isLoading } = useBrandMomentum();

  function changeGlow(pct: number): CSSProperties {
    if (pct > 100) return { color: '#f87171', textShadow: '0 0 20px rgba(200,60,60,0.8)' };
    if (pct > 50)  return { color: '#fb923c', textShadow: '0 0 20px rgba(251,146,60,0.7)' };
    return { color: '#E5A832', textShadow: '0 0 20px rgba(229,168,50,0.7)' };
  }

  return (
    <Card hover={false} className="h-full">
      <SectionLabel className="mb-4">Brand Risk Momentum</SectionLabel>
      {isLoading ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : !brands?.length ? (
        <p className="text-sm text-white/40">No brand data</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--text-tertiary)' }}>
                <th className="pb-2">Brand</th>
                <th className="pb-2 text-right">This Week</th>
                <th className="pb-2 text-right">Last Week</th>
                <th className="pb-2 text-right">Change%</th>
              </tr>
            </thead>
            <tbody>
              {brands.map((b) => {
                const thisWeek = b.this_week ?? 0;
                const lastWeek = b.last_week ?? 0;
                const changePct = lastWeek === 0
                  ? (thisWeek > 0 ? 100 : 0)
                  : ((thisWeek - lastWeek) / lastWeek) * 100;
                const displayChange = isFinite(changePct)
                  ? `${changePct > 0 ? '+' : ''}${Math.round(changePct)}%`
                  : 'NEW';
                return (
                  <tr key={b.target_brand_id ?? b.brand_name} className="data-row border-t border-white/5">
                    <td className="py-2" style={{ color: 'var(--text-primary)' }}>
                      {b.target_brand_id
                        ? <Link to={`/brands/${b.target_brand_id}`} className="hover:text-[var(--amber)] transition-colors">{b.brand_name}</Link>
                        : b.brand_name}
                    </td>
                    <td className="py-2 text-right font-mono" style={{ color: 'var(--text-primary)' }}>{thisWeek.toLocaleString()}</td>
                    <td className="py-2 text-right font-mono" style={{ color: 'var(--text-secondary)' }}>{lastWeek.toLocaleString()}</td>
                    <td className="py-2 text-right font-mono font-semibold" style={changeGlow(isFinite(changePct) ? changePct : 0)}>
                      {displayChange}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ── Section 3 Right: Provider Momentum + NEXUS Clusters ── */

function ProviderMomentumPanel() {
  const { data: providers, isLoading: provLoading } = useProviderMomentum();
  const { data: clusters, isLoading: nexusLoading } = useNexusActive();

  const maxCount = providers?.length
    ? Math.max(...providers.map((p) => p.count ?? 0), 1)
    : 1;

  function barColor(count: number | undefined | null): string {
    const c = count ?? 0;
    if (c > 500) return '#C83C3C';
    if (c > 100) return '#E8923C';
    return '#E5A832';
  }

  return (
    <div className="space-y-4">
      <Card hover={false}>
        <SectionLabel className="mb-4">Provider Momentum</SectionLabel>
        {provLoading ? (
          <Skeleton className="h-36 rounded-lg" />
        ) : !providers?.length ? (
          <p className="text-sm text-white/40">No provider data</p>
        ) : (
          <div className="space-y-2">
            {providers.map((p) => {
              const count = p.count ?? 0;
              const pct = (count / maxCount) * 100;
              const color = barColor(count);
              return (
                <div key={p.provider_id ?? p.provider} className="flex items-center gap-3">
                  <div className="w-28 text-xs truncate font-mono" style={{ color: 'var(--text-primary)' }}>
                    {p.provider_id
                      ? <Link to={`/providers?focus=${encodeURIComponent(p.provider_id)}`} className="hover:text-[var(--amber)] transition-colors">{p.provider}</Link>
                      : p.provider}
                  </div>
                  <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: color }}
                    />
                  </div>
                  <div className="font-mono text-[11px] w-12 text-right" style={{ color: 'var(--text-secondary)' }}>
                    {count.toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card hover={false}>
        <SectionLabel className="mb-3">NEXUS Active Clusters</SectionLabel>
        <AgentAttribution agent="Nexus" />
        {nexusLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : !clusters?.length ? (
          <p className="text-sm text-white/40">No active clusters</p>
        ) : (
          <div className="space-y-2">
            {clusters.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 py-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: SEVERITY_COLORS[c.severity?.toLowerCase() ?? 'low'] ?? '#78A0C8' }}
                  />
                  <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{c.label}</span>
                </div>
                <span className="font-mono text-[10px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                  {(c.threat_count ?? 0).toLocaleString()} threats
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── Section 4: Threat Type Totals ── */

function ThreatTypeTotals({ volume }: { volume: VolumePoint[] }) {
  const totals = THREAT_TYPES.map((type) => ({
    name: THREAT_TYPE_LABELS[type],
    key: type,
    total: volume.reduce((sum, v) => sum + ((v[type as keyof VolumePoint] as number) ?? 0), 0),
  })).sort((a, b) => b.total - a.total);

  if (!totals.length || totals.every((t) => t.total === 0)) return null;

  return (
    <section>
      <SectionLabel className="mb-4">Threat Type Totals</SectionLabel>
      <Card hover={false}>
        <ResponsiveContainer width="100%" height={totals.length * 40 + 20}>
          <BarChart data={totals} layout="vertical" margin={{ left: 120, right: 20, top: 5, bottom: 5 }}>
            <XAxis
              type="number"
              tick={{ fill: '#78A0C8', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
              axisLine={{ stroke: 'var(--border-base)' }}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fill: '#F0EDE8', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
              axisLine={false}
              tickLine={false}
              width={115}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const item = payload[0];
                return (
                  <div className="rounded-lg px-3 py-2 text-xs" style={{ background:'var(--bg-card)', backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)', border:'1px solid var(--border-base)', borderRadius:'0.75rem', boxShadow:'0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 var(--border-base)' }}>
                    <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{((item.value as number) ?? 0).toLocaleString()}</span>
                  </div>
                );
              }}
            />
            <Bar dataKey="total" radius={[0, 4, 4, 0]}>
              {totals.map((entry) => (
                <Cell key={entry.key} fill={THREAT_TYPE_COLORS[entry.key]} fillOpacity={0.8} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </section>
  );
}

/* ── Main Page ── */

function TrendsContent() {
  const [window, setWindow] = useState<string>('30d');
  const { data: volume, isLoading } = useThreatVolume(window);

  if (isLoading && !volume) return <PageLoader />;

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header + Time Filter */}
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Trends</h1>
        <div className="flex gap-1.5">
          {WINDOWS.map((w) => (
            <Button
              key={w}
              variant={window === w ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setWindow(w)}
            >
              {w.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>

      {/* Executive Summary */}
      <ExecutiveSummary period={window} />

      {/* Section 1: Intelligence Briefings */}
      <IntelligenceBriefings />

      {/* Section 2: Threat Volume */}
      <ThreatVolumeChart window={window} />

      {/* Section 3: Brand + Provider Momentum */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          <BrandRiskMomentum />
        </div>
        <div className="lg:col-span-2">
          <ProviderMomentumPanel />
        </div>
      </div>

      {/* Section 4: Threat Type Totals */}
      {volume?.length ? <ThreatTypeTotals volume={volume} /> : null}
    </div>
  );
}

export function Trends() {
  return (
    <ErrorBoundary>
      <TrendsContent />
    </ErrorBoundary>
  );
}
