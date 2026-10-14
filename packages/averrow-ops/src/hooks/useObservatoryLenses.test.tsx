import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const fetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a) } }));

import {
  useOperationsGeo, useMovements, useProvidersGeo, useOverindex, useCampaignsGeo, useObservatoryTimeline,
  useActorList, useActorDetail, overindexPeriod, readLensMeta, useVelocityNodes,
} from './useObservatoryLenses';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const urls = () => fetchMock.mock.calls.map(c => c[0] as string);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ success: true, data: [], meta: { generated_at: '2026-10-14T00:00:00Z', period: '7d', radar_snapshot_date: '2026-10-13' } });
});

describe('lens hooks request the right endpoint with the right params', () => {
  it.each([
    ['operations-geo', () => useOperationsGeo(), '/api/observatory/operations-geo?status=active&limit=50'],
    ['movements', () => useMovements({ period: '30d' }), '/api/observatory/movements?period=30d&limit=50'],
    ['providers-geo', () => useProvidersGeo(), '/api/observatory/providers-geo?limit=100'],
    ['providers-geo bulletproof', () => useProvidersGeo({ bulletproof: true, limit: 500 }), '/api/observatory/providers-geo?limit=200&bulletproof=1'],
    ['overindex 7d', () => useOverindex({ period: '24h' }), '/api/observatory/overindex?period=7d'],
    ['overindex 30d', () => useOverindex({ period: '90d' }), '/api/observatory/overindex?period=30d'],
    ['campaigns-geo', () => useCampaignsGeo(), '/api/observatory/campaigns-geo'],
    ['timeline', () => useObservatoryTimeline({ period: '24h', source: 'feeds', country: 'NL' }), '/api/observatory/timeline?period=24h&source_feed=feeds&country=NL'],
    ['timeline (all sources, no country)', () => useObservatoryTimeline({ period: '7d' }), '/api/observatory/timeline?period=7d'],
    ['velocity nodes (all flags by default)', () => useVelocityNodes(), '/api/observatory/velocity-nodes?period=7d&flag=all'],
    ['velocity nodes, one flag', () => useVelocityNodes({ period: '30d', flag: 'very_fast' }), '/api/observatory/velocity-nodes?period=30d&flag=very_fast'],
    ['timeline with velocity', () => useObservatoryTimeline({ period: '30d', velocity: 'all' }), '/api/observatory/timeline?period=30d&velocity=all'],
    ['actors list', () => useActorList(), '/api/observatory/actors'],
    ['actor detail', () => useActorDetail('apt 1'), '/api/observatory/actors?actor_id=apt+1'],
  ])('%s', async (_name, hook, url) => {
    renderHook(hook as () => unknown, { wrapper: wrapper() });
    await waitFor(() => expect(urls()).toContain(url));
  });
});

