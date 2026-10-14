import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const fetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a) } }));

import {
  useObservatoryThreats, useObservatoryStats, useObservatoryArcs, useObservatoryHeatmap, useObservatoryLive,
  observatoryKeys, buildObservatoryUrl, sourceParam, clampLimit, refreshObservatory,
} from './useObservatory';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}
function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const ok = <T,>(data: T) => Promise.resolve({ success: true, data });
const urls = () => fetchMock.mock.calls.map(c => c[0] as string);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => ok([]));
});

describe('url + key helpers', () => {
  it('omits empty / undefined params and the "all" source', () => {
    expect(buildObservatoryUrl('/x', { a: 1, b: undefined, c: '' })).toBe('/x?a=1');
    expect(buildObservatoryUrl('/x', {})).toBe('/x');
    expect(sourceParam('all')).toBeUndefined();
    expect(sourceParam('feeds')).toBe('feeds');
  });
  it('clamps limits to the documented 1..2000 range', () => {
    expect(clampLimit(5000, 1, 2000)).toBe(2000);
    expect(clampLimit(0, 1, 2000)).toBe(1);
    expect(clampLimit(10.9, 1, 2000)).toBe(10);
    expect(clampLimit(Number.NaN, 1, 2000)).toBe(2000);
  });
  it('keys include period + source so they cannot collide', () => {
    expect(observatoryKeys.nodes('7d', 'all', 2000)).not.toEqual(observatoryKeys.nodes('24h', 'all', 2000));
    expect(observatoryKeys.arcs('7d', 'feeds')).not.toEqual(observatoryKeys.arcs('7d', 'all'));
  });
});

