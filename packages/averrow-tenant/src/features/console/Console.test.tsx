// Error-state coverage for Console (Phase 0 cleanup): failed queries render
// an inline ErrorCard with Retry, and the all-clear empty states must NOT
// render when a query errored (an error is not "nothing to do").
// Hooks are mocked (same pattern as Alerts.test.tsx); useTenantAlerts is
// called twice (status 'new' and 'resolved'), so the mock keys off status.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { Console } from './Console';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn(() => ({ user: null, hasOrg: true })) }));
vi.mock('@/lib/alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/alerts')>();
  return { ...actual, useTenantAlerts: vi.fn(), useCanTriage: vi.fn(() => false) };
});
vi.mock('@/lib/takedowns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/takedowns')>();
  return { ...actual, useTenantTakedowns: vi.fn() };
});

import { useTenantAlerts } from '@/lib/alerts';
import { useTenantTakedowns } from '@/lib/takedowns';

interface QState {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
  isFetching?: boolean;
  refetch?: ReturnType<typeof vi.fn>;
}

const q = (s: QState = {}) => ({
  data: undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
  ...s,
});

const EMPTY_ALERTS = { alerts: [], total: 0, severity_breakdown: [] };
const EMPTY_DRAFTS = {
  takedowns: [],
  totals: { active: 0, by_status: {} },
  status_priority: [],
};

function setup(opts: { signals?: QState; resolved?: QState; drafts?: QState }) {
  const signals = q({ data: EMPTY_ALERTS, ...opts.signals });
  const resolved = q({ data: EMPTY_ALERTS, ...opts.resolved });
  const drafts = q({ data: EMPTY_DRAFTS, ...opts.drafts });
  vi.mocked(useTenantAlerts).mockImplementation(((f: { status?: string }) =>
    f?.status === 'resolved' ? resolved : signals) as never);
  vi.mocked(useTenantTakedowns).mockReturnValue(drafts as never);
  return { signals, resolved, drafts };
}

describe('Console — error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the genuine all-clear empty states when nothing errored', () => {
    setup({});
    renderWithProviders(<Console />);

    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
    expect(screen.getByText('Nothing handled yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows an error card + Retry and hides "all caught up" when new-signals fails', () => {
    setup({ signals: { data: undefined, isError: true } });
    renderWithProviders(<Console />);

    expect(screen.getByText("Couldn't load items needing you")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    // resolved stream is healthy and empty -> its own empty state is legit
    expect(screen.getByText('Nothing handled yet')).toBeInTheDocument();
  });

  it('shows an error card and hides "all caught up" when drafts fails', () => {
    setup({ drafts: { data: undefined, isError: true } });
    renderWithProviders(<Console />);

    expect(screen.getByText("Couldn't load items needing you")).toBeInTheDocument();
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
  });

  it('shows an error card and hides "Nothing handled yet" when resolved fails', () => {
    setup({ resolved: { data: undefined, isError: true } });
    renderWithProviders(<Console />);

    expect(screen.getByText("Couldn't load handled signals")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing handled yet')).not.toBeInTheDocument();
    // needs-you stream is healthy and empty
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  it('Retry on the needs-you card refetches only the failed queries', async () => {
    const { signals, drafts, resolved } = setup({ signals: { data: undefined, isError: true } });
    renderWithProviders(<Console />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(signals.refetch).toHaveBeenCalledTimes(1);
    expect(drafts.refetch).not.toHaveBeenCalled();
    expect(resolved.refetch).not.toHaveBeenCalled();
  });

  it('Retry refetches both needs-you queries when both failed', async () => {
    const { signals, drafts } = setup({
      signals: { data: undefined, isError: true },
      drafts: { data: undefined, isError: true },
    });
    renderWithProviders(<Console />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(signals.refetch).toHaveBeenCalledTimes(1);
    expect(drafts.refetch).toHaveBeenCalledTimes(1);
  });

  it('Retry on the handled card refetches the resolved query', async () => {
    const { signals, resolved } = setup({ resolved: { data: undefined, isError: true } });
    renderWithProviders(<Console />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(resolved.refetch).toHaveBeenCalledTimes(1);
    expect(signals.refetch).not.toHaveBeenCalled();
  });

  it('KPI tiles and stream counts show "—" + "Couldn\'t load" instead of 0 on failure', () => {
    setup({
      signals: { data: undefined, isError: true },
      drafts: { data: undefined, isError: true },
      resolved: { data: undefined, isError: true },
    });
    renderWithProviders(<Console />);

    // Needs you, Drafts, In flight, Handled tiles
    expect(screen.getAllByText("Couldn't load")).toHaveLength(4);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('keeps showing real counts when a background refetch fails but data is cached', () => {
    setup({ signals: { data: EMPTY_ALERTS, isError: true } });
    renderWithProviders(<Console />);

    expect(screen.queryByText("Couldn't load items needing you")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load")).not.toBeInTheDocument();
    expect(screen.getByText("You're all caught up")).toBeInTheDocument();
  });

  it('disables Retry and shows "Retrying…" while the failed query is fetching', () => {
    setup({ signals: { data: undefined, isError: true, isFetching: true } });
    renderWithProviders(<Console />);

    const btn = screen.getByRole('button', { name: 'Retrying…' });
    expect(btn).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
