// Tests for useGlobalSearch — the debounced TanStack hook backing the
// command palette's cross-entity search. Covers the behavior called out
// as genuinely risky: the <2-char gate never firing a request, the
// debounce window actually delaying the request, the request URL shape
// (trim + encode), and the null-data fallback.
//
// No renderHook precedent exists yet in this package; this follows the
// house patterns already in use elsewhere: vi.hoisted + vi.mock for
// '@/lib/api' (see Leads.test.tsx's hook-mocking style) and
// vi.useFakeTimers()/act() for timers (see Toast.test.tsx).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useGlobalSearch } from './useGlobalSearch';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { get: mocks.get },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const EMPTY = { brands: [], threat_actors: [], providers: [], campaigns: [] };

afterEach(() => {
  vi.useRealTimers();
  mocks.get.mockReset();
});

describe('useGlobalSearch — gating', () => {
  it('never calls the API for a trimmed query under 2 characters', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGlobalSearch('a'), { wrapper: createWrapper() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mocks.get).not.toHaveBeenCalled();
    expect(result.current.brands).toEqual([]);
    expect(result.current.threatActors).toEqual([]);
    expect(result.current.providers).toEqual([]);
    expect(result.current.campaigns).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('never calls the API for a whitespace-only query, even at raw length >= 2', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGlobalSearch('  '), { wrapper: createWrapper() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mocks.get).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it('empty query never reports isLoading, even mid-debounce', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGlobalSearch(''), { wrapper: createWrapper() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.isLoading).toBe(false);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('useGlobalSearch — debounce', () => {
  // Note: useDebouncedValue seeds its state via useState(value), so a
  // hook that *mounts* already holding a qualifying query fires
  // immediately — only a *change* to the query is actually delayed.
  // That matches real usage: CommandPalette resets its query to '' on
  // every open (see components/layout/CommandPalette.tsx), so the
  // realistic case to cover is empty-on-mount, then a keystroke.

  it('does not fire before the ~200ms debounce window elapses after the query changes', async () => {
    mocks.get.mockResolvedValue({ success: true, data: EMPTY });
    vi.useFakeTimers();
    const { rerender } = renderHook(({ q }) => useGlobalSearch(q), {
      wrapper: createWrapper(),
      initialProps: { q: '' },
    });

    rerender({ q: 'ac' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('fires exactly once the debounce window elapses after the query changes', async () => {
    mocks.get.mockResolvedValue({ success: true, data: EMPTY });
    vi.useFakeTimers();
    const { rerender } = renderHook(({ q }) => useGlobalSearch(q), {
      wrapper: createWrapper(),
      initialProps: { q: '' },
    });

    rerender({ q: 'ac' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('a hook that mounts already holding a qualifying query fires immediately (no delay on initial mount)', async () => {
    // Documents the useState(value)-seeded-debounce quirk above rather
    // than asserting a delay that doesn't actually happen on mount.
    mocks.get.mockResolvedValue({ success: true, data: EMPTY });
    vi.useFakeTimers();
    renderHook(() => useGlobalSearch('ac'), { wrapper: createWrapper() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});

describe('useGlobalSearch — request shape', () => {
  it('builds the request URL from the trimmed, URL-encoded term with limit=8', async () => {
    mocks.get.mockResolvedValue({ success: true, data: EMPTY });
    vi.useFakeTimers();
    renderHook(() => useGlobalSearch('  a&b  '), { wrapper: createWrapper() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mocks.get).toHaveBeenCalledWith('/api/search?q=a%26b&limit=8');
  });
});

describe('useGlobalSearch — response mapping', () => {
  it('maps threat_actors -> threatActors and passes brands/providers/campaigns through', async () => {
    mocks.get.mockResolvedValue({
      success: true,
      data: {
        brands: [{ type: 'brand', id: 'b1', label: 'Acme', sublabel: 'acme.com' }],
        threat_actors: [{ type: 'threat_actor', id: 't1', label: 'APT1', sublabel: 'CN' }],
        providers: [{ type: 'provider', id: 'p1', label: 'CloudCo', sublabel: 'AS123' }],
        campaigns: [{ type: 'campaign', id: 'c1', label: 'Op Foo', sublabel: 'active' }],
      },
    });
    vi.useFakeTimers();
    const { result } = renderHook(() => useGlobalSearch('ac'), { wrapper: createWrapper() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.brands).toEqual([{ type: 'brand', id: 'b1', label: 'Acme', sublabel: 'acme.com' }]);
    expect(result.current.threatActors).toEqual([{ type: 'threat_actor', id: 't1', label: 'APT1', sublabel: 'CN' }]);
    expect(result.current.providers).toEqual([{ type: 'provider', id: 'p1', label: 'CloudCo', sublabel: 'AS123' }]);
    expect(result.current.campaigns).toEqual([{ type: 'campaign', id: 'c1', label: 'Op Foo', sublabel: 'active' }]);
  });

  it('falls back to empty groups when the response has no data field, instead of throwing', async () => {
    mocks.get.mockResolvedValue({ success: true });
    vi.useFakeTimers();
    const { result } = renderHook(() => useGlobalSearch('ac'), { wrapper: createWrapper() });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(result.current.brands).toEqual([]);
    expect(result.current.threatActors).toEqual([]);
    expect(result.current.providers).toEqual([]);
    expect(result.current.campaigns).toEqual([]);
  });
});
