import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

import { api } from '@/lib/api';
import { useOpenAlertCount } from './useOpenAlertCount';

const get = api.get as unknown as ReturnType<typeof vi.fn>;

function wrapper(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useOpenAlertCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps triage-summary new_count', async () => {
    get.mockResolvedValue({ success: true, data: { new_count: 17, critical_count: 3 } });
    const { result } = renderHook(() => useOpenAlertCount(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(17);
    expect(get).toHaveBeenCalledWith('/api/alerts/triage-summary');
  });

  it('reports isError when the request fails with nothing cached', async () => {
    get.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useOpenAlertCount(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it('keeps the last good value when a refetch fails', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    get.mockResolvedValueOnce({ success: true, data: { new_count: 5, critical_count: 0 } });
    const { result } = renderHook(() => useOpenAlertCount(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data).toBe(5));
    get.mockRejectedValue(new Error('down'));
    await qc.invalidateQueries({ queryKey: ['alert-triage-summary'] });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBe(5);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.isError).toBe(false);
  });
});
