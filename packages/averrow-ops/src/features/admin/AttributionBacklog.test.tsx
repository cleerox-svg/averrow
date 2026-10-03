import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { AttributionBacklog } from './AttributionBacklog';

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const cluster = {
  id: 'cl_1234567890abc', cluster_name: 'Op Nightfall', asns: 'AS1,AS2', countries: 'RU',
  threat_count: 120, confidence_score: null, status: null, first_detected: null, last_seen: null,
  attribution_attempted_at: null, nexus_brief_preview: null, agent_notes_preview: null,
};

vi.mock('@/hooks/useAttributionBacklog', () => ({
  BACKLOG_PAGE_SIZE: 50,
  useAttributionBacklog: () => ({
    data: {
      items: [cluster],
      totals: { total_clusters: 1, unattributed: 1, attempted_unknown: 0, never_attempted: 1, dismissed: 0 },
      limit: 50, offset: 0, generated_at: '',
    },
    isLoading: false, isError: false, isPlaceholderData: false, refetch: vi.fn(),
  }),
  useAttributeCluster: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useDismissCluster: () => ({ mutate: vi.fn(), isPending: false }),
  useActorSearch: () => ({ data: [], isFetching: false }),
}));

describe('AttributionBacklog rows', () => {
  it('keeps native rows; Attribute/Dismiss stay accessible buttons', () => {
    renderWithProviders(<AttributionBacklog />);
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /Attribute/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeInTheDocument();
  });

  it('opens the cluster from the name button by keyboard (Enter and Space)', async () => {
    navigate.mockClear();
    renderWithProviders(<AttributionBacklog />);
    const open = screen.getByRole('button', { name: 'Open cluster Op Nightfall' });
    open.focus();
    await userEvent.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate.mock.calls[0]![0]).toContain('focus=cl_1234567890abc');
  });

  it('Attribute is a disclosure: aria-expanded toggles and aria-controls targets the picker row', async () => {
    renderWithProviders(<AttributionBacklog />);
    const btn = screen.getByRole('button', { name: /Attribute/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    btn.focus();
    await userEvent.keyboard('{Enter}');
    const close = screen.getByRole('button', { name: /Close/ });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    const target = document.getElementById(close.getAttribute('aria-controls')!);
    expect(target).not.toBeNull();
    expect(target!.querySelector('input')).not.toBeNull();
  });
});
