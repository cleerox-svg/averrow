// Error-state coverage for the OverviewV4 hero KPI tiles (Phase 0 cleanup).
// Open-alerts is now a useQuery and useIncidents.isError also feeds the
// tiles: a tile with no value shows "Couldn't load" (not "—") on failure.
// The shared home sections are stubbed — only the hero is under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { OverviewV4 } from './OverviewV4';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn(() => ({ user: { name: 'Ada Lovelace' } })) }));
// Render the final value immediately so assertions don't depend on animation.
vi.mock('react-countup', () => ({
  default: ({ end }: { end: number }) => <span>{end}</span>,
}));
vi.mock('@/features/home/sections/StatusRow', () => ({ StatusRow: () => null }));
vi.mock('@/features/home/sections/StatGrid', () => ({ StatGrid: () => null }));
vi.mock('@/features/home/sections/ThreatPulse', () => ({ ThreatPulse: () => null }));
vi.mock('@/features/home/sections/DailyBriefing', () => ({ DailyBriefing: () => null }));
vi.mock('@/features/home/sections/LatestIntel', () => ({ LatestIntel: () => null }));
vi.mock('@/features/home/sections/IntelHotlist', () => ({ IntelHotlist: () => null }));
vi.mock('@/features/home/sections/LiveActivity', () => ({ LiveActivity: () => null }));
vi.mock('@/features/home/sections/BrandMovers', () => ({ BrandMovers: () => null }));
vi.mock('@/features/home/sections/ModuleHub', () => ({ ModuleHub: () => null }));
vi.mock('@/features/home/sections/ProviderMovers', () => ({ ProviderMovers: () => null }));

import { api } from '@/lib/api';

const get = api.get as unknown as ReturnType<typeof vi.fn>;

function route(opts: { alerts: 'ok' | 'fail'; incidents: 'ok' | 'fail' }) {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/alerts/triage-summary')) {
      if (opts.alerts === 'fail') throw new Error('alerts down');
      return { success: true, data: { new_count: 42, critical_count: 1 } };
    }
    if (url.startsWith('/api/admin/incidents')) {
      if (opts.incidents === 'fail') throw new Error('incidents down');
      return {
        success: true,
        data: [
          { id: 'a', severity: 'critical' },
          { id: 'b', severity: 'critical' },
          { id: 'c', severity: 'high' },
          { id: 'd', severity: 'low' },
          { id: 'e', severity: 'low' },
        ],
      };
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('OverviewV4 — KPI tile error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Couldn\'t load" on every tile when both queries fail', async () => {
    route({ alerts: 'fail', incidents: 'fail' });
    renderWithProviders(<OverviewV4 />);

    await waitFor(() => expect(screen.getAllByText("Couldn't load")).toHaveLength(3));
    // sub-labels are replaced, and the failed value is not rendered as a number
    expect(screen.queryByText('awaiting triage')).not.toBeInTheDocument();
    expect(screen.queryByText('need eyes now')).not.toBeInTheDocument();
  });

  it('only flags the tile whose query failed (alerts ok, incidents fail)', async () => {
    route({ alerts: 'ok', incidents: 'fail' });
    renderWithProviders(<OverviewV4 />);

    // two incident-fed tiles error; open-alerts tile keeps its number + sub
    await waitFor(() => expect(screen.getAllByText("Couldn't load")).toHaveLength(2));
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('awaiting triage')).toBeInTheDocument();
  });

  it('only flags the open-alerts tile when just the alerts query fails', async () => {
    route({ alerts: 'fail', incidents: 'ok' });
    renderWithProviders(<OverviewV4 />);

    await waitFor(() => expect(screen.getAllByText("Couldn't load")).toHaveLength(1));
    expect(screen.getByText('need eyes now')).toBeInTheDocument();
    expect(screen.getByText('platform & ops')).toBeInTheDocument();
    expect(screen.queryByText('awaiting triage')).not.toBeInTheDocument();
  });

  it('renders the numbers and no error text when both queries succeed', async () => {
    route({ alerts: 'ok', incidents: 'ok' });
    renderWithProviders(<OverviewV4 />);

    // 42 open alerts, 2 critical incidents, 5 open incidents
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load")).not.toBeInTheDocument();
    expect(screen.getByText('awaiting triage')).toBeInTheDocument();
    expect(screen.getByText('need eyes now')).toBeInTheDocument();
    expect(screen.getByText('platform & ops')).toBeInTheDocument();
  });
});
