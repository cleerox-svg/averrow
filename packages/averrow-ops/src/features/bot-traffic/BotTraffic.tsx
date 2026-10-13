import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useBotTraffic } from '@/hooks/useBotTraffic';
import type { BotTrafficAsOf, BotTrafficDays } from '@/hooks/useBotTraffic';
import {
  Banner, Card, Button, KitButton, PageHeader, PageState, StatTile, Table, Th, Td,
} from '@/design-system/components';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { cn } from '@/lib/cn';
import { isAboveAverage, formatBotShare, resolveGlobalAvg } from '@/features/observatory-v3/lib/bot-density';

const DENSITY_TABLE_ROWS = 20;

const RANGES: ReadonlyArray<{ days: BotTrafficDays; label: string }> = [
  { days: 7, label: '7D' },
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
];

const INTRO = 'Share of HTTP traffic on the Cloudflare network classified as automated. Source: Cloudflare Radar.';

const ACRONYMS: ReadonlySet<string> = new Set(['ai', 'api', 'seo', 'cdn', 'rss']);

/** AI_CRAWLER -> "AI crawler", SEARCH_ENGINE_CRAWLER -> "Search engine crawler". */
export function humanizeCategory(raw: string): string {
  const words = raw.replace(/[_-]+/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return raw;
  const out = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  const first = out[0] ?? '';
  out[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return out.join(' ');
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Short "Oct 12" label for a YYYY-MM-DD date, formatted in UTC (no day shift west of UTC). */
function fmtShortDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The section's as_of date when it differs from the bot_share date, else null.
 * Tolerates a missing as_of (old cached payload) or missing per-section dates.
 */
export function staleAsOf(
  asOf: Partial<BotTrafficAsOf> | null | undefined,
  key: Exclude<keyof BotTrafficAsOf, 'bot_share'>,
): string | null {
  const base = asOf?.bot_share;
  const section = asOf?.[key];
  if (!base || !section || section === base) return null;
  return section;
}

/** Muted "as of Oct 9" note with a subtle stale dot, shown beside a section label. */
function AsOfNote({ date }: { date: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[10px]"
      style={{ color: 'var(--text-secondary)' }}
      title={`This section was last updated ${fmtDate(date)}, earlier than the bot share figure`}
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: 'var(--sev-medium-text)' }}
      />
      <span>as of {fmtShortDate(date)}</span>
      <span className="sr-only"> (stale)</span>
    </span>
  );
}

/** Section heading for this page — the shared `.section-label` (AA-contrast amber). */
function PageSectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn('section-label', className)}>
      {children}
    </h3>
  );
}

function SectionHeader({ title, staleDate }: { title: string; staleDate: string | null }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <PageSectionLabel>{title}</PageSectionLabel>
      {staleDate ? <AsOfNote date={staleDate} /> : null}
    </div>
  );
}

function isPermissionError(msg: string): boolean {
  return /\b40[13]\b|radar read/i.test(msg);
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)', boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }}
    >
      <div className="font-mono mb-1" style={{ color: 'var(--text-secondary)' }}>{label ? fmtDate(label) : ''}</div>
      <div className="flex justify-between gap-4">
        <span style={{ color: 'var(--amber-text)' }}>Bot share</span>
        <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{fmtPct(payload[0]?.value ?? 0)}</span>
      </div>
    </div>
  );
}

/** Bar width (%) for an absolute 0–100 share: clamped, with a 2% sliver for any non-zero value. */
export function absoluteBarWidth(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(100, Math.max(2, pct));
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{children}</p>;
}

function NoDataYet() {
  return <p className="py-4 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>No data yet</p>;
}

interface AttackRow { code: string; name: string; pct: number; rank: number }

