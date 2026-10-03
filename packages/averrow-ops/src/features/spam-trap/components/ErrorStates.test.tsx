import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { HoneypotNetworkPanel } from './HoneypotNetworkPanel';
import { CampaignPanel } from './CampaignPanel';
import { ThreatActorPanel } from './ThreatActorPanel';
import { CaptureForensicsPanel } from './CaptureForensicsPanel';

const failed = vi.hoisted(() => ({ refetch: vi.fn() }));
const q = () => ({ data: undefined, isLoading: false, isError: true, refetch: failed.refetch });

vi.mock('@/hooks/useSpamTrap', () => ({
  useSpamTrapAddresses: () => q(),
  useSeedingSources: () => ({ data: undefined }),
  useRetireSeedAddress: () => ({ mutate: vi.fn(), isPending: false }),
  useSpamTrapCampaigns: () => q(),
  useSpamTrapDaily: () => ({ data: undefined, isLoading: false }),
  useSpamTrapCaptures: () => q(),
  useSpamTrapCapture: () => ({ data: undefined }),
}));

const cases = [
  ['HoneypotNetworkPanel', HoneypotNetworkPanel, "Couldn't load seed addresses"],
  ['CampaignPanel', CampaignPanel, "Couldn't load campaigns"],
  ['ThreatActorPanel', ThreatActorPanel, "Couldn't load threat actors"],
  ['CaptureForensicsPanel', CaptureForensicsPanel, "Couldn't load capture forensics"],
] as const;

describe.each(cases)('%s load failure', (_n, Component, title) => {
  beforeEach(() => failed.refetch.mockClear());

  it('shows the shared error state with a named retry that refetches', async () => {
    renderWithProviders(<Component />);
    expect(screen.getByRole('alert')).toHaveTextContent(title);
    expect(screen.queryByText(/Unable to load/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: `Try again: ${title}` }));
    expect(failed.refetch).toHaveBeenCalledTimes(1);
  });
});
