import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const fetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a) } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: 'super_admin' } }) }));

import {
  useObservatoryThreats, useObservatoryStats, useObservatoryArcs, observatoryKeys, activeFilters, filterParams, withoutBrand,
} from './useObservatory';
import { useObservatoryTimeline } from './useObservatoryLenses';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
const lastUrl = () => fetchMock.mock.calls.at(-1)![0] as string;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ success: true, data: [] });
});

describe('filter params on the observatory data hooks', () => {
  const filters = { severity: 'critical,high', threat_type: 'phishing', brand: 'b_1' };

  it('nodes: severity and threat_type, but NEVER brand (the geo cube has no brand dimension: it is a 400)', async () => {
    renderHook(() => useObservatoryThreats({ filters }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const u = new URL(lastUrl(), 'http://x');
    expect(u.pathname).toBe('/api/observatory/nodes');
    expect(u.searchParams.get('severity')).toBe('critical,high');
    expect(u.searchParams.get('threat_type')).toBe('phishing');
    expect(u.searchParams.has('brand')).toBe(false);
  });

  it('arcs and stats: all three, with exactly those param names', async () => {
    renderHook(() => useObservatoryArcs({ filters }), { wrapper });
    renderHook(() => useObservatoryStats({ filters }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const [url] of fetchMock.mock.calls as [string][]) {
      const u = new URL(url, 'http://x');
      expect(u.searchParams.get('severity')).toBe('critical,high');
      expect(u.searchParams.get('threat_type')).toBe('phishing');
      expect(u.searchParams.get('brand')).toBe('b_1');
    }
  });

  it('timeline: filters are sent; with velocity they are NOT (velocity + a filter is a 400)', async () => {
    renderHook(() => useObservatoryTimeline({ filters }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(new URL(lastUrl(), 'http://x').searchParams.get('brand')).toBe('b_1');
    renderHook(() => useObservatoryTimeline({ filters, velocity: 'all' }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const u = new URL(lastUrl(), 'http://x');
    expect(u.searchParams.get('velocity')).toBe('all');
    for (const k of ['severity', 'threat_type', 'brand']) expect(u.searchParams.has(k)).toBe(false);
  });

  it('the drawer\'s trend request: country + period (+ filters), no velocity', async () => {
    renderHook(() => useObservatoryTimeline({ country: 'NL', period: '30d', filters: { severity: 'high' } }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const u = new URL(lastUrl(), 'http://x');
    expect(u.searchParams.get('country')).toBe('NL');
    expect(u.searchParams.get('period')).toBe('30d');
    expect(u.searchParams.get('severity')).toBe('high');
    expect(u.searchParams.has('velocity')).toBe(false);
  });

  it('nothing is sent when no filter is set: the URL and the query key are exactly what they were', async () => {
    renderHook(() => useObservatoryThreats({ filters: { severity: '', threat_type: ' ' } }), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastUrl()).toBe('/api/observatory/nodes?period=7d&limit=2000');
    expect(observatoryKeys.nodes('7d', 'all', 2000, {})).toEqual(observatoryKeys.nodes('7d', 'all', 2000));
    expect(observatoryKeys.arcs('7d', 'all', { brand: '' })).toEqual(observatoryKeys.arcs('7d', 'all'));
    expect(observatoryKeys.stats('7d', 'all', { severity: 'high' })).not.toEqual(observatoryKeys.stats('7d', 'all'));
  });

  it('helpers', () => {
    expect(activeFilters({ severity: ' ', brand: '' })).toBeNull();
    expect(activeFilters(undefined)).toBeNull();
    expect(filterParams(undefined)).toEqual({});
    expect(withoutBrand({ severity: 'high', brand: 'b' })).toEqual({ severity: 'high' });
  });
});
