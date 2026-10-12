import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useBotTraffic } from '@/hooks/useBotTraffic';
import type { BotTrafficDays } from '@/hooks/useBotTraffic';
import {
  Card, Button, PageHeader, PageState, StatTile, Table, Th, Td,
} from '@/design-system/components';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { cn } from '@/lib/cn';

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

/** Horizontal share bar scaled against the largest value in its list. */
function ShareBar({ pct, max }: { pct: number; max: number }) {
  const width = max > 0 ? Math.max(2, (pct / max) * 100) : 0;
  return (
    <div aria-hidden="true" className="h-1.5 w-full rounded-full" style={{ background: 'var(--border-base)' }}>
      <div className="h-full rounded-full" style={{ width: `${width}%`, background: 'var(--amber)' }} />
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
        <Card variant="critical">
          <div className="font-mono text-[10px] uppercase tracking-widest mb-2" style={{ color: 'var(--sev-critical)' }}>
            Last fetch error
          </div>
          <p className="text-sm break-words" style={{ color: 'var(--text-primary)' }}>{err}</p>
          {isPermissionError(err) ? (
            <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
              The Cloudflare API token (CF_API_TOKEN) likely needs the Radar Read permission.
            </p>
          ) : null}
        </Card>
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
    <Card variant="critical">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
          Couldn't refresh bot traffic. Showing the last loaded data.
        </p>
        <Button variant="secondary" size="sm" onClick={() => { void refetch(); }}>Retry</Button>
      </div>
    </Card>
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
  const asns = [...top_asns].sort((a, b) => a.rank - b.rank);
  const cats = [...categories].sort((a, b) => b.pct - a.pct);
  const catMax = cats[0]?.pct ?? 0;

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
        <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
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
          sub={topCountry ? `${fmtPct(topCountry.pct)} of automated traffic` : undefined}
        />
      </div>

      <section>
        <SectionLabel className="mb-4">Bot share over time</SectionLabel>
        <Card>
          {series.length < 2 ? (
            <p className="text-sm py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
              Not enough history yet to draw a trend. One snapshot is added per day.
            </p>
          ) : (
            <div role="img" aria-label={chartLabel}>
            <ResponsiveContainer width="100%" height={260} className="max-md:!h-[200px]">
              <AreaChart data={series}>
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--text-tertiary)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                  axisLine={{ stroke: 'var(--border-base)' }}
                  tickLine={false}
                  minTickGap={24}
                  tickFormatter={(v: string) => fmtShortDate(v)}
                />
                <YAxis
                  tick={{ fill: 'var(--text-tertiary)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <SectionLabel className="mb-4">Top bot-origin countries</SectionLabel>
          <Card>
            {locs.length === 0 ? (
              <p className="text-sm py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>No country data</p>
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
                        <Td className="py-1.5 font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>{l.rank}</Td>
                        <Td className="py-1.5" style={{ color: 'var(--text-primary)' }}>
                          {l.name} <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>{l.code}</span>
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
          <SectionLabel className="mb-4">Top bot-origin networks</SectionLabel>
          <Card>
            {asns.length === 0 ? (
              <p className="text-sm py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>No network data</p>
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
                        <Td className="py-1.5 font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>{a.rank}</Td>
                        <Td className="py-1.5" style={{ color: 'var(--text-primary)' }}>
                          {a.name} <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>AS{a.asn}</span>
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
        <SectionLabel className="mb-4">Verified-bot categories</SectionLabel>
        <Card>
          {cats.length === 0 ? (
            <p className="text-sm py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>No category data</p>
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
            <p className="mt-4 text-xs" style={{ color: 'var(--text-tertiary)' }}>Bars scaled to the largest category</p>
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
