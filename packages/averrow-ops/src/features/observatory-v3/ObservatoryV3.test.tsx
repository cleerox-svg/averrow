import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

const fetchMock = vi.fn();
const getMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a), get: (...a: unknown[]) => getMock(...a) } }));

const mapProps = vi.fn();
vi.mock('./components/ThreatMapV3', () => ({
  ThreatMapV3: (p: Record<string, unknown>) => { mapProps(p); return <div data-testid="map" data-mode={String(p.mapMode)} />; },
}));
vi.mock('./components/SidePanel', () => ({ SidePanel: () => null }));
vi.mock('@/components/observatory/EventTicker', () => ({ EventTicker: () => null }));

import { ObservatoryV3 } from './ObservatoryV3';

const node = { lat: 10, lng: 20, threat_count: 3, top_severity: 'high', critical: 0, high: 3, medium: 0, low: 0, country_code: 'DE', top_threat_type: 'phishing' };
const okStats = { threats_mapped: 0, threats_total: 0, geo_coverage_pct: null, countries: 0, active_campaigns: 0, brands_monitored: 0, period: '7d' };

interface Routes { [prefix: string]: unknown | (() => unknown) }
function route(routes: Routes) {
  fetchMock.mockImplementation((url: string) => {
    const hit = Object.keys(routes).find(p => url.startsWith(p));
    if (!hit) return Promise.resolve({ success: true, data: [] });
    const v = routes[hit];
    const out = typeof v === 'function' ? (v as () => unknown)() : v;
    if (out instanceof Error) return Promise.resolve({ success: false, error: out.message });
    return Promise.resolve({ success: true, data: out });
  });
}
const urls = () => fetchMock.mock.calls.map(c => c[0] as string);
const called = (prefix: string) => urls().some(u => u.startsWith(prefix));

let search = '';
function Loc() { search = useLocation().search; return null; }

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Loc />
        <ObservatoryV3 />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  getMock.mockReset();
  mapProps.mockClear();
  stubMatchMedia(false);
  route({ '/api/observatory/stats': okStats });
});

describe('ObservatoryV3 data gating', () => {
  it('global mode fetches nodes, arcs and stats — never the heatmap', async () => {
    route({ '/api/observatory/nodes': [node], '/api/observatory/stats': { ...okStats, threats_mapped: 3, threats_total: 3 } });
    renderAt('/observatory');
    await waitFor(() => expect(called('/api/observatory/stats')).toBe(true));
    expect(called('/api/observatory/nodes')).toBe(true);
    expect(called('/api/observatory/arcs')).toBe(true);
    expect(called('/api/observatory/heatmap')).toBe(false);
  });

  it('heatmap mode fetches the heatmap WITH source_feed and skips nodes/arcs', async () => {
    renderAt('/observatory?mode=heatmap&source=feeds&period=30d');
    await waitFor(() => expect(called('/api/observatory/heatmap')).toBe(true));
    expect(urls().find(u => u.startsWith('/api/observatory/heatmap'))).toBe('/api/observatory/heatmap?period=30d&source_feed=feeds&limit=10000');
    expect(called('/api/observatory/nodes')).toBe(false);
    expect(called('/api/observatory/arcs')).toBe(false);
  });

  it('a failing arcs request raises the banner in global mode but not in heatmap mode', async () => {
    route({ '/api/observatory/arcs': new Error('arcs down'), '/api/observatory/stats': okStats });
    const { unmount } = renderAt('/observatory');
    expect(await screen.findByTestId('observatory-load-error')).toBeInTheDocument();
    unmount();

    renderAt('/observatory?mode=heatmap');
    await waitFor(() => expect(called('/api/observatory/heatmap')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('map')).toBeInTheDocument());
    expect(screen.queryByTestId('observatory-load-error')).not.toBeInTheDocument();
  });

  it('a failing heatmap request raises the banner only in heatmap mode', async () => {
    route({ '/api/observatory/heatmap': new Error('heat down'), '/api/observatory/stats': okStats });
    renderAt('/observatory?mode=heatmap');
    expect(await screen.findByTestId('observatory-load-error')).toBeInTheDocument();
  });
});

