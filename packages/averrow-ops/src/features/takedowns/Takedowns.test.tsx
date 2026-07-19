import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/test/utils';
import { ToastProvider } from '@/components/ui/Toast';
import { createMockTakedown } from '@/test/mocks';
import { Takedowns } from './Takedowns';

// Two data hooks now back the page (S2.3 T3/F1): useAdminTakedowns for the
// Authorized queue (single paginated page, unchanged) and useAdminTakedownsAll
// for the Prospect rollup (page-drained to completion — see useTakedowns.ts).
// Both are called unconditionally every render (rules of hooks) and gated
// with `enabled`, so both must be mocked even in authorized-only tests.
vi.mock('@/hooks/useTakedowns', () => ({
  useAdminTakedowns: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
  }),
  useAdminTakedownsAll: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
  }),
  useUpdateTakedown: vi.fn().mockReturnValue({
    mutate: vi.fn(),
  }),
}));

import { useAdminTakedowns, useAdminTakedownsAll, useUpdateTakedown } from '@/hooks/useTakedowns';

// Debug sibling that surfaces the MemoryRouter's current location so tests
// can assert on URL-param mutations (setSearchParams calls) without reaching
// into router internals.
function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location-display">{location.pathname}{location.search}</div>;
}

function renderTakedownsAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <Takedowns />
          <LocationDisplay />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Takedowns Page', () => {
  const mockTakedowns = [
    createMockTakedown({ status: 'draft', target_platform: 'github' }),
    createMockTakedown({ id: 'td-002', status: 'submitted', target_value: 'evil.com', severity: 'CRITICAL', target_platform: null }),
  ];

  const mockData = {
    takedowns: mockTakedowns,
    total: 2,
    statusCounts: [
      { status: 'draft', count: 1 },
      { status: 'submitted', count: 1 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({
      data: mockData,
      isLoading: false,
    });
    // These tests all exercise the default Authorized scope, so the Prospect
    // drain hook is present (rules of hooks) but disabled/idle.
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: null,
      isLoading: false,
    });
    (useUpdateTakedown as ReturnType<typeof vi.fn>).mockReturnValue({
      mutate: vi.fn(),
    });
  });

  it('renders takedown list', () => {
    renderWithProviders(<Takedowns />);
    expect(screen.getByText('phishing.test.com')).toBeInTheDocument();
    expect(screen.getByText('evil.com')).toBeInTheDocument();
  });

  it('renders stat cards with correct values', () => {
    renderWithProviders(<Takedowns />);
    expect(screen.getByText('Total Takedowns')).toBeInTheDocument();
    expect(screen.getByText('Pending Review')).toBeInTheDocument();
    // "Submitted" and "Resolved" also appear as status labels on the takedown
    // cards — stat-card label + card status pill — so we expect ≥1 match.
    expect(screen.getAllByText('Submitted').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Resolved').length).toBeGreaterThanOrEqual(1);
  });

  it('renders status filter pills', () => {
    renderWithProviders(<Takedowns />);
    const allButtons = screen.getAllByText('ALL', { selector: 'button' });
    expect(allButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('DRAFT', { selector: 'button' })).toBeInTheDocument();
    expect(screen.getByText('SUBMITTED', { selector: 'button' })).toBeInTheDocument();
  });

  it('renders type filter pills', () => {
    renderWithProviders(<Takedowns />);
    expect(screen.getByText('SOCIAL', { selector: 'button' })).toBeInTheDocument();
    expect(screen.getByText('URL', { selector: 'button' })).toBeInTheDocument();
    expect(screen.getByText('DOMAIN', { selector: 'button' })).toBeInTheDocument();
  });

  it('renders platform identity', () => {
    renderWithProviders(<Takedowns />);
    expect(screen.getByText(/GitHub/)).toBeInTheDocument();
  });

  it('shows loading state when loading', () => {
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({
      data: null,
      isLoading: true,
    });
    const { container } = renderWithProviders(<Takedowns />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('opens takedown detail panel on View Detail click', async () => {
    renderWithProviders(<Takedowns />);
    const viewButtons = screen.getAllByText('View Detail');
    await userEvent.click(viewButtons[0]);
    // ReportPanel renders ## headings from buildTakedownReport (uppercase via CSS)
    expect(screen.getByText('Target')).toBeInTheDocument();
    expect(screen.getByText('Evidence')).toBeInTheDocument();
  });

  it('shows search input', () => {
    renderWithProviders(<Takedowns />);
    expect(screen.getByPlaceholderText('Search by brand, handle, or URL...')).toBeInTheDocument();
  });
});

// ─── S2.3 T3: Authorized / Prospect scope split ─────────────────────────

describe('Takedowns — scope toggle', () => {
  const mockTakedowns = [
    createMockTakedown({ status: 'draft', target_platform: 'github' }),
    createMockTakedown({ id: 'td-002', status: 'submitted', target_value: 'evil.com', severity: 'CRITICAL', target_platform: null }),
  ];
  const mockData = {
    takedowns: mockTakedowns,
    total: 2,
    statusCounts: [
      { status: 'draft', count: 1 },
      { status: 'submitted', count: 1 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({ data: mockData, isLoading: false });
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        takedowns: mockTakedowns,
        total: 2,
        statusCounts: [{ status: 'draft', count: 2 }],
        scope: 'prospect',
        truncated: false,
      },
      isLoading: false,
    });
    (useUpdateTakedown as ReturnType<typeof vi.fn>).mockReturnValue({ mutate: vi.fn() });
  });

  it('defaults to the authorized scope with both Authorized and Prospect tabs present', () => {
    renderWithProviders(<Takedowns />);

    const authorizedTab = screen.getByRole('tab', { name: 'Authorized' });
    const prospectTab = screen.getByRole('tab', { name: 'Prospect' });
    expect(authorizedTab).toBeInTheDocument();
    expect(prospectTab).toBeInTheDocument();
    expect(authorizedTab).toHaveAttribute('aria-selected', 'true');
    expect(prospectTab).toHaveAttribute('aria-selected', 'false');

    // Authorized-mode stat cards, not the prospect ones.
    expect(screen.getByText('Total Takedowns')).toBeInTheDocument();
    expect(screen.queryByText('Total Drafts')).not.toBeInTheDocument();
  });

  it('the initial useAdminTakedowns call defaults scope to authorized and is enabled', () => {
    renderWithProviders(<Takedowns />);
    const firstCallArgs = (useAdminTakedowns as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const firstQueryOptions = (useAdminTakedowns as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(firstCallArgs.scope).toBe('authorized');
    expect(firstQueryOptions.enabled).toBe(true);

    // The prospect drain hook exists too (rules of hooks — both branches are
    // always called) but starts disabled since Authorized is the default scope.
    const firstDrainArgs = (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstDrainArgs.scope).toBe('prospect');
    expect(firstDrainArgs.enabled).toBe(false);
  });

  it('clicking Prospect enables useAdminTakedownsAll (and disables useAdminTakedowns) and swaps in the prospect stat cards', async () => {
    renderWithProviders(<Takedowns />);

    await userEvent.click(screen.getByRole('tab', { name: 'Prospect' }));

    const lastDrainArgs = (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(lastDrainArgs.scope).toBe('prospect');
    expect(lastDrainArgs.enabled).toBe(true);

    const lastAuthorizedQueryOptions = (useAdminTakedowns as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(lastAuthorizedQueryOptions.enabled).toBe(false);

    // Prospect stat labels replace the authorized status-workflow stats.
    expect(screen.getByText('Brands')).toBeInTheDocument();
    expect(screen.getByText('Total Drafts')).toBeInTheDocument();
    expect(screen.getByText('High/Critical')).toBeInTheDocument();
    expect(screen.getByText('Evidence Points')).toBeInTheDocument();
    expect(screen.queryByText('Total Takedowns')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending Review')).not.toBeInTheDocument();
  });

  it('prospect mode requests only { scope, brand_id, enabled } from useAdminTakedownsAll — no authorized-only filter/sort/limit params leak in (F1)', async () => {
    renderWithProviders(<Takedowns />);
    await userEvent.click(screen.getByRole('tab', { name: 'Prospect' }));

    const lastDrainArgs = (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    // DrainFilters has no status/target_type/sort/search/limit fields at all —
    // page-draining to completion is an internal concern of the hook now
    // (see useTakedowns.ts), not something the page dictates via `limit`.
    expect(lastDrainArgs).toEqual({ scope: 'prospect', brand_id: undefined, enabled: true });
  });
});

describe('Takedowns — prospect brand grouping', () => {
  const prospectTakedowns = [
    createMockTakedown({
      id: 'p1', brand_id: 'brand_a', brand_name: 'Brand A', brand_domain: 'brand-a.com',
      severity: 'HIGH', priority_score: 60, evidence_count: 3,
    }),
    createMockTakedown({
      id: 'p2', brand_id: 'brand_a', brand_name: 'Brand A', brand_domain: 'brand-a.com',
      severity: 'CRITICAL', priority_score: 90, evidence_count: 5,
    }),
    createMockTakedown({
      id: 'p3', brand_id: 'brand_b', brand_name: 'Brand B', brand_domain: 'brand-b.com',
      severity: 'LOW', priority_score: 20, evidence_count: 1,
    }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Authorized branch is inactive in these tests but still mounted
    // (rules of hooks) — give it a harmless default.
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: false });
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { takedowns: prospectTakedowns, total: 3, statusCounts: [{ status: 'draft', count: 3 }], scope: 'prospect', truncated: false },
      isLoading: false,
    });
    (useUpdateTakedown as ReturnType<typeof vi.fn>).mockReturnValue({ mutate: vi.fn() });
  });

  it('collapses drafts sharing a brand_id into one card with the correct draft count, severity mix, peak priority, and summed evidence', () => {
    renderTakedownsAt('/takedowns?scope=prospect');

    // One card per brand, not one per draft.
    expect(screen.getByText('Brand A')).toBeInTheDocument();
    expect(screen.getByText('Brand B')).toBeInTheDocument();
    expect(screen.getByText('2 DRAFTS')).toBeInTheDocument();
    expect(screen.getByText('1 DRAFT')).toBeInTheDocument();

    // Severity mix per group.
    expect(screen.getByText('1 CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('1 HIGH')).toBeInTheDocument();
    expect(screen.getByText('1 LOW')).toBeInTheDocument();

    // Peak priority = max(60, 90) = 90 for Brand A; 20 for Brand B.
    expect(screen.getByText('PEAK PRIORITY 90/100')).toBeInTheDocument();
    expect(screen.getByText('PEAK PRIORITY 20/100')).toBeInTheDocument();

    // Summed evidence = 3 + 5 = 8 for Brand A; 1 for Brand B.
    expect(screen.getByText('8 evidence')).toBeInTheDocument();
    expect(screen.getByText('1 evidence')).toBeInTheDocument();
  });

  it('gives each severity badge its own distinct color — no tier-shifting (D1)', () => {
    renderTakedownsAt('/takedowns?scope=prospect');

    // Badge's SEV config (components/ui/Badge.tsx): critical=#fca5a5,
    // high=#fdba74, low=#93c5fd. Before D1, SEVERITY_TO_BADGE shifted a
    // tier — HIGH mapped to 'critical' (rendering #fca5a5, the CRITICAL
    // color) and MEDIUM mapped to 'high' — so this pins each label to its
    // OWN color and specifically rules out the old critical-red bleed onto
    // HIGH.
    expect(screen.getByText('1 CRITICAL')).toHaveStyle({ color: '#fca5a5' });
    expect(screen.getByText('1 HIGH')).toHaveStyle({ color: '#fdba74' });
    expect(screen.getByText('1 LOW')).toHaveStyle({ color: '#93c5fd' });
  });

  it('sorts brand groups by peak priority descending', () => {
    renderTakedownsAt('/takedowns?scope=prospect');

    const brandNames = screen.getAllByText(/^Brand [AB]$/).map((el) => el.textContent);
    // Brand A (peak 90) must precede Brand B (peak 20).
    expect(brandNames).toEqual(['Brand A', 'Brand B']);
  });

  it('shows the prospect empty state when there are no orgless drafts', () => {
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { takedowns: [], total: 0, statusCounts: [], scope: 'prospect', truncated: false },
      isLoading: false,
    });
    renderTakedownsAt('/takedowns?scope=prospect');

    expect(screen.getByText('No orgless drafts')).toBeInTheDocument();
    expect(screen.queryByText('Brand A')).not.toBeInTheDocument();
  });

  it('renders "View full risk surface" as a real link to the brand risk tab (D2 — supports middle-click/ctrl-click/new-tab)', () => {
    renderTakedownsAt('/takedowns?scope=prospect');

    const links = screen.getAllByRole('link', { name: 'View full risk surface →' });
    // Sorted first = Brand A (peak priority 90) = brand_a.
    expect(links[0]).toHaveAttribute('href', '/brands/brand_a?tab=risk');
    // Second group = Brand B (peak priority 20) = brand_b.
    expect(links[1]).toHaveAttribute('href', '/brands/brand_b?tab=risk');
  });

  // ─── F1/F2 fixes: page-drain safety cap + accurate headline total ────

  it('shows the safety-cap indicator when the drain hits its page limit (F1)', () => {
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        takedowns: prospectTakedowns, // only the first "page" — deliberately smaller than `total`
        total: 12_000, // the true server-side scoped count, far beyond what was drained
        statusCounts: [{ status: 'draft', count: 12_000 }],
        scope: 'prospect',
        truncated: true,
      },
      isLoading: false,
    });
    renderTakedownsAt('/takedowns?scope=prospect');

    expect(screen.getByText(/safety cap reached/i)).toBeInTheDocument();
  });

  it('does not show the safety-cap indicator when the drain completes normally', () => {
    renderTakedownsAt('/takedowns?scope=prospect');
    expect(screen.queryByText(/safety cap reached/i)).not.toBeInTheDocument();
  });
});

