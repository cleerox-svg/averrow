// Coverage for useAdminTakedowns' querystring construction — the S2.3 T1/T2
// scope split threads `scope` ('authorized'|'prospect'|'all') and `brand_id`
// into the admin takedowns query. Both are optional filters that must be
// OMITTED from the querystring when not provided (so the backend's own
// 'authorized' default takes over) and INCLUDED verbatim when set. This
// mirrors the backend's 6-case scope suite
// (packages/averrow-worker/test/takedown-admin-list-scope.test.ts) from the
// frontend request-shape side. Follows the renderHook + vi.mock('@/lib/api')
// pattern already used by useGlobalSearch.test.tsx / usePlatformStatus.test.tsx.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAdminTakedowns } from './useTakedowns';

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

describe('useAdminTakedowns — querystring construction', () => {
  it('omits scope and brand_id from the querystring when neither is provided', async () => {
    mocks.get.mockResolvedValue({ success: true, data: [], total: 0, status_counts: [] });
    renderHook(() => useAdminTakedowns({}), { wrapper: createWrapper() });

    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/takedowns');
  });

  it('omits scope and brand_id when useAdminTakedowns is called with no options at all', async () => {
    mocks.get.mockResolvedValue({ success: true, data: [], total: 0, status_counts: [] });
    renderHook(() => useAdminTakedowns(), { wrapper: createWrapper() });

    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/takedowns');
  });

  it('includes only scope when brand_id is not set', async () => {
    mocks.get.mockResolvedValue({ success: true, data: [], total: 0, status_counts: [] });
    renderHook(() => useAdminTakedowns({ scope: 'prospect' }), { wrapper: createWrapper() });

    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/takedowns?scope=prospect');
  });

  it('includes only brand_id when scope is not set', async () => {
    mocks.get.mockResolvedValue({ success: true, data: [], total: 0, status_counts: [] });
    renderHook(() => useAdminTakedowns({ brand_id: 'brand_a' }), { wrapper: createWrapper() });

    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/takedowns?brand_id=brand_a');
  });

  it('includes both scope and brand_id, alongside other filters, when all are provided', async () => {
    mocks.get.mockResolvedValue({ success: true, data: [], total: 0, status_counts: [] });
    renderHook(
      () => useAdminTakedowns({ scope: 'prospect', brand_id: 'brand_a', status: 'draft', limit: 500 }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/admin/takedowns?status=draft&limit=500&scope=prospect&brand_id=brand_a',
    );
  });

  it('does not send scope=all as a literal filter unless explicitly requested', async () => {
    // 'all' is a valid TakedownScope value but callers should only send it
    // when they explicitly want the unscoped view — confirm it round-trips
    // through the same "include when set" path as the other two values.
    mocks.get.mockResolvedValue({ success: true, data: [], total: 0, status_counts: [] });
    renderHook(() => useAdminTakedowns({ scope: 'all' }), { wrapper: createWrapper() });

    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(mocks.get).toHaveBeenCalledWith('/api/admin/takedowns?scope=all');
  });
});

describe('useAdminTakedowns — scope echo', () => {
  it('echoes the response scope back verbatim when the backend includes one', async () => {
    mocks.get.mockResolvedValue({
      success: true,
      data: [],
      total: 0,
      status_counts: [],
      scope: 'prospect',
    });
    const { result } = renderHook(() => useAdminTakedowns({ scope: 'prospect' }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.scope).toBe('prospect'));
  });

  it('falls back to the requested scope, then "authorized", when the response omits scope', async () => {
    mocks.get.mockResolvedValue({ success: true, data: [], total: 0, status_counts: [] });
    const { result: requested } = renderHook(
      () => useAdminTakedowns({ scope: 'prospect' }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(requested.current.data?.scope).toBe('prospect'));

    const { result: bare } = renderHook(() => useAdminTakedowns({}), { wrapper: createWrapper() });
    await waitFor(() => expect(bare.current.data?.scope).toBe('authorized'));
  });
});
