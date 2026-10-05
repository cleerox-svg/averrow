import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from '@/lib/api';
import {
  useNotificationEventPreferences, useNotificationPreferencesV2, useUpdateNotificationEventPreferences,
  useUpdateNotificationPreferencesV2,
} from './useNotifications';

const get = api.get as ReturnType<typeof vi.fn>;
const put = api.put as ReturnType<typeof vi.fn>;
const patch = api.patch as ReturnType<typeof vi.fn>;

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
  return { qc, wrapper };
}

const v2Gets = () => get.mock.calls.filter(([u]) => String(u).endsWith('/preferences/v2')).length;
const v1Gets = () => get.mock.calls.filter(([u]) => String(u).endsWith('/preferences')).length;

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ success: true, data: url.endsWith('/v2') ? { ...V2 } : { brand_threat: true, feed_health: true } }));
});

describe('v2 preference writes', () => {
  it('refetches only after the LAST in-flight save settles (no stale flicker)', async () => {
    const { wrapper } = setup();
    const a = deferred();
    const b = deferred();
    put.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = renderHook(() => ({ q: useNotificationPreferencesV2(), m: useUpdateNotificationPreferencesV2() }), { wrapper });
    await waitFor(() => expect(result.current.q.data).toBeTruthy());
    expect(v2Gets()).toBe(1);

    let pa: Promise<unknown> = Promise.resolve();
    let pb: Promise<unknown> = Promise.resolve();
    act(() => { pa = result.current.m.mutateAsync({ patch: { digest_mode: 'weekly' } }); });
    act(() => { pb = result.current.m.mutateAsync({ patch: { digest_mode: 'off' } }); });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));

    await act(async () => { a.resolve({ success: true }); await pa; });
    expect(v2Gets()).toBe(1); // first save settled, second still in flight -> no refetch yet
    expect(result.current.q.data?.digest_mode).toBe('off');

    await act(async () => { b.resolve({ success: true }); await pb; });
    await waitFor(() => expect(v2Gets()).toBe(2));
  });

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

describe('event toggle writes', () => {
  it('refetches once, after the last save; an older failure leaves the newer value', async () => {
    const { wrapper } = setup();
    const a = deferred();
    const b = deferred();
    patch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = renderHook(() => ({ q: useNotificationEventPreferences(), m: useUpdateNotificationEventPreferences() }), { wrapper });
    await waitFor(() => expect(result.current.q.data).toBeTruthy());
    const key = Object.keys(result.current.q.data ?? {})[0] ?? 'brand_threat';
    const before = result.current.q.data?.[key];

    let pa: Promise<unknown> = Promise.resolve();
    let pb: Promise<unknown> = Promise.resolve();
    act(() => { pa = result.current.m.mutateAsync({ [key]: !before }).catch(() => undefined); });
    act(() => { pb = result.current.m.mutateAsync({ [key]: !!before }).catch(() => undefined); });

    await act(async () => { a.reject(new Error('boom')); await pa; });
    expect(result.current.q.data?.[key]).toBe(!!before); // newer toggle wins
    expect(v1Gets()).toBe(1);

    await act(async () => { b.resolve({ success: true }); await pb; });
    await waitFor(() => expect(v1Gets()).toBe(2));
  });
});
