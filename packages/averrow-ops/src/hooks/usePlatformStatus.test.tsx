// Regression coverage for the Jul 2026 "/v2/" root-route outage: the
// worker's /api/v1/public/platform-status transiently returned the
// generic error envelope {success:false, error:"..."} instead of a
// PlatformStatus body. api.get() only throws on 401 (see src/lib/api.ts),
// so that envelope used to resolve as `data` — a truthy object with no
// `overall` field — and got blind-cast, so consumers keying a lookup
// table on `data.overall` (PlatformStatusBadge's PALETTE[status]) crashed
// on `undefined`.
//
// The fix added an `isPlatformStatus` shape guard inside the queryFn:
// malformed responses resolve to `null` instead of a fake PlatformStatus.
// This test drives that queryFn end-to-end via a mocked api.get(), the
// same renderHook + vi.mock('@/lib/api') pattern used in
// useGlobalSearch.test.tsx.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePlatformStatus } from './usePlatformStatus';

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

afterEach(() => {
  mocks.get.mockReset();
});

const VALID_STATUS = {
  generated_at: '2026-07-13T00:00:00Z',
  overall: 'operational',
  overall_note: 'ok',
  categories: [],
  window_days: 30,
};

describe('usePlatformStatus — shape guard (isPlatformStatus)', () => {
  it('returns the PlatformStatus object as-is for a well-formed response', async () => {
    mocks.get.mockResolvedValue(VALID_STATUS);
    const { result } = renderHook(() => usePlatformStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(VALID_STATUS);
  });

  it('returns null (not the raw envelope) for the generic error envelope {success:false, error}', async () => {
    // This is the exact shape that crashed the page: a truthy object with
    // no `overall` field.
    mocks.get.mockResolvedValue({ success: false, error: 'internal error' });
    const { result } = renderHook(() => usePlatformStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('returns null for an empty object response', async () => {
    mocks.get.mockResolvedValue({});
    const { result } = renderHook(() => usePlatformStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('returns null when `overall` is present but not a string', async () => {
    mocks.get.mockResolvedValue({ overall: 500, categories: [] });
    const { result } = renderHook(() => usePlatformStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('returns null (never throws) when api.get() itself rejects', async () => {
    mocks.get.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => usePlatformStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
  });
});
