import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { createMockTakedown } from '@/test/mocks';
import { Takedowns } from './Takedowns';

vi.mock('@/hooks/useTakedowns', () => ({
  useAdminTakedowns: vi.fn().mockReturnValue({
    data: null,
    isLoading: false,
  }),
  useUpdateTakedown: vi.fn().mockReturnValue({
    mutate: vi.fn(),
  }),
}));

import { useAdminTakedowns, useUpdateTakedown } from '@/hooks/useTakedowns';

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
