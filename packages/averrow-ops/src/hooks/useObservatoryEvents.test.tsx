import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const fetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a) } }));

import {
  useObservatoryEvents, eventsUrl, eventsPollMs, canonicalKinds, normalizeEvents,
  EVENTS_POLL_MS, EVENTS_POLL_7D_MS,
} from './useObservatoryEvents';
import { EVENTS_DEFAULT_LIMIT, EVENTS_DEFAULT_PERIOD, type ObservatoryEvent } from '@/features/observatory-v3/lib/events';

const ev = (over: Partial<ObservatoryEvent> = {}): ObservatoryEvent => ({
  id: 'critical:brand:b1', kind: 'critical', severity: 'critical', title: 'Acme Bank targeted by 12 new phishing pages',
  entity: { type: 'brand', id: 'b1', name: 'Acme Bank' }, place: { country_code: 'NL', country_name: 'Netherlands', lat: 52, lng: 5 },
  count: 12, occurred_at: '2026-10-15T10:00:00.000Z', source: 'sentinel', target: { lens: 'threats', select: 'country:NL' }, ...over,
});
const envelope = (data: ObservatoryEvent[] = [ev()]) => ({
  success: true, data, counts_by_kind: { critical: 12 },
  meta: { generated_at: '2026-10-15T10:01:00.000Z', period: '1h', omitted_kinds: ['takedown'], capped_kinds: [], failed_kinds: ['lookalike'] },
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const urls = () => fetchMock.mock.calls.map(c => c[0] as string);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(envelope()));
});
afterEach(() => { vi.useRealTimers(); });

describe('request shape', () => {
  it('the default request is exactly the Navigator-warmed key: period=1h&limit=40, no kinds', async () => {
    expect(EVENTS_DEFAULT_PERIOD).toBe('1h');
    expect(EVENTS_DEFAULT_LIMIT).toBe(40);
    expect(eventsUrl('1h', [], 40)).toBe('/api/observatory/events?period=1h&limit=40');
    renderHook(() => useObservatoryEvents(), { wrapper: wrap() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(urls()[0]).toBe('/api/observatory/events?period=1h&limit=40');
  });

  it('sends kinds only when filtering, canonical and deduplicated, between period and limit', () => {
    expect(eventsUrl('24h', ['fast', 'critical'], 100)).toBe('/api/observatory/events?period=24h&kinds=fast%2Ccritical&limit=100');
    expect(canonicalKinds(['spike', 'critical', 'spike'])).toEqual(['critical', 'spike']);
    // All seven (or none) is "no filter": the warmed key, not a seven-kind variant.
    expect(canonicalKinds(['critical', 'operation', 'fast', 'lookalike', 'takedown', 'actor', 'spike'])).toEqual([]);
    expect(canonicalKinds([])).toEqual([]);
  });

  it('a filtered request goes out with kinds in server order whatever order the caller used', async () => {
    renderHook(() => useObservatoryEvents({ kinds: ['spike', 'critical'], period: '24h', limit: 100 }), { wrapper: wrap() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(urls()[0]).toBe('/api/observatory/events?period=24h&kinds=critical%2Cspike&limit=100');
  });

  it('is gated by enabled', async () => {
    renderHook(() => useObservatoryEvents({ enabled: false }), { wrapper: wrap() });
    await new Promise(r => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('result', () => {
  it('returns events, counts and meta; a missing piece reads as empty', async () => {
    const { result } = renderHook(() => useObservatoryEvents(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.events).toHaveLength(1);
    expect(result.current.data!.counts).toEqual({ critical: 12 });
    expect(result.current.data!.meta.omitted_kinds).toEqual(['takedown']);
    expect(result.current.data!.meta.failed_kinds).toEqual(['lookalike']);

    expect(normalizeEvents({ success: true, data: [] }, '1h')).toEqual({
      events: [], counts: {}, meta: { generated_at: null, period: '1h', omitted_kinds: [], capped_kinds: [], failed_kinds: [] },
    });
    // An unknown kind from a newer worker is dropped, not trusted.
    expect(normalizeEvents({ success: true, data: [], meta: { failed_kinds: ['critical', 'bogus' as never] } }, '1h').meta.failed_kinds).toEqual(['critical']);
  });

  it('a failed envelope is an error, not an empty feed', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ success: false, error: 'nope' }));
    const { result } = renderHook(() => useObservatoryEvents(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeUndefined();
  });
});

describe('polling', () => {
  it('polls every 30s (1h, 24h) and never faster than every 5 minutes for 7d', () => {
    expect(EVENTS_POLL_MS).toBe(30_000);
    expect(eventsPollMs('1h')).toBe(30_000);
    expect(eventsPollMs('24h')).toBe(30_000);
    expect(eventsPollMs('7d')).toBe(300_000);
    expect(EVENTS_POLL_7D_MS).toBeGreaterThanOrEqual(300_000);
  });

  it('1h refetches on the 30s tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useObservatoryEvents(), { wrapper: wrap() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('7d does not refetch at 30s or 4 minutes, only at 5', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useObservatoryEvents({ period: '7d', limit: 100 }), { wrapper: wrap() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(210_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('does not poll while the tab is hidden, and resumes when it is visible again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useObservatoryEvents(), { wrapper: wrap() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => focusManager.setFocused(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => focusManager.setFocused(undefined));
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
