import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useThreatAggregate, DEGRADED_POLL_MS, type ThreatAggregate } from './useThreatAggregate';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
import { api } from '@/lib/api';
const get = api.get as ReturnType<typeof vi.fn>;

const body = (degraded: string[]) => ({ success: true, data: { total: 1, degraded_sections: degraded } as unknown as ThreatAggregate });

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useThreatAggregate self-heal', () => {
  beforeEach(() => { get.mockReset(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls every 5 min while degraded (not every 60s) and stops once healthy', async () => {
    expect(DEGRADED_POLL_MS).toBe(300_000);
    get.mockResolvedValueOnce(body(['top_brands'])).mockResolvedValue(body([]));
    renderHook(() => useThreatAggregate({}), { wrapper: wrapper() });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    // The former 60s poll would have refetched four times by now.
    await act(async () => { await vi.advanceTimersByTimeAsync(299_000); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2)); // healthy now

    await act(async () => { await vi.advanceTimersByTimeAsync(900_000); });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not poll a healthy response', async () => {
    get.mockResolvedValue(body([]));
    renderHook(() => useThreatAggregate({}), { wrapper: wrapper() });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
