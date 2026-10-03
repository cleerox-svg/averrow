// Regression coverage for the Jul 2026 "/v2/" root-route outage — second
// crash site. ThreatInflowChart is mounted on the root route via
// OverviewV4 → ThreatPulse. Its useThreatInflow hook used to blind-cast the
// untyped api.get() result to InflowResponse; api.get() only throws on 401
// (see src/lib/api.ts), so a transient 5xx that returned the platform's
// generic error envelope {success:false, error:"..."} resolved as `data` — a
// truthy object with no `buckets` array — and `data.buckets.map(...)` threw,
// crashing the whole root route via the ErrorBoundary (same class as the
// platform-status badge crash).
//
// The fix added an isInflowResponse shape guard. A malformed body is now a
// failed load (query error): an error card with retry and a "—" headline, never
// "No data" / "0 new indicators" (PR6c: error must not look like data).
// Same renderHook/vi.mock('@/lib/api') pattern as usePlatformStatus.test.tsx.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ThreatInflowChart } from './ThreatInflowChart';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: { get: mocks.get },
}));

function renderChart() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<ThreatInflowChart />, { wrapper: Wrapper });
}

afterEach(() => {
  mocks.get.mockReset();
});

describe('ThreatInflowChart — malformed-response guard (isInflowResponse) and failures', () => {
  it('renders the error state without throwing when the API returns the error envelope', async () => {
    // The exact payload that caused the outage: a truthy object with no
    // `buckets`. Pre-fix this threw `Cannot read properties of undefined
    // (reading 'map')` at data.buckets.map(...).
    mocks.get.mockResolvedValue({ success: false, error: 'platform compute failed: boom' });
    renderChart();
    // Title always renders; the guard routes the malformed body to the error state.
    expect(screen.getByText('Threat Inflow')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load threat inflow"));
    expect(screen.queryByText('No data')).not.toBeInTheDocument();
  });

  it('renders the error state without throwing for an empty object', async () => {
    mocks.get.mockResolvedValue({});
    renderChart();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('renders the error state when buckets is present but not an array', async () => {
    mocks.get.mockResolvedValue({ window: '24h', buckets: 'nope', series: [], total: 0 });
    renderChart();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  it('a rejected request shows the error with retry and "—", never 0 new indicators', async () => {
    mocks.get.mockRejectedValue(new Error('HTTP 500'));
    renderChart();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load threat inflow"));
    expect(screen.getByRole('button', { name: /^Try again/ })).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('does not fall back to "No data" for a well-formed InflowResponse', async () => {
    mocks.get.mockResolvedValue({
      window: '24h',
      buckets: ['2026-07-13 00:00:00', '2026-07-13 01:00:00'],
      series: [{ threat_type: 'phishing', counts: [3, 4], total: 7 }],
      total: 7,
      generated_at: '2026-07-13T02:00:00Z',
    });
    renderChart();
    // Wait for the query to resolve (title always present; assert the valid
    // branch was taken — i.e. the malformed "No data" fallback is absent).
    // The chart itself renders zero-size in jsdom, so we don't assert on it.
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('No data')).not.toBeInTheDocument());
  });
});
