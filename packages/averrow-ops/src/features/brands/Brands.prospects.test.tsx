// /api/admin/brand-candidates is requireAdmin: the Prospects tab and the Intel
// teaser are admin+ only, and other roles must not request the endpoint.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { BrandsV3 } from './Brands';

const mocks = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));
vi.mock('./components/BrandsGrid', () => ({ BrandsGrid: () => null }));
const pending = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
vi.mock('@/hooks/useBrands', () => ({ useBrandStats: () => pending }));
vi.mock('@/hooks/useBrandMovers', () => ({ useBrandMovers: () => pending }));
vi.mock('@/hooks/useBrandAggregates', () => ({
  useEmailSecurityAggregate: () => pending,
  usePressureAggregate: () => pending,
  useCompositionAggregate: () => pending,
  usePostureAggregate: () => pending,
}));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

import { api } from '@/lib/api';
const get = api.get as unknown as ReturnType<typeof vi.fn>;

describe('Brands prospects role gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ success: true, data: [], total: 0 });
  });

  it.each(['analyst', 'sales', 'support', 'billing', 'auditor'])('%s sees no Prospects tab and fires no candidates request', async (role) => {
    mocks.role = role;
    renderWithProviders(<BrandsV3 />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('button', { name: /Prospects/ })).not.toBeInTheDocument();
    expect(get.mock.calls.filter((c) => String(c[0]).includes('/api/admin/brand-candidates'))).toEqual([]);
  });

  it.each(['admin', 'super_admin'])('%s sees the Prospects tab', async (role) => {
    mocks.role = role;
    renderWithProviders(<BrandsV3 />);
    expect(await screen.findByRole('button', { name: /Prospects/ })).toBeInTheDocument();
  });
});
