import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const q = (data: unknown) => ({ data, isLoading: false, isUpdating: false, isPlaceholderData: false, error: null, refetch: vi.fn() });

const nodes = [
  { lat: 51.5, lng: 0, threat_count: 60, top_severity: 'high', critical: 0, high: 60, medium: 0, low: 0, country_code: 'GB', top_threat_type: 'phishing' },
  { lat: 52.5, lng: -1, threat_count: 90, top_severity: 'high', critical: 0, high: 90, medium: 0, low: 0, country_code: 'GB', top_threat_type: 'c2' },
  { lat: 40.7, lng: -74, threat_count: 20, top_severity: 'low', critical: 0, high: 0, medium: 0, low: 20, country_code: 'US', top_threat_type: 'phishing' },
];

vi.mock('@/hooks/useObservatory', () => ({
  useObservatoryThreats: () => q(nodes),
  useObservatoryStats: () => q({ threats_mapped: 170, countries: 2, active_campaigns: 1 }),
  useObservatoryLive: () => q([]),
}));
vi.mock('@/hooks/useBrands', () => ({
  useBrands: () => q([{ id: 'b/1 x', name: 'Acme', canonical_domain: 'acme.com', threat_count: 4 }]),
}));
vi.mock('@/hooks/useProviders', () => ({ useDashboardProviders: () => q([]) }));
vi.mock('@/hooks/useOperations', () => ({
  useOperations: () => q([{ id: 'op?1#', cluster_name: 'Op', threat_count: 3, countries: '[]', asns: '[]', agent_notes: null, confidence_score: null }]),
}));
vi.mock('@/hooks/useGeopoliticalCampaign', () => ({
  useGeopoliticalCampaigns: () => q([{ id: 'c1', name: 'Op Blue/Sky & Co', status: 'active', adversary_countries: '[]', target_sectors: '[]', start_date: null, end_date: null }]),
}));
vi.mock('@/hooks/useAgents', () => ({ useAgents: () => q([]) }));

import { SidePanel } from './SidePanel';

const renderPanel = (props: Partial<React.ComponentProps<typeof SidePanel>> = {}) =>
  render(<MemoryRouter><SidePanel period="7d" visible {...props} /></MemoryRouter>);

describe('SidePanel', () => {
  it('encodes server-supplied ids / names in link paths', () => {
    renderPanel();
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/brands/b%2F1%20x');
    expect(hrefs).toContain('/campaigns/op%3F1%23');
    expect(hrefs).toContain('/campaigns/geo/op-blue%2Fsky-%26-co');
  });

  it('lets cards keep their height and the container scroll (no shrink + clip)', () => {
    renderPanel();
    const scroller = screen.getByLabelText('Intelligence panel').firstElementChild as HTMLElement;
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/min-h-0/);
    expect(scroller.className).toContain('[&>*]:shrink-0');
  });

  it('top-origin rows are keyboard-operable buttons that select the busiest node of that country', async () => {
    const onSelectNode = vi.fn();
    renderPanel({ onSelectNode });
    const gb = screen.getByRole('button', { name: /GB: 150 threats/ });
    gb.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSelectNode).toHaveBeenCalledWith(nodes[1]); // 90 > 60
  });

  it('renders origins as plain rows when no selection handler is given', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /GB:/ })).not.toBeInTheDocument();
  });
});
