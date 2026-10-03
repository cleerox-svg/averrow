import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';
import { Threats } from './Threats';

vi.mock('@/hooks/useThreatAggregate', () => ({ useThreatAggregate: vi.fn() }));
vi.mock('./ThreatInflowChart', () => ({ ThreatInflowChart: () => null }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: 'analyst' } }) }));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ success: true, data: { threats: [], total: 0 } }), patch: vi.fn() },
}));
vi.mock('@averrow/shared/threats-table', () => ({
  ThreatsTable: () => null,
  useThreatsTable: () => ({
    state: { severity: '', type: '', status: '', country: '', brandId: '', q: '' },
    params: { limit: 50, offset: 0, sort: 'last_seen', dir: 'desc' },
    pageSize: 50,
    setFilter: vi.fn(), setSearch: vi.fn(), toggleSort: vi.fn(), setPage: vi.fn(),
  }),
}));

import { useThreatAggregate } from '@/hooks/useThreatAggregate';
const agg = useThreatAggregate as ReturnType<typeof vi.fn>;

const EMPTY_AGG = {
  total: 10, active: 5, new_24h: 0, confirmed: 1, correlated: 1, attributed: 1, addressed: 1,
  remediation_rate: 0.1, by_type: [], top_countries: [], top_brands: [], top_providers: [], top_actors: [],
  multi_brand_campaigns: [], multi_brand_actors: [], multi_brand_providers: [], surging_signals: [],
};

describe('Threats aggregate panels — failure is never empty or zero', () => {
  beforeEach(() => { stubMatchMedia(true); vi.clearAllMocks(); });

  it('shows retryable error cards and "—" tiles when the aggregate query failed', async () => {
    const refetch = vi.fn();
    agg.mockReturnValue({ data: undefined, isError: true, refetch });
    renderWithProviders(<Threats />);

    expect(screen.getByText("Couldn't load multi-brand patterns")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load surging signals")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load leaderboards")).toBeInTheDocument();
    expect(screen.queryByText(/No multi-brand patterns/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No surging signals/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load")).toHaveLength(4); // hero tiles
    expect(screen.queryByText('0%')).not.toBeInTheDocument();

    const retries = screen.getAllByRole('button', { name: /^Try again/ });
    expect(retries).toHaveLength(3);
    await userEvent.setup().click(screen.getByRole('button', { name: "Try again: Couldn't load surging signals" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows loading (not the empty copy) while the aggregate is pending', () => {
    agg.mockReturnValue({ data: undefined, isError: false, refetch: vi.fn() });
    renderWithProviders(<Threats />);
    expect(screen.queryByText(/No multi-brand patterns/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No surging signals/)).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load multi-brand patterns")).not.toBeInTheDocument();
  });

  it('a genuinely empty aggregate still shows the calm empty copy', () => {
    agg.mockReturnValue({ data: EMPTY_AGG, isError: false, refetch: vi.fn() });
    renderWithProviders(<Threats />);
    expect(screen.getByText(/No multi-brand patterns/)).toBeInTheDocument();
    expect(screen.getByText(/No surging signals/)).toBeInTheDocument();
  });

  it('a failed refetch with data on screen keeps the data', () => {
    agg.mockReturnValue({ data: EMPTY_AGG, isError: true, refetch: vi.fn() });
    renderWithProviders(<Threats />);
    expect(screen.getByText(/No multi-brand patterns/)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load multi-brand patterns")).not.toBeInTheDocument();
  });
});
