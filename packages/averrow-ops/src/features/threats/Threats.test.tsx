import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
// The mock honours `initial` the way the real hook does, so the seeded filters reach the request.
const tableInitial = vi.hoisted(() => ({ calls: [] as Array<Record<string, string> | undefined> }));
vi.mock('@averrow/shared/threats-table', () => ({
  ThreatsTable: () => null,
  useThreatsTable: (opts?: { initial?: Record<string, string> }) => {
    tableInitial.calls.push(opts?.initial);
    return {
      state: { severity: '', type: '', status: '', country: '', brandId: '', q: '', ...opts?.initial },
      params: { limit: 50, offset: 0, sort: 'last_seen', dir: 'desc' },
      pageSize: 50,
      setFilter: vi.fn(), setSearch: vi.fn(), toggleSort: vi.fn(), setPage: vi.fn(),
    };
  },
}));

import { useThreatAggregate } from '@/hooks/useThreatAggregate';
import { api } from '@/lib/api';
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

describe('Threats aggregate — degraded sections (fail-soft 200)', () => {
  beforeEach(() => { stubMatchMedia(true); vi.clearAllMocks(); });

  it('degraded multi_brand: Coordination shows the error, hero tiles still render', async () => {
    const refetch = vi.fn();
    agg.mockReturnValue({ data: { ...EMPTY_AGG, degraded_sections: ['multi_brand'] }, isError: false, refetch });
    renderWithProviders(<Threats />);
    expect(screen.getByText("Couldn't load multi-brand patterns")).toBeInTheDocument();
    expect(screen.queryByText(/No multi-brand patterns/)).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load")).not.toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // Active tile
    expect(screen.getByText(/multi-brand unavailable/)).toBeInTheDocument();
    expect(screen.getByText('Retrying automatically.')).toBeInTheDocument();
    expect(screen.getByText(/No surging signals/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: "Try again: Couldn't load multi-brand patterns" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('degraded headline: hero tiles show the error, not zeros, and the slice strip is hidden', () => {
    agg.mockReturnValue({ data: { ...EMPTY_AGG, total: 5, degraded_sections: ['headline'] }, isError: false, refetch: vi.fn() });
    renderWithProviders(<Threats />);
    expect(screen.getAllByText("Couldn't load")).toHaveLength(4);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText(/Across catalog/)).not.toBeInTheDocument();
    expect(screen.queryByText(/in slice/)).not.toBeInTheDocument();
  });

  it('degraded attribution: only the Correlated tile fails', () => {
    agg.mockReturnValue({ data: { ...EMPTY_AGG, degraded_sections: ['attribution'] }, isError: false, refetch: vi.fn() });
    renderWithProviders(<Threats />);
    expect(screen.getAllByText("Couldn't load")).toHaveLength(1);
    expect(screen.getByText(/attribution unavailable/)).toBeInTheDocument(); // Addressed tile
    expect(screen.getByText('unavailable')).toBeInTheDocument(); // slice strip stat
    expect(screen.getByText('Correlated / Attributed')).toBeInTheDocument();
  });

  it('degraded top_brands: only that leaderboard errors; all four degraded collapses to one panel error', () => {
    agg.mockReturnValue({ data: { ...EMPTY_AGG, degraded_sections: ['top_brands'] }, isError: false, refetch: vi.fn() });
    const { unmount } = renderWithProviders(<Threats />);
    expect(screen.getByText("Couldn't load top brands")).toBeInTheDocument();
    expect(screen.getByText('Top actors')).toBeInTheDocument();
    unmount();
    agg.mockReturnValue({ data: { ...EMPTY_AGG, degraded_sections: ['top_brands', 'top_providers', 'top_actors', 'top_countries'] }, isError: false, refetch: vi.fn() });
    renderWithProviders(<Threats />);
    expect(screen.getByText("Couldn't load leaderboards")).toBeInTheDocument();
  });
});

describe('Threats deep links seed the table filters (Observatory "Open in Threats")', () => {
  beforeEach(() => { stubMatchMedia(true); vi.clearAllMocks(); tableInitial.calls.length = 0; });
  afterEach(() => { window.history.pushState({}, '', '/'); });

  it('?country=XX&brand_id=b1 seeds the country and brand filters and sends them to the API', async () => {
    window.history.pushState({}, '', '/?country=nl&brand_id=b_1');
    agg.mockReturnValue({ data: EMPTY_AGG, isError: false, refetch: vi.fn() });
    renderWithProviders(<Threats />);
    expect(tableInitial.calls[0]).toEqual({ brandId: 'b_1', country: 'NL' });
    expect(agg).toHaveBeenCalledWith(expect.objectContaining({ country: 'NL', brand_id: 'b_1' }));
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(c => String(c[0]).startsWith('/api/threats?'))).toBe(true));
    const url = String(vi.mocked(api.get).mock.calls.find(c => String(c[0]).startsWith('/api/threats?'))![0]);
    expect(url).toContain('country=NL');
    expect(url).toContain('brand_id=b_1');
  });

  it('ignores a malformed country and seeds nothing without params', () => {
    agg.mockReturnValue({ data: EMPTY_AGG, isError: false, refetch: vi.fn() });
    window.history.pushState({}, '', '/?country=%27%3B');
    renderWithProviders(<Threats />);
    expect(tableInitial.calls[0]).toBeUndefined();
  });
});
