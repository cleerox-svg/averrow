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
