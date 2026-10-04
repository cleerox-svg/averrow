import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

import { api } from '@/lib/api';
import { Providers } from './Providers';

const get = api.get as ReturnType<typeof vi.fn>;

const PROVIDER = {
  id: 'p1', name: 'Chilly Hosting', asn: 'AS123', country: 'NL',
  active_threat_count: 4, trend_7d: 3, trend_30d: 50, cooling_delta_7d: -8.67, threat_history: [],
};

function route(cooling: unknown) {
  get.mockImplementation((url: string) => {
    if (url.startsWith('/api/providers/v2')) {
      return Promise.resolve(url.includes('sort=cooling') ? cooling : { success: true, data: [] });
    }
    return Promise.resolve({ success: true, data: [] });
  });
}

const v2Calls = () => get.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/api/providers/v2'));

describe('Providers — Cooling view', () => {
  beforeEach(() => { stubMatchMedia(true); get.mockReset(); });

  it('fetches with sort=cooling (no status) and renders the negative change', async () => {
    route({ success: true, data: [PROVIDER] });
    renderWithProviders(<Providers />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'COOLING' }));
    await waitFor(() => expect(v2Calls().some((u) => u.includes('sort=cooling'))).toBe(true));
    const cooling = v2Calls().find((u) => u.includes('sort=cooling'))!;
    expect(cooling).not.toContain('status=');
    expect(await screen.findByText(/8\.7 fewer threats\/wk vs 30-day avg/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/per week versus/)).not.toBeInTheDocument();
    // Sorts are meaningless here (server orders by delta): replaced by a static label.
    expect(screen.getByText('Sorted by weekly change')).toBeInTheDocument();
    for (const name of ['THREAT COUNT', '7D TREND', '30D TREND']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/%\s*7d/)).not.toBeInTheDocument();
  });

  it('shows no cooling footer outside the cooling view or without a negative delta', async () => {
    get.mockImplementation((url: string) => Promise.resolve(
      url.startsWith('/api/providers/v2')
        ? { success: true, data: [{ ...PROVIDER, cooling_delta_7d: undefined }, { ...PROVIDER, id: 'p2', cooling_delta_7d: 2 }] }
        : { success: true, data: [] }));
    renderWithProviders(<Providers />);
    await screen.findAllByText('Chilly Hosting');
    expect(screen.queryByText(/fewer threat/)).not.toBeInTheDocument();
  });

  it('hides the cooling footer in non-cooling views even when a row carries a negative delta', async () => {
    get.mockImplementation((url: string) => Promise.resolve(
      url.startsWith('/api/providers/v2')
        ? { success: true, data: [PROVIDER] }
        : { success: true, data: [] }));
    renderWithProviders(<Providers />);
    await screen.findAllByText('Chilly Hosting');
    expect(screen.queryByText(/fewer threat/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'THREAT COUNT' })).toBeEnabled();
  });

  it('shows the cooling empty state, not the generic one', async () => {
    route({ success: true, data: [] });
    renderWithProviders(<Providers />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'COOLING' }));
    expect(await screen.findByText('No providers cooling down this week')).toBeInTheDocument();
    expect(screen.queryByText('No providers match')).not.toBeInTheDocument();
  });
});
