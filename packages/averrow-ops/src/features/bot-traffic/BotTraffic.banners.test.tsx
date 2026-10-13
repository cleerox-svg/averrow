// BotTraffic notices render through the shared Banner (not Card variant="critical"):
// the refresh-failed strip keeps the last data and offers Retry, and the
// last-fetch-error notice only appears in the no-data state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { BotTrafficData } from '@/hooks/useBotTraffic';

const mocks = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useBotTraffic', () => ({
  useBotTraffic: () => ({ ...mocks.result, refetch: mocks.refetch }),
}));

import { BotTraffic } from './BotTraffic';

function payload(over: Partial<BotTrafficData> = {}): BotTrafficData {
  return {
    source: 'cloudflare_radar',
    latest: null,
    series: [],
    top_locations: [],
    top_asns: [],
    categories: [],
    last_fetch: { status: 'error', last_success_at: null, last_error: null },
    ...over,
  };
}

function renderPage() {
  return render(<MemoryRouter><BotTraffic /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BotTraffic banners', () => {
  it('shows the last fetch error as a named critical Banner next to the empty state', () => {
    mocks.result = {
      data: payload({ last_fetch: { status: 'error', last_success_at: null, last_error: 'Radar 403 forbidden' } }),
      isError: false,
    };
    renderPage();
    expect(screen.getByText('No bot traffic data yet')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Last fetch error' });
    expect(region).toHaveAttribute('data-tone', 'critical');
    expect(region).toHaveTextContent('Radar 403 forbidden');
    expect(region).toHaveTextContent(/lacks the Radar Read permission/);
    expect(region).not.toHaveAttribute('role', 'alert');
  });

  it('omits the permission hint for other errors and the banner when there is no error', () => {
    mocks.result = {
      data: payload({ last_fetch: { status: 'error', last_success_at: null, last_error: 'timeout' } }),
      isError: false,
    };
    const { unmount } = renderPage();
    expect(screen.getByRole('region', { name: 'Last fetch error' })).not.toHaveTextContent(/Radar Read/);
    unmount();

    mocks.result = { data: payload(), isError: false };
    renderPage();
    expect(screen.queryByRole('region', { name: 'Last fetch error' })).not.toBeInTheDocument();
  });

  it('shows a refresh-failed Banner with a working Retry when data is already on screen', async () => {
    mocks.result = { data: payload(), isError: true };
    renderPage();
    const region = screen.getByRole('region', { name: 'Bot traffic refresh failed' });
    expect(region).toHaveAttribute('data-tone', 'critical');
    expect(region).toHaveTextContent("Couldn't refresh bot traffic");
    expect(region).toHaveTextContent('Showing the last loaded data.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});
