import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { BrandsV3 } from './Brands';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: 'client' } }) }));
vi.mock('./components/BrandsGrid', () => ({ BrandsGrid: () => null }));
vi.mock('@/hooks/useBrands', () => ({ useBrandStats: vi.fn() }));
vi.mock('@/hooks/useBrandMovers', () => ({ useBrandMovers: vi.fn() }));
vi.mock('@/hooks/useBrandAggregates', () => ({
  useEmailSecurityAggregate: vi.fn(),
  usePressureAggregate: vi.fn(),
  useCompositionAggregate: vi.fn(),
  usePostureAggregate: vi.fn(),
}));
vi.mock('@/hooks/useBrandCandidates', () => ({
  useBrandCandidates: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  usePromoteBrandCandidate: () => ({ mutate: vi.fn(), isPending: false }),
  useRejectBrandCandidate: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { useBrandStats } from '@/hooks/useBrands';
import { useBrandMovers } from '@/hooks/useBrandMovers';
import {
  useEmailSecurityAggregate, usePressureAggregate, useCompositionAggregate, usePostureAggregate,
} from '@/hooks/useBrandAggregates';

const hooks = [
  useBrandStats, useBrandMovers, useEmailSecurityAggregate, usePressureAggregate,
  useCompositionAggregate, usePostureAggregate,
] as Array<ReturnType<typeof vi.fn>>;

const failedQ = (refetch = vi.fn()) => ({ data: undefined, isLoading: false, isError: true, refetch });

describe('Brands Intel tab — failures are errors, never empty', () => {
  beforeEach(() => vi.clearAllMocks());

  it('every aggregate card shows a retryable error; no empty/awaiting/loading copy', async () => {
    const refetch = vi.fn();
    hooks.forEach((h) => h.mockReturnValue(failedQ(refetch)));
    renderWithProviders(<BrandsV3 />);

    expect(screen.queryByText('No threat type data yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting daily snapshot')).not.toBeInTheDocument();
    expect(screen.queryByText('No signal yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.queryByText(/No rising attack pressure/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No brand-health improvements/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load")).toHaveLength(4); // hero tiles

    // sector, attack types, email grade, dmarc, 4 pressure, composition, geo,
    // 2 score buckets, 2 posture movers, 2 movers = 16 error cards
    const retries = screen.getAllByRole('button', { name: /^Try again/ });
    expect(retries).toHaveLength(16);
    await userEvent.setup().click(screen.getByRole('button', { name: "Try again: Couldn't load attack types" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows loading state (not the empty copy) while queries are pending', () => {
    hooks.forEach((h) => h.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() }));
    renderWithProviders(<BrandsV3 />);
    expect(screen.queryByText('No threat type data yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a settled null posture aggregate keeps the calm "Awaiting daily snapshot" copy', () => {
    hooks.forEach((h) => h.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }));
    renderWithProviders(<BrandsV3 />);
    expect(screen.getAllByText('Awaiting daily snapshot').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Brands Intel tab — empty / partial API data does not crash', () => {
  beforeEach(() => vi.clearAllMocks());
  const ok = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });

  it.each([
    ['empty objects', {}],
    ['null payloads', null],
    ['empty collections', { sector_breakdown: [], top_threat_types: [], rising: [], falling: [], buckets: [] }],
  ])('renders the empty state for %s', (_name, payload) => {
    hooks.forEach((h) => h.mockReturnValue(ok(payload)));
    expect(() => renderWithProviders(<BrandsV3 />)).not.toThrow();
    expect(screen.getByText('Defense')).toBeInTheDocument();
    expect(screen.getByText(/No rising attack pressure/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('settled-but-empty aggregates render the calm empty copy in each card', () => {
    hooks.forEach((h) => h.mockReturnValue(ok({})));
    renderWithProviders(<BrandsV3 />);
    expect(screen.getByText('No threat type data yet')).toBeInTheDocument();
    expect(screen.getAllByText('No signal yet')).toHaveLength(4);
    expect(screen.getByText('No graded brands yet')).toBeInTheDocument();
  });

  it('survives wrong-typed fields (non-array / non-number) in every aggregate', () => {
    const junk = {
      sector_breakdown: 'x', top_threat_types: 5, total_tracked: 'n/a', rising: {}, falling: 'x',
      top_lookalikes: {}, top_social_imps: 'x', top_app_imps: 3, top_dark_web: null,
      health_score_buckets: 'x', exposure_score_buckets: {}, improving_brands: 'x', declining_brands: 7,
      total_scored: undefined, grades: 'x', dmarc: 4, tiers: 'x', countries: 3,
    };
    hooks.forEach((h) => h.mockReturnValue(ok(junk)));
    expect(() => renderWithProviders(<BrandsV3 />)).not.toThrow();
    expect(screen.getByText('Defense')).toBeInTheDocument();
  });

  it('a query that succeeded with null renders empty cards, never an endless Loading state', () => {
    hooks.forEach((h) => h.mockReturnValue(ok(null)));
    renderWithProviders(<BrandsV3 />);
    expect(screen.queryByText(/^Loading /)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Email security grade')).toBeInTheDocument();
    expect(screen.getByText('DMARC enforcement')).toBeInTheDocument();
    expect(screen.getByText('Catalog composition')).toBeInTheDocument();
    expect(screen.getByText('Geographic distribution')).toBeInTheDocument();
    expect(screen.getByText('No graded brands yet')).toBeInTheDocument();
    expect(screen.getByText('No HQ data resolved yet')).toBeInTheDocument();
    expect(screen.getByText('No sector data yet')).toBeInTheDocument();
  });

  it('a posture aggregate without total_scored keeps "Awaiting daily snapshot"; missing numbers read —, not 0', () => {
    hooks.forEach((h) => h.mockReturnValue(ok({})));
    renderWithProviders(<BrandsV3 />);
    expect(screen.getAllByText('Awaiting daily snapshot').length).toBeGreaterThan(0);
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    expect(screen.getByText(/^— enforcing/)).toBeInTheDocument();
  });

  it('mover and bucket rows with a missing numeric field render without NaN widths', () => {
    hooks.forEach((h) => h.mockReturnValue(ok({
      rising: [{ id: 'b1', name: 'Acme', canonical_domain: 'acme.com' }],
      falling: [],
      health_score_buckets: [{ bucket: '0-20' }],
      exposure_score_buckets: [{ bucket: '0-20' }],
    })));
    const { container } = renderWithProviders(<BrandsV3 />);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/NaN/);
  });
});