describe('Takedowns — URL param sync', () => {
  const prospectTakedowns = [
    createMockTakedown({ id: 'p1', brand_id: 'brand_a', brand_name: 'Brand A', priority_score: 60, evidence_count: 2 }),
  ];
  const authorizedData = {
    takedowns: [createMockTakedown({ status: 'draft' })],
    total: 1,
    statusCounts: [{ status: 'draft', count: 1 }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useUpdateTakedown as ReturnType<typeof vi.fn>).mockReturnValue({ mutate: vi.fn() });
    // Harmless defaults — individual tests below override whichever branch
    // (authorized vs. prospect) is actually active for that render.
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: false });
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({ data: null, isLoading: false });
  });

  it('initializes to prospect scope when the URL has ?scope=prospect on mount', () => {
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { takedowns: prospectTakedowns, total: 1, statusCounts: [{ status: 'draft', count: 1 }], scope: 'prospect', truncated: false },
      isLoading: false,
    });
    renderTakedownsAt('/takedowns?scope=prospect');

    expect(screen.getByRole('tab', { name: 'Prospect' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Brands')).toBeInTheDocument();
    const firstDrainArgs = (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstDrainArgs.scope).toBe('prospect');
    expect(firstDrainArgs.enabled).toBe(true);
  });

  it('resolves an out-of-set ?scope=all back to authorized (F3 — no tabless state)', () => {
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({ data: authorizedData, isLoading: false });
    renderTakedownsAt('/takedowns?scope=all');

    const authorizedTab = screen.getByRole('tab', { name: 'Authorized' });
    const prospectTab = screen.getByRole('tab', { name: 'Prospect' });
    expect(authorizedTab).toHaveAttribute('aria-selected', 'true');
    expect(prospectTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Total Takedowns')).toBeInTheDocument();
  });

  it('initializes scope + brand filter from ?scope=prospect&brand=<id> and shows the brand filter chip', () => {
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { takedowns: prospectTakedowns, total: 1, statusCounts: [{ status: 'draft', count: 1 }], scope: 'prospect', truncated: false },
      isLoading: false,
    });
    renderTakedownsAt('/takedowns?scope=prospect&brand=brand_a');

    const firstDrainArgs = (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstDrainArgs.scope).toBe('prospect');
    expect(firstDrainArgs.brand_id).toBe('brand_a');
    expect(screen.getByText(/Filtered to brand:/)).toBeInTheDocument();
    // "Brand A" appears both in the filter chip and the prospect card itself.
    expect(screen.getAllByText('Brand A').length).toBeGreaterThanOrEqual(2);
  });

  it('clicking the Prospect tab updates the URL to ?scope=prospect', async () => {
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({ data: authorizedData, isLoading: false });
    renderTakedownsAt('/takedowns');

    await userEvent.click(screen.getByRole('tab', { name: 'Prospect' }));

    expect(screen.getByTestId('location-display')).toHaveTextContent('/takedowns?scope=prospect');
  });

  it('the brand-filter chip is absent when ?brand= is not set', () => {
    (useAdminTakedowns as ReturnType<typeof vi.fn>).mockReturnValue({ data: authorizedData, isLoading: false });
    renderTakedownsAt('/takedowns');
    expect(screen.queryByText(/Filtered to brand:/)).not.toBeInTheDocument();
  });

  it('"Clear" removes only the brand param, leaving scope intact in the URL', async () => {
    (useAdminTakedownsAll as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { takedowns: prospectTakedowns, total: 1, statusCounts: [{ status: 'draft', count: 1 }], scope: 'prospect', truncated: false },
      isLoading: false,
    });
    renderTakedownsAt('/takedowns?scope=prospect&brand=brand_a');

    expect(screen.getByTestId('location-display')).toHaveTextContent('scope=prospect');
    expect(screen.getByTestId('location-display')).toHaveTextContent('brand=brand_a');

    await userEvent.click(screen.getByText('Clear'));

    const locationText = screen.getByTestId('location-display').textContent ?? '';
    expect(locationText).toContain('scope=prospect');
    expect(locationText).not.toContain('brand=brand_a');
    expect(screen.queryByText(/Filtered to brand:/)).not.toBeInTheDocument();
  });
});
