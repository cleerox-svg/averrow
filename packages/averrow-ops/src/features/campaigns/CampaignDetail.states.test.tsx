import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { CampaignDetail } from './CampaignDetail';
import { GeopoliticalCampaignDashboard } from './GeopoliticalCampaignDashboard';

vi.mock('./CampaignGraph', () => ({ CampaignGraph: () => null }));

const idle = { data: undefined, isLoading: false, isError: false };
vi.mock('@/hooks/useCampaigns', () => ({
  useCampaignDetail: vi.fn(),
  useCampaignTimeline: () => idle,
  useCampaignThreats: () => idle,
  useCampaignInfrastructure: () => idle,
  useCampaignBrands: () => idle,
}));
vi.mock('@/hooks/useGeopoliticalCampaign', () => ({
  useGeopoliticalCampaign: vi.fn(),
  useGeoCampaignStats: () => idle,
  useGeoCampaignTimeline: () => idle,
  useGeoCampaignBrands: () => idle,
  useGeoCampaignAsns: () => idle,
  useGeoCampaignAttackTypes: () => idle,
  useGeoCampaignThreats: () => idle,
  useGeoCampaignAssessment: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { useCampaignDetail } from '@/hooks/useCampaigns';
import { useGeopoliticalCampaign } from '@/hooks/useGeopoliticalCampaign';

const cases = [
  ['CampaignDetail', CampaignDetail, useCampaignDetail],
  ['GeopoliticalCampaignDashboard', GeopoliticalCampaignDashboard, useGeopoliticalCampaign],
] as const;

describe.each(cases)('%s — failure is not "not found"', (_name, Component, hook) => {
  const mock = hook as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => vi.clearAllMocks());

  it('a failed request shows a retryable error, never "Campaign not found"', async () => {
    const refetch = vi.fn();
    mock.mockReturnValue({ data: undefined, isLoading: false, isError: true, isPlaceholderData: false, refetch });
    renderWithProviders(<Component />);

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this campaign");
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /^Try again/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
    // the error state still has a heading
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('a successful empty response is "Campaign not found" with a heading and no retry', () => {
    mock.mockReturnValue({ data: null, isLoading: false, isError: false, isPlaceholderData: false, refetch: vi.fn() });
    renderWithProviders(<Component />);

    expect(screen.getByText('Campaign not found')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Try again/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