describe('gating', () => {
  it('a disabled lens issues no request', async () => {
    renderHook(() => ({
      a: useOperationsGeo({ enabled: false }), b: useMovements({ enabled: false }), c: useProvidersGeo({ enabled: false }),
      d: useOverindex({ enabled: false }), e: useCampaignsGeo({ enabled: false }), f: useObservatoryTimeline({ enabled: false }),
      g: useActorList({ enabled: false }), h: useActorDetail(null), i: useVelocityNodes({ enabled: false }),
    }), { wrapper: wrapper() });
    await new Promise(r => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('actor detail needs an id even when enabled', async () => {
    renderHook(() => useActorDetail(null, { enabled: true }), { wrapper: wrapper() });
    await new Promise(r => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('results', () => {
  it('exposes the payload and the envelope meta', async () => {
    fetchMock.mockResolvedValue({ success: true, data: [{ country_code: 'NL' }], meta: { generated_at: 'g', period: '30d', radar_snapshot_date: '2026-10-13' } });
    const { result } = renderHook(() => useOverindex({ period: '30d' }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.data).toEqual([{ country_code: 'NL' }]);
    expect(result.current.data?.meta).toMatchObject({ generated_at: 'g', period: '30d', radar_snapshot_date: '2026-10-13' });
    expect(result.current.isLoading).toBe(false);
  });

  it('surfaces a failed request as an error (no data)', async () => {
    fetchMock.mockResolvedValue({ success: false, error: 'boom' });
    const { result } = renderHook(() => useOperationsGeo(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBeUndefined();
  });

  it('a different actor is never shown the previous actor\'s data while loading', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve({ success: true, data: { actor: { id: url.includes('a1') ? 'a1' : 'a2' } } }));
    const { result, rerender } = renderHook(({ id }) => useActorDetail(id), { wrapper: wrapper(), initialProps: { id: 'a1' } });
    await waitFor(() => expect(result.current.data?.data.actor.id).toBe('a1'));
    fetchMock.mockImplementation(() => new Promise(() => {})); // a2 never resolves
    rerender({ id: 'a2' });
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the previous timeline on screen while a new period loads', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve({ success: true, data: { bucket: '1h', points: [{ t: url.includes('24h') ? 'a' : 'b' }] } }));
    const { result, rerender } = renderHook(({ p }) => useObservatoryTimeline({ period: p }), { wrapper: wrapper(), initialProps: { p: '7d' } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    fetchMock.mockImplementation(() => new Promise(() => {}));
    rerender({ p: '24h' });
    expect(result.current.data).toBeDefined();
    expect(result.current.isUpdating).toBe(true);
  });
});

describe('velocity', () => {
  it('never sends a source with velocity (the server answers 400 for both)', async () => {
    renderHook(() => useObservatoryTimeline({ period: '7d', source: 'spam_trap', velocity: 'all', country: 'NL' }), { wrapper: wrapper() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(urls()).toEqual(['/api/observatory/timeline?period=7d&country=NL&velocity=all']);
  });
  it('a severity timeline is never shown as the velocity series (or the reverse) while the other loads', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve({ success: true, data: { bucket: '1h', points: [{ t: url.includes('velocity') ? 'v' : 's' }] } }));
    const { result, rerender } = renderHook(({ v }) => useObservatoryTimeline({ period: '7d', velocity: v }), { wrapper: wrapper(), initialProps: { v: null as 'all' | null } });
    await waitFor(() => expect(result.current.data?.data.points[0]).toEqual({ t: 's' }));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    rerender({ v: 'all' });
    expect(result.current.data).toBeUndefined();
  });
  it('still keeps the previous period of the SAME series on screen', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve({ success: true, data: { bucket: '1h', points: [{ t: url.includes('24h') ? 'a' : 'b' }] } }));
    const { result, rerender } = renderHook(({ p }) => useObservatoryTimeline({ period: p, velocity: 'all' }), { wrapper: wrapper(), initialProps: { p: '7d' } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    fetchMock.mockImplementation(() => new Promise(() => {}));
    rerender({ p: '24h' });
    expect(result.current.data).toBeDefined();
    expect(result.current.isUpdating).toBe(true);
  });
  it('velocity-nodes exposes dropped_no_centroid from the envelope', async () => {
    fetchMock.mockResolvedValue({ success: true, data: [], meta: { flag: 'all', dropped_no_centroid: 4 } });
    const { result } = renderHook(() => useVelocityNodes(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.meta.dropped_no_centroid).toBe(4);
    expect(result.current.data?.data).toEqual([]); // empty is a valid answer: the UI words it as "coverage still filling"
  });
});

describe('helpers', () => {
  it('overindexPeriod maps the page period onto the two the endpoint supports', () => {
    expect(overindexPeriod('24h')).toBe('7d');
    expect(overindexPeriod('7d')).toBe('7d');
    expect(overindexPeriod('30d')).toBe('30d');
    expect(overindexPeriod('90d')).toBe('30d');
  });
  it('readLensMeta tolerates anything', () => {
    expect(readLensMeta(undefined)).toEqual({ generated_at: null, period: null, radar_snapshot_date: null, source_feed: null, country: null, dropped_no_centroid: null });
    expect(readLensMeta({ generated_at: 5, period: '7d' })).toMatchObject({ generated_at: null, period: '7d' });
  });
});