describe('ObservatoryV3 URL state', () => {
  it('changing the source tab updates the URL and refetches with source_feed', async () => {
    renderAt('/observatory');
    await waitFor(() => expect(called('/api/observatory/nodes')).toBe(true));
    await userEvent.click(screen.getByRole('tab', { name: /Spam Trap/i }).closest('button') ?? screen.getByText('Spam Trap'));
    await waitFor(() => expect(search).toContain('source=spam_trap'));
    await waitFor(() => expect(urls().some(u => u.startsWith('/api/observatory/nodes') && u.includes('source_feed=spam_trap'))).toBe(true));
    expect(urls().some(u => u.startsWith('/api/observatory/arcs') && u.includes('source_feed=spam_trap'))).toBe(true);
  });

  it('layer toggles are aria-pressed and write to the URL', async () => {
    renderAt('/observatory');
    const group = await screen.findByRole('group', { name: 'Map layers' });
    const beams = within(group).getByRole('button', { name: 'Beams' });
    expect(beams).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(beams);
    await waitFor(() => expect(beams).toHaveAttribute('aria-pressed', 'true'));
    expect(search).toContain('layers=');
    expect(search).toContain('beams');
  });

  it('restores state from the URL', async () => {
    renderAt('/observatory?period=24h&colorBy=type&layers=nodes');
    await waitFor(() => expect(mapProps).toHaveBeenCalled());
    const last = mapProps.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ period: '24h', colorBy: 'type', showNodes: true, showParticles: false, showBeams: false });
  });
});

describe('ObservatoryV3 refresh', () => {
  it('the refresh button refetches the page data', async () => {
    renderAt('/observatory');
    await waitFor(() => expect(called('/api/observatory/nodes')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Observatory data' })).toBeInTheDocument());
    const before = urls().filter(u => u.startsWith('/api/observatory/nodes')).length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh Observatory data' }));
    await waitFor(() => expect(urls().filter(u => u.startsWith('/api/observatory/nodes')).length).toBe(before + 1));
    expect(urls().filter(u => u.startsWith('/api/observatory/stats')).length).toBeGreaterThan(1);
  });
});

describe('ObservatoryV3 "Threat Landscape Clear" overlay', () => {
  it('shows only when loaded, global, zero nodes and zero threats', async () => {
    route({ '/api/observatory/nodes': [], '/api/observatory/stats': okStats });
    renderAt('/observatory');
    expect(await screen.findByText('Threat Landscape Clear')).toBeInTheDocument();
  });

  it('is not shown while nodes exist', async () => {
    route({ '/api/observatory/nodes': [node], '/api/observatory/stats': { ...okStats, threats_mapped: 3, threats_total: 3 } });
    renderAt('/observatory');
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].threats).toHaveLength(1));
    expect(screen.queryByText('Threat Landscape Clear')).not.toBeInTheDocument();
  });

  it('is not shown in heatmap mode', async () => {
    renderAt('/observatory?mode=heatmap');
    await waitFor(() => expect(called('/api/observatory/heatmap')).toBe(true));
    expect(screen.queryByText('Threat Landscape Clear')).not.toBeInTheDocument();
  });

  it('is not shown when the stats request failed (cannot verify "clear")', async () => {
    route({ '/api/observatory/nodes': [], '/api/observatory/stats': new Error('stats down') });
    renderAt('/observatory');
    await screen.findByTestId('observatory-load-error');
    expect(screen.queryByText('Threat Landscape Clear')).not.toBeInTheDocument();
  });

  it('is honest when threats exist but have no coordinates', async () => {
    route({ '/api/observatory/nodes': [], '/api/observatory/stats': { ...okStats, threats_total: 40 } });
    renderAt('/observatory');
    expect(await screen.findByText('No Geolocated Threats')).toBeInTheDocument();
    expect(screen.queryByText('Threat Landscape Clear')).not.toBeInTheDocument();
  });
});

describe('ObservatoryV3 bot density', () => {
  it('labels the stats bar 7D (the window it actually fetches) and never queries observatory data', async () => {
    getMock.mockResolvedValue({ success: true, data: { source: 'cloudflare_radar', latest: null, series: [], top_locations: [], top_asns: [], categories: [], bot_density: [], last_fetch: { status: null, last_success_at: null, last_error: null } } });
    renderAt('/observatory?mode=bot_density');
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/bot-traffic?days=7'));
    expect(screen.getByText('7D')).toBeInTheDocument();
    expect(screen.queryByText('24H')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
