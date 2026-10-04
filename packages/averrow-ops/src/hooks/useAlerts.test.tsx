// Every alert mutation must refresh the shared triage summary (Home queue,
// bell, nav badge and Console tile all read it).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));

import { api } from '@/lib/api';
import { useUpdateAlert, useAssignAlert, useBulkAcknowledge, useBulkTakedown } from './useAlerts';

const patch = api.patch as unknown as ReturnType<typeof vi.fn>;
const post = api.post as unknown as ReturnType<typeof vi.fn>;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const spy = vi.spyOn(client, 'invalidateQueries');
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { Wrapper, spy };
}

describe('alert mutations invalidate the triage summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patch.mockResolvedValue({ success: true });
    post.mockResolvedValue({ success: true });
  });

  const cases: Array<[string, () => { mutate: (v: never) => void }, unknown]> = [
    ['useUpdateAlert', useUpdateAlert as never, { id: 'a1', status: 'resolved' }],
    ['useAssignAlert', useAssignAlert as never, { id: 'a1', staff_assigned_to: 'u1' }],
    ['useBulkAcknowledge', useBulkAcknowledge as never, { alert_ids: ['a1'] }],
    ['useBulkTakedown', useBulkTakedown as never, { brand_id: 'b1' }],
  ];

  it.each(cases)('%s', async (_name, hook, vars) => {
    const { Wrapper, spy } = wrapper();
    const { result } = renderHook(() => hook(), { wrapper: Wrapper });
    result.current.mutate(vars as never);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining([
      JSON.stringify(['alerts']), JSON.stringify(['alert-stats']), JSON.stringify(['alert-triage-summary']),
    ]));
  });
});
