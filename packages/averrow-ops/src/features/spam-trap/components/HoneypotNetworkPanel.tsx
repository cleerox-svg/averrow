import { useState, useMemo } from 'react';
import { useSpamTrapAddresses, useSeedingSources } from '@/hooks/useSpamTrap';
import type { SeedAddress, SeedingSource } from '@/hooks/useSpamTrap';
import { Skeleton } from '@/components/ui/Skeleton';
import { Target, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/design-system/components';
import { relativeTime } from '@/lib/time';

// ─── Yield buckets ────────────────────────────────────────────────
//
// Replaces the binary "active/inactive" status dot with a four-bucket
// classification that surfaces what an operator actually wants to know:
// is this address productive, stale, dead, or too new to judge?
//
//   CAUGHT  — caught at least once in the last 30 days. Still hot.
//   STALE   — caught at some point but not in the last 30 days. May
//             have aged out of harvester lists.
//   DEAD    — seeded >30 days ago, has never caught anything. Channel
//             is unproductive or the seeding location wasn't harvested.
//   PENDING — seeded within the last 30 days, hasn't caught anything
//             yet. Too early to judge.
//
// The 30-day cutoff is arbitrary but matches the trap-data window used
// elsewhere (cube retention, agent_runs trend windows).

type YieldBucket = 'caught' | 'stale' | 'dead' | 'pending';

const BUCKET_LABEL: Record<YieldBucket, string> = {
  caught: 'Caught',
  stale: 'Stale',
  dead: 'Dead seeds',
  pending: 'Pending',
};

const BUCKET_DESCRIPTION: Record<YieldBucket, string> = {
  caught: 'caught a real email in the last 30 days',
  stale: 'caught at some point but quiet for >30 days',
  dead: 'seeded >30 days ago, never caught anything — channel is unproductive',
  pending: 'seeded recently, no captures yet — too early to judge',
};

const BUCKET_DOT_CLASS: Record<YieldBucket, string> = {
  caught: 'dot-pulse dot-pulse-green',
  stale: 'dot-pulse dot-pulse-amber',
  dead: 'inline-block w-1.5 h-1.5 rounded-full bg-red-400/60',
  pending: 'inline-block w-1.5 h-1.5 rounded-full bg-white/30',
};

const STALE_DAYS = 30;

function classifyAddress(addr: SeedAddress, nowMs: number): YieldBucket {
  if (addr.total_catches > 0 && addr.last_catch_at) {
    const lastMs = new Date(addr.last_catch_at).getTime();
    if (Number.isFinite(lastMs) && (nowMs - lastMs) / 86_400_000 <= STALE_DAYS) {
      return 'caught';
    }
    return 'stale';
  }
  // Never caught — pending vs dead depends on seed age.
  if (addr.seeded_at) {
    const seededMs = new Date(addr.seeded_at).getTime();
    if (Number.isFinite(seededMs) && (nowMs - seededMs) / 86_400_000 <= STALE_DAYS) {
      return 'pending';
    }
  }
  return 'dead';
}

function daysAgo(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  return relativeTime(iso);
}

const CHANNEL_COLORS: Record<string, string> = {
  employee: '#E5A832',
  contact_page: '#A78BFA',
  whois: '#fb923c',
  forum: '#4ADE80',
  generic: 'rgba(255,255,255,0.3)',
};

const SOURCE_COLORS: Record<string, string> = {
  spider: '#E5A832',
  broker: '#A78BFA',
  paste: '#fb923c',
  honeypot: '#f87171',
  directory: '#4ADE80',
};

const BUCKET_ORDER: YieldBucket[] = ['caught', 'stale', 'pending', 'dead'];

// Default-expanded buckets — the productive ones. `dead` stays collapsed
// because there are typically dozens to hundreds of dead seeds and
// scrolling them is exactly what we're trying to eliminate.
const DEFAULT_EXPANDED: YieldBucket[] = ['caught', 'stale'];

export function HoneypotNetworkPanel() {
  const { data: addresses, isLoading, isError, refetch } = useSpamTrapAddresses();
  const { data: seedingData } = useSeedingSources();
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'network' | 'sources' | 'activity'>('network');
  const [expanded, setExpanded] = useState<Set<YieldBucket>>(new Set(DEFAULT_EXPANDED));
  const [expandedSources, setExpandedSources] = useState<Set<YieldBucket>>(new Set(DEFAULT_EXPANDED));

  const toggleBucket = (b: YieldBucket): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  };
  const toggleSourceBucket = (b: YieldBucket): void => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  };

  const filtered = useMemo(() => {
    if (!addresses) return [];
    if (!search.trim()) return addresses;
    const q = search.toLowerCase();
    return addresses.filter(
      (a: SeedAddress) =>
        a.address.toLowerCase().includes(q) ||
        a.domain.toLowerCase().includes(q) ||
        a.channel.toLowerCase().includes(q),
    );
  }, [addresses, search]);

  // Bucket every filtered address by yield. Sort within each bucket by
  // recency: caught/stale by last_catch_at desc, pending/dead by
  // seeded_at desc (newest seeds first so old dead seeds drop to the
  // bottom).
  const buckets = useMemo(() => {
    const nowMs = Date.now();
    const result: Record<YieldBucket, SeedAddress[]> = {
      caught: [], stale: [], pending: [], dead: [],
    };
    for (const a of filtered) {
      result[classifyAddress(a, nowMs)].push(a);
    }
    const sortByRecentCatch = (a: SeedAddress, b: SeedAddress): number =>
      new Date(b.last_catch_at ?? 0).getTime() - new Date(a.last_catch_at ?? 0).getTime();
    const sortBySeed = (a: SeedAddress, b: SeedAddress): number =>
      new Date(b.seeded_at ?? 0).getTime() - new Date(a.seeded_at ?? 0).getTime();
    result.caught.sort(sortByRecentCatch);
    result.stale.sort(sortByRecentCatch);
    result.pending.sort(sortBySeed);
    result.dead.sort(sortBySeed);
    return result;
  }, [filtered]);

  // Per-channel: total seeded vs how many ever caught at least one
  // email. Surfaces the productivity-by-channel signal that was hidden
  // by the green-dot status column ("everything's healthy" → reality:
  // most channels never catch anything).
  const channelCounts = useMemo(() => {
    if (!addresses) return [] as Array<{ channel: string; seeded: number; productive: number }>;
    const map: Record<string, { seeded: number; productive: number }> = {};
    for (const a of addresses) {
      if (!map[a.channel]) map[a.channel] = { seeded: 0, productive: 0 };
      map[a.channel].seeded += 1;
      if (a.total_catches > 0) map[a.channel].productive += 1;
    }
    return Object.entries(map)
      .map(([channel, v]) => ({ channel, ...v }))
      .sort((a, b) => b.seeded - a.seeded);
  }, [addresses]);

  const maxCount = channelCounts.length > 0 ? channelCounts[0].seeded : 1;

  // Group seeding sources by type prefix (spider:*, broker:*, etc).
  // Tracks productive_count (locations of this type with at least one
  // catch) so the source-type bar chart can show working vs dead types.
  const seedingGroups = useMemo(() => {
    if (!seedingData?.sources) return [];
    const groups: Record<
      string,
      { seeds: number; catches: number; productive_locations: number; total_locations: number }
    > = {};
    for (const s of seedingData.sources) {
      const prefix = s.location.split(':')[0] || 'other';
      if (!groups[prefix]) {
        groups[prefix] = { seeds: 0, catches: 0, productive_locations: 0, total_locations: 0 };
      }
      groups[prefix].seeds += s.seeds;
      groups[prefix].catches += s.catches;
      groups[prefix].total_locations += 1;
      if (s.catches > 0) groups[prefix].productive_locations += 1;
    }
    return Object.entries(groups).sort((a, b) => b[1].seeds - a[1].seeds);
  }, [seedingData]);

  const maxSourceSeeds = seedingGroups.length > 0 ? seedingGroups[0][1].seeds : 1;

  // Bucket each individual seeding location by yield, mirroring the
  // address-level classifier in classifyAddress(). Location-level
  // counts surface which paste sites / forums / GitHub repos / WHOIS
  // entries are actually productive vs dead weight, so PR (b)'s
  // seeding-at-scale job knows which vectors to lean into.
  const locationBuckets = useMemo(() => {
    const result: Record<YieldBucket, SeedingSource[]> = {
      caught: [], stale: [], pending: [], dead: [],
    };
    if (!seedingData?.sources) return result;
    const nowMs = Date.now();
    for (const s of seedingData.sources) {
      let bucket: YieldBucket;
      if (s.catches > 0 && s.last_catch_at) {
        const lastMs = new Date(s.last_catch_at).getTime();
        bucket = Number.isFinite(lastMs) && (nowMs - lastMs) / 86_400_000 <= STALE_DAYS
          ? 'caught'
          : 'stale';
      } else if (s.earliest_seed) {
        const seedMs = new Date(s.earliest_seed).getTime();
        bucket = Number.isFinite(seedMs) && (nowMs - seedMs) / 86_400_000 <= STALE_DAYS
          ? 'pending'
          : 'dead';
      } else {
        bucket = 'pending';
      }
      result[bucket].push(s);
    }
    // Caught/stale: most-recent catch first. Pending/dead: oldest seed
    // first so the longest-stale dead locations bubble to top — those
    // are the highest-priority candidates for replanting.
    const sortByCatch = (a: SeedingSource, b: SeedingSource): number =>
      new Date(b.last_catch_at ?? 0).getTime() - new Date(a.last_catch_at ?? 0).getTime();
    const sortBySeed = (a: SeedingSource, b: SeedingSource): number =>
      new Date(a.earliest_seed ?? 0).getTime() - new Date(b.earliest_seed ?? 0).getTime();
    result.caught.sort(sortByCatch);
    result.stale.sort(sortByCatch);
    result.pending.sort(sortBySeed);
    result.dead.sort(sortBySeed);
    return result;
  }, [seedingData]);

  const handleSearch = (val: string) => {
    setSearch(val);
  };

  if (isError) {
    return (
      <div
        className="rounded-xl p-4 min-h-[400px] flex flex-col items-center justify-center gap-3"
        style={{
          background: 'rgba(15,23,42,0.50)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
        }}
      >
        <span className="text-white/40 text-sm font-mono">Unable to load seed addresses</span>
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-mono text-white/60 transition-colors"
        >
          RETRY
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl p-4 min-h-[400px]"
      style={{
        background: 'rgba(15,23,42,0.50)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.07)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="font-mono text-[9px] uppercase tracking-widest text-[rgba(255,255,255,0.42)]">
          Honeypot Network
        </div>
        <div className="flex gap-1">
          {(['network', 'sources', 'activity'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider transition-colors ${
                activeTab === tab
                  ? 'bg-white/10 text-white/80'
                  : 'text-white/50 hover:text-white/70'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* ── TAB: NETWORK (original channel bars + address table) ── */}
      {activeTab === 'network' && (
        <>
          {/* Channel breakdown bars */}
          {isLoading ? (
            <div className="space-y-2 mb-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-1.5 mb-4">
              <div className="font-mono text-[9px] uppercase tracking-widest text-white/50 mb-1">
                Seeds by Channel
              </div>
              {channelCounts.map(({ channel, seeded, productive }) => (
                <div key={channel} className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-white/50 w-[100px] truncate">
                    {channel}
                  </span>
                  <div className="flex-1 h-4 bg-white/5 rounded-sm overflow-hidden relative">
                    <div
                      className="h-full rounded-sm transition-all"
                      style={{
                        width: `${(seeded / maxCount) * 100}%`,
                        backgroundColor: CHANNEL_COLORS[channel] || 'rgba(255,255,255,0.3)',
                        opacity: productive > 0 ? 1 : 0.35,
                      }}
                    />
                  </div>
                  <span
                    className="font-mono text-[10px] w-[44px] text-right tabular-nums"
                    style={{ color: productive > 0 ? '#4ADE80' : 'rgba(255,255,255,0.30)' }}
                    title={`${productive} of ${seeded} addresses on this channel have caught at least once`}
                  >
                    {productive}/{seeded}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Search */}
          <div className="mb-3">
            <Input
              type="text"
              placeholder="Search address, domain, or channel..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="text-xs"
            />
          </div>
        </>
      )}

      {/* ── TAB: SEEDING SOURCES ── */}
      {activeTab === 'sources' && (
        <div className="space-y-4">
          {/* Source type breakdown — productive_locations / total_locations */}
          <div className="space-y-1.5">
            <div className="font-mono text-[9px] uppercase tracking-widest text-white/50 mb-1">
              Seeds by Source Type
            </div>
            {seedingGroups.map(([type, data]) => (
              <div key={type} className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-white/50 w-[80px] truncate capitalize">
                  {type}
                </span>
                <div className="flex-1 h-4 bg-white/5 rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm transition-all"
                    style={{
                      width: `${(data.seeds / maxSourceSeeds) * 100}%`,
                      backgroundColor: SOURCE_COLORS[type] || 'rgba(255,255,255,0.3)',
                      opacity: data.productive_locations > 0 ? 1 : 0.35,
                    }}
                  />
                </div>
                <span
                  className="font-mono text-[10px] w-[44px] text-right tabular-nums"
                  style={{ color: data.productive_locations > 0 ? '#4ADE80' : 'rgba(255,255,255,0.30)' }}
                  title={`${data.productive_locations} of ${data.total_locations} locations on this source type have caught at least once`}
                >
                  {data.productive_locations}/{data.total_locations}
                </span>
              </div>
            ))}
          </div>

          {/* Per-location yield buckets */}
          {seedingData?.sources && seedingData.sources.length > 0 && (
            <div className="space-y-2">
              {BUCKET_ORDER.map((bucket) => {
                const items = locationBuckets[bucket];
                if (items.length === 0) return null;
                const isOpen = expandedSources.has(bucket);
                const accent =
                  bucket === 'caught' ? '#4ADE80'
                  : bucket === 'stale' ? '#fbbf24'
                  : bucket === 'pending' ? 'rgba(255,255,255,0.45)'
                  : '#f87171';
                return (
                  <div key={bucket} className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                    <button
                      onClick={() => toggleSourceBucket(bucket)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] transition-colors text-left"
                    >
                      {isOpen
                        ? <ChevronDown className="w-3.5 h-3.5 text-white/50 shrink-0" />
                        : <ChevronRight className="w-3.5 h-3.5 text-white/50 shrink-0" />}
                      <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: accent }}>
                        {BUCKET_LABEL[bucket]}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums" style={{ color: accent }}>
                        {items.length}
                      </span>
                      <span className="font-mono text-[9px] text-white/35 truncate">
                        — locations {bucket === 'dead' ? 'with seeds older than 30d and zero catches' : BUCKET_DESCRIPTION[bucket]}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="border-t border-white/[0.04] divide-y divide-white/[0.03]">
                        {items.map((s) => {
                          const yieldPct = s.seeds > 0 ? Math.round((s.catches / s.seeds) * 100) : 0;
                          return (
                            <div
                              key={s.location}
                              className="flex items-center justify-between gap-3 px-3 py-1.5"
                              title={`Seeds: ${s.seeds} · Productive: ${s.productive_count} · First seeded: ${daysAgo(s.earliest_seed, Date.now())} · Last catch: ${daysAgo(s.last_catch_at, Date.now())}`}
                            >
                              <span className="font-mono text-[10px] text-white/65 truncate flex-1">
                                {s.location}
                              </span>
                              <div className="flex items-center gap-3 shrink-0 tabular-nums">
                                <span className="font-mono text-[10px] text-white/35">
                                  {s.productive_count}/{s.seeds}
                                </span>
                                <span
                                  className="font-mono text-[10px] w-12 text-right"
                                  style={{
                                    color: s.catches > 0 ? '#f87171' : 'rgba(255,255,255,0.20)',
                                    fontWeight: s.catches > 0 ? 600 : 400,
                                  }}
                                >
                                  {s.catches > 0 ? `${s.catches} catch` : '—'}
                                </span>
                                <span className="font-mono text-[10px] w-10 text-right text-white/45">
                                  {s.catches > 0 ? `${yieldPct}%` : '—'}
                                </span>
                                <span className="font-mono text-[10px] w-14 text-right text-white/40">
                                  {daysAgo(s.last_catch_at, Date.now())}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {seedingGroups.length === 0 && (
            <EmptyState
              icon={<Target />}
              title="No seeding source data"
              subtitle="Source data will populate as honeypot addresses are discovered"
              variant="scanning"
              compact
            />
          )}
        </div>
      )}

      {/* ── TAB: HONEYPOT ACTIVITY ── */}
      {activeTab === 'activity' && (
        <div className="space-y-4">
          {/* Activity summary */}
          {seedingData?.honeypot_visits && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3 text-center">
                  <div className="font-mono text-xl font-bold text-white/90">{seedingData.honeypot_visits.total}</div>
                  <div className="font-mono text-[9px] text-white/40 uppercase tracking-wider mt-0.5">Total Visits</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3 text-center">
                  <div className="font-mono text-xl font-bold text-red-400">{seedingData.honeypot_visits.bots}</div>
                  <div className="font-mono text-[9px] text-white/40 uppercase tracking-wider mt-0.5">Bot Visits</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3 text-center">
                  <div className="font-mono text-xl font-bold text-[#E5A832]">{seedingData.honeypot_visits.last_24h}</div>
                  <div className="font-mono text-[9px] text-white/40 uppercase tracking-wider mt-0.5">Last 24h</div>
                </div>
                <div className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3 text-center">
                  <div className="font-mono text-xl font-bold text-white/90">{seedingData.honeypot_visits.unique_bots}</div>
                  <div className="font-mono text-[9px] text-white/40 uppercase tracking-wider mt-0.5">Unique Bots</div>
                </div>
              </div>

              {seedingData.honeypot_visits.total > 0 && (
                <p className="text-[11px] text-white/40 font-mono text-center">
                  Your honeypots have been crawled {seedingData.honeypot_visits.total} times by {seedingData.honeypot_visits.unique_bots} unique bots
                </p>
              )}

              {/* Visits by page */}
              {seedingData.honeypot_visits.by_page.length > 0 && (
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-widest text-white/50 mb-2">
                    Visits by Page
                  </div>
                  {seedingData.honeypot_visits.by_page.map((p) => (
                    <div key={p.page} className="flex items-center justify-between py-1.5 border-b border-white/[0.03]">
                      <span className="font-mono text-[11px] text-white/60">{p.page}</span>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[10px] text-white/40">{p.visits} visits</span>
                        <span className="font-mono text-[10px] text-red-400">{p.bots} bots</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Recent crawlers */}
              {seedingData.honeypot_visits.recent_crawlers.length > 0 && (
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-widest text-white/50 mb-2">
                    Recent Crawlers
                  </div>
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {seedingData.honeypot_visits.recent_crawlers.map((c, i) => (
                      <div key={i} className="rounded-lg bg-white/[0.02] border border-white/[0.05] px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[10px] text-red-400 font-semibold">
                            {c.bot_name || 'unknown'}
                          </span>
                          <span className="font-mono text-[9px] text-white/50">
                            {c.visited_at ? new Date(c.visited_at + 'Z').toLocaleString() : '—'}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="font-mono text-[10px] text-white/50">{c.page}</span>
                          {c.visitor_ip && (
                            <span className="font-mono text-[10px] text-white/50">{c.visitor_ip}</span>
                          )}
                          {c.country && (
                            <span className="font-mono text-[10px] text-white/50">{c.country}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {!seedingData?.honeypot_visits && (
            <div className="text-center py-6">
              <span className="text-white/40 text-xs font-mono">No honeypot visit data yet</span>
            </div>
          )}
        </div>
      )}

      {/* Collapsible bucket groups — only on network tab */}
      {activeTab === 'network' && (
        <>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={search ? <Search /> : <Target />}
              title={search ? 'No matching addresses' : 'No seed addresses deployed'}
              subtitle={search
                ? 'Try a different search term'
                : 'Deploy honeypot email addresses to start capturing threat actor reconnaissance'}
              variant={search ? 'clean' : 'scanning'}
              compact
            />
          ) : (
            <div className="space-y-2">
              {BUCKET_ORDER.map((bucket) => {
                const items = buckets[bucket];
                if (items.length === 0) return null;
                const isOpen = expanded.has(bucket);
                const accent =
                  bucket === 'caught' ? '#4ADE80'
                  : bucket === 'stale' ? '#fbbf24'
                  : bucket === 'pending' ? 'rgba(255,255,255,0.45)'
                  : '#f87171';
                return (
                  <div key={bucket} className="rounded-lg border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                    <button
                      onClick={() => toggleBucket(bucket)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.03] transition-colors text-left"
                    >
                      {isOpen
                        ? <ChevronDown className="w-3.5 h-3.5 text-white/50 shrink-0" />
                        : <ChevronRight className="w-3.5 h-3.5 text-white/50 shrink-0" />}
                      <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: accent }}>
                        {BUCKET_LABEL[bucket]}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums" style={{ color: accent }}>
                        {items.length}
                      </span>
                      <span
                        className="font-mono text-[9px] text-white/35 truncate"
                        title={BUCKET_DESCRIPTION[bucket]}
                      >
                        — {BUCKET_DESCRIPTION[bucket]}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="overflow-x-auto border-t border-white/[0.04]">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="border-b border-white/[0.06]">
                              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pl-3 pb-1.5 pt-1.5 pr-2">Address</th>
                              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 pt-1.5 pr-2">Channel</th>
                              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 pt-1.5 pr-2">Location</th>
                              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 pt-1.5 pr-2">Catches</th>
                              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 pt-1.5 pr-2">Last catch</th>
                              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 pt-1.5 pr-2">Seeded</th>
                              <th className="font-mono text-[9px] uppercase tracking-wider text-white/50 pb-1.5 pt-1.5 pr-3"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((addr) => {
                              const nowMs = Date.now();
                              const addrBucket = classifyAddress(addr, nowMs);
                              return (
                                <tr key={addr.id} className="border-b border-white/[0.03] last:border-b-0 hover:bg-white/[0.02] transition-colors">
                                  <td className="py-1.5 pl-3 pr-2">
                                    <span
                                      className="font-mono text-[11px] text-[rgba(255,255,255,0.74)] block truncate max-w-[200px]"
                                      title={addr.address}
                                    >
                                      {addr.address.length > 30 ? addr.address.slice(0, 30) + '…' : addr.address}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-2">
                                    <span
                                      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                                      style={{
                                        background: 'var(--bg-input)',
                                        border: '1px solid var(--border-base)',
                                        color: CHANNEL_COLORS[addr.channel] || 'var(--text-secondary)',
                                      }}
                                    >
                                      {addr.channel}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-2">
                                    <span
                                      className="text-[11px] text-white/40 block truncate max-w-[180px]"
                                      title={addr.seeded_location || ''}
                                    >
                                      {addr.seeded_location
                                        ? addr.seeded_location.length > 28
                                          ? addr.seeded_location.slice(0, 28) + '…'
                                          : addr.seeded_location
                                        : '—'}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-2">
                                    {addr.total_catches > 0 ? (
                                      <span className="font-mono text-[11px] text-red-400 font-semibold tabular-nums">{addr.total_catches}</span>
                                    ) : (
                                      <span className="font-mono text-[11px] text-white/30">—</span>
                                    )}
                                  </td>
                                  <td className="py-1.5 pr-2">
                                    <span
                                      className="font-mono text-[11px] text-white/55 tabular-nums"
                                      title={addr.last_catch_at ?? 'never'}
                                    >
                                      {daysAgo(addr.last_catch_at, Date.now())}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-2">
                                    <span
                                      className="font-mono text-[11px] text-white/40 tabular-nums"
                                      title={addr.seeded_at ?? 'unknown'}
                                    >
                                      {daysAgo(addr.seeded_at, Date.now())}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-3 text-right">
                                    <span
                                      className={BUCKET_DOT_CLASS[addrBucket]}
                                      title={`${BUCKET_LABEL[addrBucket]}: ${BUCKET_DESCRIPTION[addrBucket]}`}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
