// Write-ordering guard: an older failed save must not roll back a field a
// newer save owns (same rule as ops hooks/useNotifications.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('./api', () => ({
  apiGet: vi.fn(), apiPut: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(),
}));

import { apiGet, apiPut } from './api';
import { useNotificationPreferencesV2, useUpdateNotificationPreferencesV2 } from './accountNotifications';

const get = apiGet as ReturnType<typeof vi.fn>;
const put = apiPut as ReturnType<typeof vi.fn>;

const V2 = {
  inapp_severity_floor: 'info', push_severity_floor: 'low', email_severity_floor: 'high',
  digest_mode: 'daily', digest_severity_floor: 'medium', quiet_hours_start: null, quiet_hours_end: null,
  quiet_hours_timezone: 'UTC', critical_bypasses_quiet: 1, show_tenant_notifications: 0,
  cadence_intel: 'realtime', cadence_platform: 'realtime',
};

function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ success: true, data: { ...V2 } });
});

describe('tenant v2 preference writes', () => {
  it('a failing older save does not roll back a field a newer save owns', async () => {
    const { wrapper } = setup();
    const a = deferred();
    const b = deferred();
    put.mockImplementation((_u: string, body: { digest_mode?: string }) => (body.digest_mode === 'weekly' ? a.promise : b.promise));
    const { result } = renderHook(() => ({ q: useNotificationPreferencesV2(), m: useUpdateNotificationPreferencesV2() }), { wrapper });
    await waitFor(() => expect(result.current.q.data).toBeTruthy());

    let pa: Promise<unknown> = Promise.resolve();
    act(() => { pa = result.current.m.mutateAsync({ patch: { digest_mode: 'weekly', cadence_intel: 'daily_digest' } }).catch(() => undefined); });
    act(() => { void result.current.m.mutateAsync({ patch: { digest_mode: 'off' } }); });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));

    await act(async () => { a.reject(new Error('boom')); await pa; });
    // digest_mode belongs to the newer save; cadence_intel (untouched since) rolls back.
    await waitFor(() => expect(result.current.q.data?.cadence_intel).toBe('realtime'));
    expect(result.current.q.data?.digest_mode).toBe('off');
  });
});