describe('gating', () => {
  it('does not fetch when enabled is false', async () => {
    const qc = makeClient();
    const { result } = renderHook(
      () => ({
        heat: useObservatoryHeatmap({ period: '7d', enabled: false }),
        arcs: useObservatoryArcs({ period: '7d', enabled: false }),
      }),
      { wrapper: wrap(qc) },
    );
    await new Promise(r => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.heat.isLoading).toBe(false);
    expect(result.current.heat.data).toBeUndefined();
  });

  it('starts fetching when enabled flips on', async () => {
    const qc = makeClient();
    const { rerender } = renderHook(({ on }) => useObservatoryHeatmap({ period: '30d', source: 'feeds', enabled: on }), {
      wrapper: wrap(qc), initialProps: { on: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(urls()[0]).toBe('/api/observatory/heatmap?period=30d&source_feed=feeds&limit=10000');
  });
});

describe('request shape', () => {
  it('passes source_feed to every endpoint and clamps node limit', async () => {
    const qc = makeClient();
    renderHook(
      () => {
        useObservatoryThreats({ period: '24h', source: 'spam_trap', limit: 99999 });
        useObservatoryStats({ period: '24h', source: 'spam_trap' });
        useObservatoryArcs({ period: '24h', source: 'spam_trap' });
        useObservatoryLive({ source: 'spam_trap' });
      },
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const u = urls();
    expect(u).toContain('/api/observatory/nodes?period=24h&source_feed=spam_trap&limit=2000');
    expect(u).toContain('/api/observatory/stats?period=24h&source_feed=spam_trap');
    expect(u).toContain('/api/observatory/arcs?period=24h&source_feed=spam_trap');
    expect(u).toContain('/api/observatory/live?limit=8&source_feed=spam_trap');
  });

  it('hands the query AbortSignal to fetch', async () => {
    const qc = makeClient();
    renderHook(() => useObservatoryArcs({}), { wrapper: wrap(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('sharing', () => {
  it('two consumers of the same key share ONE request', async () => {
    const qc = makeClient();
    renderHook(
      () => {
        useObservatoryThreats({ period: '7d' });
        useObservatoryThreats({ period: '7d' });
      },
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('one consumer unmounting does not cancel or error the other', async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(r => { resolve = r; }));
    const qc = makeClient();
    const a = renderHook(() => useObservatoryThreats({ period: '7d' }), { wrapper: wrap(qc) });
    const b = renderHook(() => useObservatoryThreats({ period: '7d' }), { wrapper: wrap(qc) });
    a.unmount();
    await act(async () => { resolve({ success: true, data: [{ lat: 1 }] }); });
    await waitFor(() => expect(b.result.current.data).toEqual([{ lat: 1 }]));
    expect(b.result.current.error).toBeNull();
  });
});

describe('key changes', () => {
  it('keeps previous data but flags isUpdating while the new period loads', async () => {
    let resolveSecond!: (v: unknown) => void;
    fetchMock
      .mockImplementationOnce(() => ok([{ lat: 1 }]))
      .mockImplementationOnce(() => new Promise(r => { resolveSecond = r; }));
    const qc = makeClient();
    const { result, rerender } = renderHook(({ p }) => useObservatoryThreats({ period: p }), {
      wrapper: wrap(qc), initialProps: { p: '7d' },
    });
    await waitFor(() => expect(result.current.data).toEqual([{ lat: 1 }]));
    expect(result.current.isUpdating).toBe(false);

    rerender({ p: '24h' });
    await waitFor(() => expect(result.current.isUpdating).toBe(true));
    expect(result.current.data).toEqual([{ lat: 1 }]); // old data still shown…
    expect(result.current.isLoading).toBe(false);       // …but flagged, not "loaded"

    await act(async () => { resolveSecond({ success: true, data: [{ lat: 2 }] }); });
    await waitFor(() => expect(result.current.isUpdating).toBe(false));
    expect(result.current.data).toEqual([{ lat: 2 }]);
  });

  it('a stale error does not persist across a key change', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve({ success: false, error: 'boom' }))
      .mockImplementationOnce(() => ok([{ lat: 3 }]));
    const qc = makeClient();
    const { result, rerender } = renderHook(({ p }) => useObservatoryThreats({ period: p }), {
      wrapper: wrap(qc), initialProps: { p: '7d' },
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    rerender({ p: '30d' });
    await waitFor(() => expect(result.current.data).toEqual([{ lat: 3 }]));
    expect(result.current.error).toBeNull();
  });

  it('a refetch issued during a fetch is not silently dropped', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useObservatoryStats({ period: '7d' }), { wrapper: wrap(qc) });
    fetchMock.mockImplementation(() => ok({ threats_mapped: 1 }));
    await waitFor(() => expect(result.current.data).toBeDefined());
    const before = fetchMock.mock.calls.length;
    await act(async () => { await result.current.refetch(); });
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });
});

describe('refreshObservatory', () => {
  it('invalidates observatory + side-panel keys and nothing else', async () => {
    const qc = makeClient();
    const seed = (key: unknown[]) => qc.setQueryData(key, 1);
    seed([...observatoryKeys.nodes('7d', 'all', 2000)]);
    seed([...observatoryKeys.live('all', 8)]);
    seed(['brands', 'top', 8, 0, '7d', undefined]);
    seed(['brands', 'list', 500]);
    seed(['operations', 'active', 4, 0]);
    seed(['dashboard-providers', 'worst', 3]);
    seed(['alerts']);
    await refreshObservatory(qc);
    const stale = (key: unknown[]) => qc.getQueryState(key)?.isInvalidated;
    expect(stale([...observatoryKeys.nodes('7d', 'all', 2000)])).toBe(true);
    expect(stale([...observatoryKeys.live('all', 8)])).toBe(true);
    expect(stale(['brands', 'top', 8, 0, '7d', undefined])).toBe(true);
    expect(stale(['operations', 'active', 4, 0])).toBe(true);
    expect(stale(['dashboard-providers', 'worst', 3])).toBe(true);
    expect(stale(['brands', 'list', 500])).toBe(false);
    expect(stale(['alerts'])).toBe(false);
  });
});
