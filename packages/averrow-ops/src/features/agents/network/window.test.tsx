import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TIMELINE_REFETCH_24H_MS, TIMELINE_REFETCH_MS, TIMELINE_WINDOW_MS, readStoredWindow, storeWindow, useAgentTimeline,
} from '@/hooks/useAgentTimeline';
import {
  SLIDER_STEPS, pagePlayhead, speedAria, speedLabel, stepPlayhead, REPLAY_SPEEDS, DEFAULT_REPLAY_SPEEDS,
} from './replay';
import {
  DAY_MS, barsForLane, mergeQuantumMs, tapeGeometry, tapeHitTest, tapePadMs, tapeTickMs, TAPE_WINDOW_MS,
} from './tape';
import { indexTimeline } from './activity';
import { FEEDS_FIXTURE, FIXTURE_NOW, TIMELINE_FIXTURE, makeBigTimeline } from './fixtures';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

const NOW = Date.parse(FIXTURE_NOW);

describe('useAgentTimeline', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it.each(['1h', '24h'] as const)('keys the query by window and requests it (%s)', async (w) => {
    get.mockResolvedValue({ success: true, data: { ...TIMELINE_FIXTURE, window: w } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAgentTimeline(w), { wrapper });
    await waitFor(() => expect(result.current.data?.window).toBe(w));
    expect(get).toHaveBeenCalledWith(`/api/agents/timeline?window=${w}`);
    expect(client.getQueryData(['agents', 'timeline', w])).toBeDefined();
    // invalidating ['agents'] (agent mutations) refreshes both windows
    expect(client.getQueryCache().findAll({ queryKey: ['agents'] }).length).toBeGreaterThan(0);
  });

  it('refetches the 24h payload less often than the hour', () => {
    expect(TIMELINE_REFETCH_MS).toBe(60_000);
    expect(TIMELINE_REFETCH_24H_MS).toBe(300_000);
    expect(TIMELINE_WINDOW_MS['24h']).toBe(24 * TIMELINE_WINDOW_MS['1h']);
  });

  it('remembers the window per viewer and tolerates blocked storage', () => {
    window.localStorage.clear();
    expect(readStoredWindow()).toBe('1h');
    storeWindow('24h');
    expect(readStoredWindow()).toBe('24h');
    window.localStorage.setItem('averrow.agents.timelineWindow', 'garbage');
    expect(readStoredWindow()).toBe('1h');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readStoredWindow()).toBe('1h');
    expect(() => storeWindow('24h')).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe('replay speeds and steps per window', () => {
  it('offers 1/10/60x on the hour and 60/600/3600x on 24h, with readable labels', () => {
    expect(REPLAY_SPEEDS['1h']).toEqual([1, 10, 60]);
    expect(REPLAY_SPEEDS['24h']).toEqual([60, 600, 3600]);
    expect(DEFAULT_REPLAY_SPEEDS).toEqual({ '1h': 10, '24h': 600 });
    expect(REPLAY_SPEEDS['24h'].map((s) => speedLabel('24h', s))).toEqual(['1 min/s', '10 min/s', '1 h/s']);
    expect(REPLAY_SPEEDS['1h'].map((s) => speedLabel('1h', s))).toEqual(['1×', '10×', '60×']);
    expect(REPLAY_SPEEDS['24h'].map((s) => speedAria('24h', s))).toEqual(['1 minute per second', '10 minutes per second', '1 hour per second']);
    expect(speedAria('1h', 10)).toBe('10 times speed');
  });

  it('steps 10 min / 1 min / 1 h on 24h and 1 min / 10 s on the hour', () => {
    const start = NOW - DAY_MS;
    const mid = NOW - 12 * 3600_000;
    expect(SLIDER_STEPS['24h']).toEqual({ coarse: 600_000, fine: 60_000, page: 3_600_000 });
    expect(stepPlayhead(mid, 1, false, start, NOW, '24h')).toBe(mid + 600_000);
    expect(stepPlayhead(mid, -1, true, start, NOW, '24h')).toBe(mid - 60_000);
    expect(pagePlayhead(mid, 1, start, NOW, '24h')).toBe(mid + 3_600_000);
    expect(pagePlayhead(mid, -1, start, NOW, '24h')).toBe(mid - 3_600_000);
    expect(pagePlayhead(mid, 1, start, NOW, '1h')).toBe(mid); // hour view: no paging
    expect(stepPlayhead(NOW - 5_000, 1, false, start, NOW, '24h')).toBe(NOW);
    const half = NOW - 1_800_000;
    expect(stepPlayhead(half, 1, false, NOW - 3_600_000, NOW)).toBe(half + 60_000); // default window: unchanged
  });
});

describe('24h tape geometry and bars', () => {
  it('scales the axis, the right padding and the grid with the window', () => {
    expect(tapePadMs(TAPE_WINDOW_MS)).toBe(90_000);
    expect(tapePadMs(DAY_MS)).toBe(DAY_MS * 0.025);
    expect(tapeTickMs(TAPE_WINDOW_MS)).toBe(600_000);
    expect(tapeTickMs(DAY_MS)).toBe(7_200_000);
    const g = tapeGeometry(1000, 10, NOW, DAY_MS);
    expect(g.startMs).toBe(NOW - DAY_MS);
    expect(g.t(g.x(NOW - 3 * 3600_000))).toBeCloseTo(NOW - 3 * 3600_000, 0);
    expect(tapeGeometry(1000, 10, NOW).startMs).toBe(NOW - TAPE_WINDOW_MS); // default unchanged
  });

  it('never merges on the hour view', () => {
    expect(mergeQuantumMs(TAPE_WINDOW_MS, 800)).toBe(0);
    const idx = indexTimeline(TIMELINE_FIXTURE, FEEDS_FIXTURE);
    expect(barsForLane(idx, 'navigator', 0)).toBe(idx.lanes.get('navigator'));
  });

  const big = makeBigTimeline();
  const idx = indexTimeline(big, FEEDS_FIXTURE);
  const quantum = mergeQuantumMs(DAY_MS, 800);

  it('merges sub-pixel neighbours so a dense lane stays under the plot width', () => {
    const spans = idx.lanes.get('feeds:ingest')!.length;
    const bars = barsForLane(idx, 'feeds:ingest', quantum);
    expect(spans).toBeGreaterThan(1500);
    expect(bars.length).toBeLessThan(800);
    expect(bars.length).toBeLessThan(spans / 3);
  });

  it('computes bars once per payload and width, not per frame', () => {
    expect(barsForLane(idx, 'feeds:ingest', quantum)).toBe(barsForLane(idx, 'feeds:ingest', quantum));
    expect(barsForLane(idx, 'feeds:ingest', quantum * 2)).not.toBe(barsForLane(idx, 'feeds:ingest', quantum));
  });

  it('keeps the worst status in a merged bar and hit-tests to its representative span', () => {
    const t0 = NOW - 3600_000;
    const mk = (id: number, off: number, status: 'success' | 'failed') => ({
      id, agent_id: 'sentinel', source: 'agent_runs' as const, started_at: new Date(t0 + off).toISOString(),
      completed_at: new Date(t0 + off + 2000).toISOString(), status, open: false, clipped_start: false,
      duration_ms: 2000, records_processed: 1, error: null,
    });
    const tl = { ...TIMELINE_FIXTURE, window: '24h' as const, pulls: [], events: [],
      runs: [mk(1, 0, 'success'), mk(2, 10_000, 'failed'), mk(3, 20_000, 'success')] };
    const index = indexTimeline(tl, FEEDS_FIXTURE);
    const bars = barsForLane(index, 'sentinel', quantum);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.status).toBe('failed');
    expect(bars[0]!.count).toBe(3);
    const g = tapeGeometry(1000, 1, NOW, DAY_MS);
    const hit = tapeHitTest(g, [{ id: 'sentinel', label: 'Sentinel', agent: true, muted: false }], index, NOW,
      g.x(t0 + 10_000), g.top + 5, quantum);
    expect(hit?.span?.id).toBe(2);
  });

  it('keeps total bars across a worst-case payload well below the span count', () => {
    let bars = 0;
    for (const lane of idx.lanes.keys()) bars += barsForLane(idx, lane, quantum).length;
    const spans = big.runs.length + big.pulls.length;
    expect(spans).toBe(10_000);
    expect(bars).toBeLessThan(spans * 0.8);
  });
});
