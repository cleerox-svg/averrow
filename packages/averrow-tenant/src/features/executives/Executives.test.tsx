import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';
import { renderWithProviders } from '@/test/utils';
import { Executives } from './Executives';
import type { DashboardBrand, DashboardResponse } from '@/lib/dashboard';
import type { Executive } from '@/lib/executives';
import type { AlertsResponse } from '@/lib/alerts';

// EXEC_IMPERSONATION_2026-07 Stage 5 — first component test in
// averrow-tenant. Mocks every data hook the page calls so the test
// controls loading/empty/populated/error states directly, and keeps the
// real validators/constants from '@/lib/executives' (only the data hooks
// are replaced) so form validation is exercised for real.

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/dashboard', () => ({ useTenantDashboard: vi.fn() }));
vi.mock('@/lib/alerts', () => ({ useTenantAlerts: vi.fn() }));
vi.mock('@/lib/executives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/executives')>();
  return {
    ...actual,
    useOrgExecutives: vi.fn(),
    useCreateExecutive: vi.fn(),
    useUpdateExecutive: vi.fn(),
    useDeleteExecutive: vi.fn(),
  };
});

import { useAuth } from '@/lib/auth';
import { useTenantDashboard } from '@/lib/dashboard';
import { useTenantAlerts } from '@/lib/alerts';
import { useOrgExecutives, useCreateExecutive, useUpdateExecutive, useDeleteExecutive } from '@/lib/executives';

function makeBrand(overrides: Partial<DashboardBrand> = {}): DashboardBrand {
  return {
    id: 'brand-1',
    name: 'Acme Corp',
    canonical_domain: 'acme.com',
    sector: null,
    threat_count: 0,
    exposure_score: null,
    email_security_grade: null,
    social_risk_score: null,
    last_social_scan: null,
    last_threat_seen: null,
    is_primary: 1,
    active_threats: 0,
    social_profiles_count: 0,
    impersonation_count: 0,
    ...overrides,
  };
}

