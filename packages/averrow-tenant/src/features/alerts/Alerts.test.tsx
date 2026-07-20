import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { Alerts } from './Alerts';
import type { AlertsResponse } from '@/lib/alerts';

// design-review FIX J — smoke test for the deep-link filter Alerts.tsx
// gained in EXEC_IMPERSONATION_2026-07 Stage 5: the executives registry
// links here as /alerts?brand=<id>&type=executive_impersonation, and
// Alerts.tsx now reads those params, threads them into useTenantAlerts,
// and shows a dismissible "Filtered" chip. Not a full Alerts.tsx test
// suite (none existed before) — just this one added behavior.

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn(() => ({ user: null })) }));
vi.mock('@/lib/alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/alerts')>();
  return {
    ...actual,
    useTenantAlerts: vi.fn(),
    useCanTriage: vi.fn(() => false),
    useBulkUpdateAlerts: vi.fn(() => ({ mutate: vi.fn(), isPending: false, isError: false, error: null })),
  };
});

import { useTenantAlerts } from '@/lib/alerts';

function mockAlerts(overrides: Partial<AlertsResponse> = {}) {
  vi.mocked(useTenantAlerts).mockReturnValue({
    data: { alerts: [], total: 0, severity_breakdown: [], ...overrides },
    isLoading: false,
    error: null,
  } as unknown as UseQueryResult<AlertsResponse>);
}

function renderAlertsAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Alerts />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Alerts — deep-link brand/type filter (Stage 5 executives→alerts link)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAlerts();
  });

  it('passes no brandId/alertType and shows no filter chip on a plain /alerts visit', () => {
    renderAlertsAt('/alerts');

    expect(screen.queryByText(/Filtered/)).not.toBeInTheDocument();
    const call = vi.mocked(useTenantAlerts).mock.calls[0]?.[0];
    expect(call?.brandId).toBeUndefined();
    expect(call?.alertType).toBeUndefined();
  });

  it('threads ?brand=&type= into useTenantAlerts and shows a filter chip', () => {
    renderAlertsAt('/alerts?brand=brand-1&type=executive_impersonation');

    const call = vi.mocked(useTenantAlerts).mock.calls[0]?.[0];
    expect(call?.brandId).toBe('brand-1');
    expect(call?.alertType).toBe('executive_impersonation');

    expect(screen.getByText(/Filtered/)).toBeInTheDocument();
    expect(screen.getByText(/executive impersonation/)).toBeInTheDocument();
  });

  it('clears the deep-link filter and re-queries without it', async () => {
    const user = userEvent.setup();
    renderAlertsAt('/alerts?brand=brand-1&type=executive_impersonation');

    expect(screen.getByText(/Filtered/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Clear filter'));

    expect(screen.queryByText(/Filtered/)).not.toBeInTheDocument();
    const lastCall = vi.mocked(useTenantAlerts).mock.calls.at(-1)?.[0];
    expect(lastCall?.brandId).toBeUndefined();
    expect(lastCall?.alertType).toBeUndefined();
  });
});
