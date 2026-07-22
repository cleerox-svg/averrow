import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { Billing } from './Billing';
import type { BillingSummary } from '@/lib/billing';

// S3.3 — billing-surface smoke test (Wave 3). No test existed for this
// surface before; mirrors the Alerts.test.tsx pattern (mock the data
// hook, render through QueryClientProvider + MemoryRouter, assert on
// rendered content) since it's the only precedent in this package.

vi.mock('@/lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing')>();
  return {
    ...actual,
    useBillingSummary: vi.fn(),
    useCheckoutSession: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
    usePortalSession: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  };
});

import { useBillingSummary } from '@/lib/billing';

const BASE_SUMMARY: BillingSummary = {
  org_id: 42,
  plan: {
    id: 'professional',
    display_name: 'Professional',
    monthly_price_cents: 149900,
    trial_days: 14,
    included_modules: ['brand_protection', 'threat_intel'],
    description: 'For growing security teams.',
    is_active: true,
  },
  per_module_subscriptions: [],
  active_overrides: [],
  effective_monthly_total_cents: 149900,
  trial_ends_at: null,
  billing_status: 'active',
};

function mockBilling(overrides: Partial<UseQueryResult<BillingSummary>> = {}) {
  vi.mocked(useBillingSummary).mockReturnValue({
    data: BASE_SUMMARY,
    isLoading: false,
    error: null,
    ...overrides,
  } as unknown as UseQueryResult<BillingSummary>);
}

function renderBillingAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Billing />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Billing — tenant billing surface smoke test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the plan, monthly total, status, and manage-billing CTA for an active subscription', () => {
    mockBilling();
    renderBillingAt('/settings/billing');

    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.getAllByText('$1,499').length).toBeGreaterThan(0);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Manage in Stripe/ })).toBeInTheDocument();
  });

  it('shows the loading state while the query is in flight', () => {
    mockBilling({ data: undefined, isLoading: true });
    renderBillingAt('/settings/billing');

    expect(screen.getByText(/Loading billing/)).toBeInTheDocument();
    expect(screen.queryByText('Professional')).not.toBeInTheDocument();
  });

  it('shows the unbilled empty state with no plan assigned', () => {
    mockBilling({
      data: {
        ...BASE_SUMMARY,
        plan: null,
        effective_monthly_total_cents: 0,
        billing_status: 'unbilled',
      },
    });
    renderBillingAt('/settings/billing');

    expect(screen.getByText('No plan assigned yet.')).toBeInTheDocument();
    expect(screen.getByText('Start your subscription')).toBeInTheDocument();
    expect(screen.getByText(/isn't on a billed plan yet/)).toBeInTheDocument();
  });
});