function makeExecutive(overrides: Partial<Executive> = {}): Executive {
  return {
    id: 'exec-1',
    org_id: '1',
    brand_id: 'brand-1',
    full_name: 'Jane Doe',
    title: 'Chief Executive Officer',
    official_handles: { twitter: 'janedoe' },
    watch_platforms: ['twitter', 'linkedin'],
    status: 'active',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockAuth(orgRole: string, globalRole = 'client') {
  vi.mocked(useAuth).mockReturnValue({
    user: {
      id: 'u1', email: 'x@example.com', name: 'X', role: globalRole,
      organization: { id: 1, name: 'Acme Org', slug: 'acme', plan: 'business', role: orgRole },
    },
    hasOrg: true,
    loading: false,
  } as unknown as ReturnType<typeof useAuth>);
}

function mockDashboard(brands: DashboardBrand[]) {
  vi.mocked(useTenantDashboard).mockReturnValue({
    data: {
      total_brands: brands.length,
      total_active_threats: 0,
      total_alerts_open: 0,
      total_social_profiles: 0,
      total_impersonation_alerts: 0,
      avg_exposure_score: null,
      brands,
      recent_alerts: [],
      threat_trend: [],
    } satisfies DashboardResponse,
    isLoading: false,
  } as unknown as UseQueryResult<DashboardResponse>);
}

function mockAlerts(response: Partial<AlertsResponse> = {}) {
  vi.mocked(useTenantAlerts).mockReturnValue({
    data: { alerts: [], total: 0, severity_breakdown: [], ...response },
    isLoading: false,
    error: null,
  } as unknown as UseQueryResult<AlertsResponse>);
}

function mockExecutives(data: Executive[] | undefined, opts: { isLoading?: boolean; error?: Error | null } = {}) {
  vi.mocked(useOrgExecutives).mockReturnValue({
    data,
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
  } as unknown as UseQueryResult<Executive[]>);
}

function mockMutations() {
  const create = vi.fn();
  const update = vi.fn();
  const del = vi.fn();
  vi.mocked(useCreateExecutive).mockReturnValue({
    mutate: create, isPending: false, error: null,
  } as unknown as ReturnType<typeof useCreateExecutive>);
  vi.mocked(useUpdateExecutive).mockReturnValue({
    mutate: update, isPending: false, error: null,
  } as unknown as ReturnType<typeof useUpdateExecutive>);
  vi.mocked(useDeleteExecutive).mockReturnValue({
    mutate: del, isPending: false, isError: false, error: null,
  } as unknown as ReturnType<typeof useDeleteExecutive>);
  return { create, update, del };
}

describe('Executives page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAlerts();
  });

  it('shows the empty state when the org has no registered executives', () => {
    mockAuth('admin');
    mockDashboard([makeBrand()]);
    mockExecutives([]);
    mockMutations();

    renderWithProviders(<Executives />);

    expect(
      screen.getByText('No executives registered — add one to start monitoring for impersonation.'),
    ).toBeInTheDocument();
  });

  it('renders a registered executive with name, title, and watched platforms', () => {
    mockAuth('admin');
    mockDashboard([makeBrand()]);
    mockExecutives([makeExecutive()]);
    mockMutations();

    renderWithProviders(<Executives />);

    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Chief Executive Officer')).toBeInTheDocument();
    expect(screen.getByText('X / Twitter')).toBeInTheDocument();
    expect(screen.getByText('LinkedIn')).toBeInTheDocument();
  });

  it('hides mutation controls and shows the read-only notice for a non-admin org role', () => {
    mockAuth('viewer');
    mockDashboard([makeBrand()]);
    mockExecutives([makeExecutive()]);
    mockMutations();

    renderWithProviders(<Executives />);

    expect(screen.getByText(/Org admins and owners can register, edit, and remove executives/)).toBeInTheDocument();
    expect(screen.queryByText('Register executive')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Edit executive')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Remove executive')).not.toBeInTheDocument();
  });

  it('shows edit/delete controls for an org admin', () => {
    mockAuth('admin');
    mockDashboard([makeBrand()]);
    mockExecutives([makeExecutive()]);
    mockMutations();

    renderWithProviders(<Executives />);

    expect(screen.getByTitle('Edit executive')).toBeInTheDocument();
    expect(screen.getByTitle('Remove executive')).toBeInTheDocument();
  });

  it('confirms before deleting, and calls the delete mutation only on confirm', async () => {
    const user = userEvent.setup();
    mockAuth('admin');
    mockDashboard([makeBrand()]);
    mockExecutives([makeExecutive()]);
    const { del } = mockMutations();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<Executives />);
    await user.click(screen.getByTitle('Remove executive'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByTitle('Remove executive'));
    expect(del).toHaveBeenCalledWith('exec-1');

    confirmSpy.mockRestore();
  });

  it('blocks submit and shows a validation error for an empty name', async () => {
    const user = userEvent.setup();
    mockAuth('admin');
    mockDashboard([makeBrand()]);
    mockExecutives([]);
    const { create } = mockMutations();

    renderWithProviders(<Executives />);
    await user.click(screen.getByText('Register executive'));

    const nameInput = screen.getByLabelText('Full name');
    await user.clear(nameInput);
    await user.click(screen.getByText('Register executive', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('submits a valid create form with the selected brand and platforms', async () => {
    const user = userEvent.setup();
    mockAuth('admin');
    mockDashboard([makeBrand({ id: 'brand-1', name: 'Acme Corp' })]);
    mockExecutives([]);
    const { create } = mockMutations();

    renderWithProviders(<Executives />);
    await user.click(screen.getByText('Register executive'));
    await user.type(screen.getByLabelText('Full name'), 'John Smith');
    await user.click(screen.getByText('Register executive', { selector: 'button[type="submit"]' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [input] = create.mock.calls[0] as [Record<string, unknown>];
    expect(input.brand_id).toBe('brand-1');
    expect(input.full_name).toBe('John Smith');
    expect(Array.isArray(input.watch_platforms)).toBe(true);
    expect((input.watch_platforms as string[]).length).toBeGreaterThan(0);
  });
});
