import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { createMockBrand } from '@/test/mocks';
import { Brands } from './Brands';

// vi.mock factories are hoisted — cannot reference variables declared outside
vi.mock('@/hooks/useBrands', () => ({
  useBrands: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
  }),
  useBrandStats: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
  }),
  useToggleMonitor: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
  useAddBrand: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

import { useBrands, useBrandStats } from '@/hooks/useBrands';

describe('Brands Page', () => {
  const mockBrands = [
    createMockBrand(),
    createMockBrand({ id: 'brand_2', name: 'Second Brand', threat_count: 100, canonical_domain: 'second.com' }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (useBrands as any).mockReturnValue({
      data: mockBrands,
      isLoading: false,
    });
    (useBrandStats as any).mockReturnValue({
      data: { total_tracked: 9333, new_this_week: 12, fastest_rising: null, fastest_rising_pct: 0, top_threat_type: 'phishing', top_threat_type_pct: 68 },
      isLoading: false,
    });
  });

  it('renders brand rows after loading', () => {
    renderWithProviders(<Brands />);
    expect(screen.getByText('Test Brand')).toBeInTheDocument();
    expect(screen.getByText('Second Brand')).toBeInTheDocument();
  });

  it('shows threat counts', () => {
    renderWithProviders(<Brands />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('renders stat cards with data', () => {
    renderWithProviders(<Brands />);
    expect(screen.getByText('Total Tracked')).toBeInTheDocument();
  });

  it('shows loading state when loading', () => {
    (useBrands as any).mockReturnValue({
      data: null,
      isLoading: true,
    });
    const { container } = renderWithProviders(<Brands />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders filter tab buttons', () => {
    renderWithProviders(<Brands />);
    expect(screen.getByText('all')).toBeInTheDocument();
    expect(screen.getByText('monitored')).toBeInTheDocument();
    expect(screen.getByText('Top Threatened')).toBeInTheDocument();
  });

  it('shows email security grade badges', () => {
    renderWithProviders(<Brands />);
    const badges = screen.getAllByText('B');
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  it('shows canonical domain', () => {
    renderWithProviders(<Brands />);
    expect(screen.getByText('test.com')).toBeInTheDocument();
    expect(screen.getByText('second.com')).toBeInTheDocument();
  });

  it('shows stat card labels', () => {
    renderWithProviders(<Brands />);
    expect(screen.getByText('New This Week')).toBeInTheDocument();
    expect(screen.getByText('Fastest Rising')).toBeInTheDocument();
    expect(screen.getByText('Top Attack')).toBeInTheDocument();
  });
});