function AttackTable({ title, rows, staleDate }: { title: string; rows: AttackRow[]; staleDate: string | null }) {
  return (
    <div>
      {staleDate ? (
        <div className="mb-2 flex justify-end"><AsOfNote date={staleDate} /></div>
      ) : null}
      <Card>
        {rows.length === 0 ? (
          <NoDataYet />
        ) : (
          <div className="overflow-x-auto">
            <Table className="w-full text-sm">
              <caption className="sr-only">Attack {title.toLowerCase()} countries</caption>
              <thead>
                <tr>
                  <Th className="w-8">#</Th>
                  <Th>{title}</Th>
                  <Th className="text-right">Share</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <Td className="py-1.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{r.rank}</Td>
                    <Td className="py-1.5" style={{ color: 'var(--text-primary)' }}>
                      {r.name} <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{r.code}</span>
                    </Td>
                    <Td className="py-1.5 text-right font-mono" style={{ color: 'var(--text-primary)' }}>{fmtPct(r.pct)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Horizontal share bar: scaled against `max`, or on an absolute 0–100 scale with `absolute`. */
function ShareBar({ pct, max = 0, absolute = false, marker }: { pct: number; max?: number; absolute?: boolean; marker?: number }) {
  const width = absolute ? absoluteBarWidth(pct) : max > 0 ? Math.max(2, (pct / max) * 100) : 0;
  return (
    <div aria-hidden="true" className="relative h-1.5 w-full rounded-full" style={{ background: 'var(--border-base)' }}>
      <div className="h-full rounded-full" style={{ width: `${width}%`, background: 'var(--amber)' }} />
      {absolute && marker != null && Number.isFinite(marker) ? (
        <div
          className="absolute"
          style={{ left: `${Math.min(100, Math.max(0, marker))}%`, top: -2, bottom: -2, width: 1, background: 'var(--text-primary)' }}
        />
      ) : null}
    </div>
  );
}

function EmptyState({ err }: { err: string | null }) {
  return (
    <div className="space-y-4">
      <PageState
        kind="empty"
        title="No bot traffic data yet"
        description="The daily Cloudflare Radar feed hasn't produced data yet. It runs once a day; check back after the next fetch."
      />
      {err ? (
        <Banner
          tone="critical"
          aria-label="Last fetch error"
          title="The last bot traffic fetch failed"
          {...(isPermissionError(err) ? { details: <span className="break-words">{err}</span>, detailsTrigger: 'button' as const } : {})}
        >
          {isPermissionError(err)
            ? 'The Radar token likely lacks the Radar Read permission. Set a read-only CF_RADAR_API_TOKEN Worker secret (preferred), or add Radar Read to CF_API_TOKEN.'
            : <span className="break-words">{err}</span>}
        </Banner>
      ) : null}
    </div>
  );
}

function BotTrafficContent() {
  const [days, setDays] = useState<BotTrafficDays>(30);
  const { data, isError, isPlaceholderData, refetch } = useBotTraffic(days);

  if (isError && !data) {
    return (
      <PageState
        kind="error"
        title="Couldn't load bot traffic"
        onRetry={() => { void refetch(); }}
      />
    );
  }
  if (!data) return <PageState kind="loading" />;

  const { latest, series, top_locations, top_asns, categories } = data;
  const globalAvg = resolveGlobalAvg(data);

  const header = (
    <PageHeader
      title="Internet bot traffic"
      className="mb-0"
      actions={RANGES.map((r) => (
        <Button
          key={r.days}
          variant={days === r.days ? 'primary' : 'ghost'}
          size="sm"
          aria-pressed={days === r.days}
          aria-label={`Last ${r.days} days`}
          onClick={() => setDays(r.days)}
        >
          {r.label}
        </Button>
      ))}
    />
  );

  const retryBanner = isError ? (
    <Banner
      tone="medium"
      role="status"
      aria-label="Bot traffic refresh failed"
      title="Couldn't refresh bot traffic"
      actions={<KitButton size="sm" variant="secondary" onClick={() => { void refetch(); }}>Retry</KitButton>}
    >
      Showing the last loaded data.
    </Banner>
  ) : null;

  if (!latest) {
    return (
      <div className="animate-fade-in space-y-6">
        {header}
        {retryBanner}
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{INTRO}</p>
        <EmptyState err={data.last_fetch.last_error} />
      </div>
    );
  }

  const first = series[0];
  const delta = first ? latest.bot_pct - first.bot_pct : null;
  const deltaLabel = delta === null
    ? '—'
    : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp`;
  const locs = [...top_locations].sort((a, b) => a.rank - b.rank);
  const topCountry = locs[0];
  const locsStale = staleAsOf(data.as_of, 'top_locations');
  const asnsStale = staleAsOf(data.as_of, 'top_asns');
  const catsStale = staleAsOf(data.as_of, 'categories');
  const asns = [...top_asns].sort((a, b) => a.rank - b.rank);
  const cats = [...categories].sort((a, b) => b.pct - a.pct);
  const catMax = cats[0]?.pct ?? 0;
  // API returns every qualifying country (≤100, for the Observatory map); the table shows the top 20.
  const density = [...(data.bot_density ?? [])].sort((a, b) => a.rank - b.rank).slice(0, DENSITY_TABLE_ROWS);
  const originRows = [...(data.attack_origins ?? [])].sort((a, b) => a.rank - b.rank);
  const targetRows = [...(data.attack_targets ?? [])].sort((a, b) => a.rank - b.rank);
  const densityStale = staleAsOf(data.as_of, 'bot_density');
  const originsStale = staleAsOf(data.as_of, 'attack_origins');
  const targetsStale = staleAsOf(data.as_of, 'attack_targets');

  const lastPoint = series[series.length - 1];
  const chartLabel = first && lastPoint
    ? `Bot share of HTTP traffic over ${days} days, from ${fmtPct(first.bot_pct)} on ${fmtDate(first.date)} to ${fmtPct(lastPoint.bot_pct)} on ${fmtDate(lastPoint.date)}`
    : `Bot share of HTTP traffic over ${days} days`;

  return (
    <div className="animate-fade-in space-y-6">
      {header}
      {retryBanner}
      <div className={cn('space-y-6 transition-opacity', isPlaceholderData && 'opacity-60')} aria-busy={isPlaceholderData}>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {INTRO}{' '}
        <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
          Data as of {fmtDate(latest.snapshot_date)}.
        </span>
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Bot share" value={fmtPct(latest.bot_pct)} tone="amber" sub="Automated HTTP traffic" />
        <StatTile label="Human share" value={fmtPct(latest.human_pct)} tone="blue" sub="Human HTTP traffic" />
        <StatTile
          label={first ? `Change since ${fmtShortDate(first.date)}` : 'Change'}
          value={deltaLabel}
          tone="neutral"
          sub={first ? `${days}-day range` : 'Not enough history'}
        />
        <StatTile
          label="Top bot-origin country"
          value={topCountry ? topCountry.name : '—'}
          tone="red"
          sub={topCountry
            ? `${fmtPct(topCountry.pct)} of automated traffic${locsStale ? ` · as of ${fmtShortDate(locsStale)}` : ''}`
            : undefined}
        />
      </div>

      <section>
        <PageSectionLabel className="mb-4">Bot share over time</PageSectionLabel>
        <Card>
          {series.length < 2 ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-secondary)' }}>
              Not enough history yet to draw a trend. One snapshot is added per day.
            </p>
          ) : (
            <div role="img" aria-label={chartLabel}>
            <ResponsiveContainer width="100%" height={260} className="max-md:!h-[200px]">
              <AreaChart data={series}>
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                  axisLine={{ stroke: 'var(--border-base)' }}
                  tickLine={false}
                  minTickGap={24}
                  tickFormatter={(v: string) => fmtShortDate(v)}
                />
                <YAxis
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                  axisLine={false}
                  tickLine={false}
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => `${Math.round(v)}%`}
                  width={44}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="bot_pct"
                  name="Bot share"
                  stroke="var(--amber)"
                  strokeWidth={2}
                  fill="var(--amber)"
                  fillOpacity={0.2}
                />
              </AreaChart>
            </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>

      <section>
        <SectionHeader title="Bot density by country" staleDate={densityStale} />
        <Caption>
          Share of each country's own HTTP traffic that is automated. Top 20 shown; countries under 0.1% of global traffic are excluded. ≥ / ≤ marks an estimate bound for a country outside one of Radar's top-100 lists. All countries are on the Observatory's Bot density view.
        </Caption>
        <Card>
          {density.length === 0 ? (
            <NoDataYet />
          ) : (
            <>
              <p className="mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Global average:{' '}
                <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{fmtPct(globalAvg ?? latest.bot_pct)}</span>
                <span style={{ color: 'var(--text-secondary)' }}> · the bar tick marks it; ▲ marks countries above it</span>
              </p>
              <div className="overflow-x-auto">
                <Table className="w-full text-sm">
                  <caption className="sr-only">Bot share and traffic share by country</caption>
                  <thead>
                    <tr>
                      <Th className="w-8">#</Th>
                      <Th>Country</Th>
                      <Th className="text-right">Bot share</Th>
                      {/* Below sm the traffic share folds under the country name so
                          the table fits a 375px card without a hidden column. */}
                      <Th className="hidden sm:table-cell text-right">Traffic share</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {density.map((d) => {
                      const above = isAboveAverage(d.bot_pct, globalAvg, d.bound);
                      return (
                        <tr key={d.code}>
                          <Td className="py-1.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{d.rank}</Td>
                          <Td className="py-1.5" style={{ color: 'var(--text-primary)' }}>
                            {d.name} <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{d.code}</span>
                            <div className="sm:hidden font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                              {fmtPct(d.traffic_pct)} of traffic
                            </div>
                          </Td>
                          <Td className="py-1.5 text-right">
                            <div className="ml-auto w-20 sm:w-40">
                              <span
                                className="font-mono"
                                style={{ color: above ? 'var(--sev-medium-text)' : 'var(--text-primary)' }}
                              >
                                {formatBotShare(d.bot_pct, d.bound)}
                              </span>
                              {above ? (
                                <span aria-hidden="true" title="Above global average" className="ml-1" style={{ color: 'var(--sev-medium-text)' }}>▲</span>
                              ) : null}
                              {above ? <span className="sr-only"> (above global average)</span> : null}
                              <div className="mt-1">
                                <ShareBar pct={d.bot_pct} absolute marker={globalAvg ?? undefined} />
                              </div>
                            </div>
                          </Td>
                          <Td className="hidden sm:table-cell py-1.5 text-right font-mono" style={{ color: 'var(--text-secondary)' }}>{fmtPct(d.traffic_pct)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
              <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>Bars show absolute share, 0–100%</p>
            </>
          )}
        </Card>
      </section>

      <section>
        <PageSectionLabel className="mb-1">Attack origins vs targets</PageSectionLabel>
        <Caption>
          Layer-7 (HTTP) attacks seen by Cloudflare, last 7 days. Origin = attacking client's IP location; target = attacked site's country.
        </Caption>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AttackTable title="Origin" rows={originRows} staleDate={originsStale} />
          <AttackTable title="Target" rows={targetRows} staleDate={targetsStale} />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <SectionHeader title="Top bot-origin countries" staleDate={locsStale} />
          <Caption>
            Share of all automated traffic — reflects where bot infrastructure is hosted (cloud data centres), not who operates it.
          </Caption>
          <Card>
            {locs.length === 0 ? (
              <p className="text-sm py-4 text-center" style={{ color: 'var(--text-secondary)' }}>No country data</p>
            ) : (
              <div className="overflow-x-auto">
                <Table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th className="w-8">#</Th>
                      <Th>Country</Th>
                      <Th className="text-right">Share</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {locs.map((l) => (
                      <tr key={l.code}>
                        <Td className="py-1.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{l.rank}</Td>
                        <Td className="py-1.5" style={{ color: 'var(--text-primary)' }}>
                          {l.name} <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{l.code}</span>
                        </Td>
                        <Td className="py-1.5 text-right font-mono" style={{ color: 'var(--text-primary)' }}>{fmtPct(l.pct)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </Card>
        </section>

        <section>
          <SectionHeader title="Top bot-origin networks" staleDate={asnsStale} />
          <Caption>Share of all automated traffic, by network (ASN) — mostly cloud and hosting providers.</Caption>
          <Card>
            {asns.length === 0 ? (
              <p className="text-sm py-4 text-center" style={{ color: 'var(--text-secondary)' }}>No network data</p>
            ) : (
              <div className="overflow-x-auto">
                <Table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th className="w-8">#</Th>
                      <Th>Network</Th>
                      <Th className="text-right">Share</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {asns.map((a) => (
                      <tr key={a.asn}>
                        <Td className="py-1.5 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{a.rank}</Td>
                        <Td className="py-1.5" style={{ color: 'var(--text-primary)' }}>
                          {a.name} <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>AS{a.asn}</span>
                        </Td>
                        <Td className="py-1.5 text-right font-mono" style={{ color: 'var(--text-primary)' }}>{fmtPct(a.pct)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </Card>
        </section>
      </div>

      <section>
        <SectionHeader title="Verified-bot categories" staleDate={catsStale} />
        <Card>
          {cats.length === 0 ? (
            <p className="text-sm py-4 text-center" style={{ color: 'var(--text-secondary)' }}>No category data</p>
          ) : (
            <>
            <ul className="space-y-3">
              {cats.map((c) => (
                <li key={c.category}>
                  <div className="flex justify-between text-sm mb-1">
                    <span style={{ color: 'var(--text-primary)' }}>{humanizeCategory(c.category)}</span>
                    <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{fmtPct(c.pct)}</span>
                  </div>
                  <ShareBar pct={c.pct} max={catMax} />
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs" style={{ color: 'var(--text-secondary)' }}>Bars scaled to the largest category</p>
            </>
          )}
        </Card>
      </section>
      </div>
    </div>
  );
}

export function BotTraffic() {
  return (
    <ErrorBoundary>
      <BotTrafficContent />
    </ErrorBoundary>
  );
}
