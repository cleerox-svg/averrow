import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

const fetchMock = vi.fn();
const getMock = vi.fn();
const authState = { user: { role: 'super_admin' as string } };
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/api', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a), get: (...a: unknown[]) => getMock(...a) } }));

const mapProps = vi.fn();
vi.mock('./components/ThreatMapV3', () => ({
  ThreatMapV3: (p: Record<string, unknown>) => { mapProps(p); return <div data-testid="map" data-mode={String(p.mapMode)} />; },
}));
const panelProps = vi.fn();
vi.mock('./components/SidePanel', () => ({
  SidePanel: (p: { visible: boolean; mobile?: boolean; placement?: string; onSelectNode?: (n: unknown) => void }) => {
    panelProps(p);
    return (
      <div data-testid={p.mobile ? 'side-panel-mobile' : 'side-panel'} data-visible={String(p.visible)} data-placement={p.placement}>
        <button type="button" onClick={() => p.onSelectNode?.(node)}>pick-origin</button>
      </div>
    );
  },
}));
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
  panelProps.mockClear();
  window.innerWidth = 1440;
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
  it('changing the source select updates the URL and refetches with source_feed', async () => {
    renderAt('/observatory');
    await waitFor(() => expect(called('/api/observatory/nodes')).toBe(true));
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Source' }), 'spam_trap');
    await waitFor(() => expect(search).toContain('source=spam_trap'));
    await waitFor(() => expect(urls().some(u => u.startsWith('/api/observatory/nodes') && u.includes('source_feed=spam_trap'))).toBe(true));
    expect(urls().some(u => u.startsWith('/api/observatory/arcs') && u.includes('source_feed=spam_trap'))).toBe(true);
  });

  it('the period segmented control writes the URL', async () => {
    renderAt('/observatory');
    await userEvent.click(await screen.findByRole('radio', { name: '30D' }));
    await waitFor(() => expect(search).toContain('period=30d'));
    expect(screen.getByRole('radio', { name: '30D' })).toHaveAttribute('aria-checked', 'true');
  });

  it('the rail replaces the nine-row layer list: traffic controls write the layers param, Beams toggles', async () => {
    renderAt('/observatory');
    const traffic = await screen.findByRole('group', { name: 'Threat traffic underneath' });
    expect(screen.queryByRole('group', { name: 'Map layers' })).not.toBeInTheDocument();
    const beams = within(screen.getByRole('group', { name: 'Map options' })).getByRole('button', { name: 'Beams' });
    expect(beams).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(beams);
    await waitFor(() => expect(beams).toHaveAttribute('aria-pressed', 'true'));
    expect(search).toContain('layers=');
    expect(search).toContain('beams');
    await userEvent.click(within(traffic).getByRole('button', { name: 'Nodes' }));
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0]).toMatchObject({ showNodes: true, showParticles: false }));
  });

  it('the number keys still toggle layers, except inside the replay slider, the search box and dialogs', async () => {
    renderAt('/observatory');
    await screen.findByRole('group', { name: 'Threat traffic underneath' });
    screen.getByRole('button', { name: 'Refresh Observatory data' }).focus(); // a plain control inside the console
    await userEvent.keyboard('3');
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].showBeams).toBe(true));
    const slider = await screen.findByRole('slider');
    slider.focus();
    await userEvent.keyboard('3');
    expect(mapProps.mock.calls.at(-1)![0].showBeams).toBe(true); // unchanged: the slider owns its keys
    await userEvent.click(screen.getByRole('combobox', { name: 'Find on map' }));
    await userEvent.keyboard('3');
    expect(mapProps.mock.calls.at(-1)![0].showBeams).toBe(true);
  });

  it('restores state from the URL', async () => {
    renderAt('/observatory?period=24h&colorBy=type&layers=nodes');
    await waitFor(() => expect(mapProps).toHaveBeenCalled());
    const last = mapProps.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ period: '24h', colorBy: 'type', showNodes: true, showParticles: false, showBeams: false });
  });
});

describe('ObservatoryV3 lenses', () => {
  const op = { id: 'op1', name: 'OP ONE', component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 5, actor: null, countries: ['NL', 'MD'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null };

  it('the threats lens fetches no lens endpoint; a lens fetches only its own (and the threat queries stop)', async () => {
    renderAt('/observatory');
    await waitFor(() => expect(called('/api/observatory/nodes')).toBe(true));
    for (const p of ['operations-geo', 'movements', 'providers-geo', 'overindex', 'campaigns-geo', 'actors']) expect(called('/api/observatory/' + p)).toBe(false);
    expect(called('/api/observatory/timeline')).toBe(true); // replay bar follows the particles
  });

  it('the hosting lens loads providers only', async () => {
    renderAt('/observatory?lens=hosting');
    await waitFor(() => expect(called('/api/observatory/providers-geo')).toBe(true));
    expect(called('/api/observatory/nodes')).toBe(false);
    expect(called('/api/observatory/arcs')).toBe(false);
    expect(called('/api/observatory/operations-geo')).toBe(false);
    expect(called('/api/observatory/timeline')).toBe(false);
  });

  it('choosing a lens writes it to the URL and passes the lens data to the map', async () => {
    route({ '/api/observatory/operations-geo': { operations: [op], components: [] }, '/api/observatory/stats': okStats });
    renderAt('/observatory');
    await userEvent.click(await screen.findByRole('tab', { name: 'Operations' }));
    await waitFor(() => expect(search).toContain('lens=operations'));
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].lens.operations?.nodes).toHaveLength(2));
    expect(mapProps.mock.calls.at(-1)![0].lens.layers).toMatchObject({ operations: true, nodes: false });
  });

  it('a shared sel= link opens the drawer once its data loads, and Escape closes it', async () => {
    route({ '/api/observatory/operations-geo': { operations: [op], components: [] }, '/api/observatory/stats': okStats });
    renderAt('/observatory?lens=operations&sel=op:op1');
    const dlg = await screen.findByRole('dialog', { name: /Operation details/ });
    await waitFor(() => expect(dlg).toHaveTextContent('OP ONE'));
    expect(mapProps.mock.calls.at(-1)![0].focus).toMatchObject({ instant: true });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search).not.toContain('sel='));
  });

  it('drops a sel= key whose object no longer exists once the data has loaded', async () => {
    route({ '/api/observatory/operations-geo': { operations: [], components: [] }, '/api/observatory/stats': okStats });
    renderAt('/observatory?lens=operations&sel=op:gone');
    await waitFor(() => expect(search).not.toContain('sel='));
    expect(screen.queryByRole('dialog', { name: /Operation details/ })).not.toBeInTheDocument();
  });

  it('a country selection loads the data its drawer reads', async () => {
    renderAt('/observatory?lens=hosting&sel=country:NL');
    await waitFor(() => expect(called('/api/observatory/overindex')).toBe(true));
    expect(called('/api/observatory/operations-geo')).toBe(true);
    expect(called('/api/observatory/nodes')).toBe(true);
    expect(urls().find(u => u.startsWith('/api/observatory/timeline'))).toBeUndefined(); // hosting has no replay bar
  });

  it('a lens failure raises the banner for that lens only', async () => {
    route({ '/api/observatory/providers-geo': new Error('down'), '/api/observatory/stats': okStats });
    renderAt('/observatory?lens=hosting');
    expect(await screen.findByTestId('observatory-load-error')).toBeInTheDocument();
  });

  it('search focus loads the lists it searches', async () => {
    renderAt('/observatory');
    await userEvent.click(await screen.findByRole('combobox', { name: 'Find on map' }));
    await waitFor(() => expect(called('/api/observatory/operations-geo')).toBe(true));
    expect(called('/api/observatory/providers-geo')).toBe(true);
    expect(called('/api/observatory/actors')).toBe(true);
  });

  it('takedown outcomes are neutral for roles without manage_takedowns', async () => {
    authState.user.role = 'sales';
    const prov = { id: 'p1', name: 'Host', asn: 'AS1', country: 'NL', active_threat_count: 5, total_threat_count: 9, trend_7d: 1, trend_30d: 2, is_bulletproof: false, reputation_score: null, takedown: null };
    route({ '/api/observatory/providers-geo': [prov], '/api/observatory/stats': okStats });
    renderAt('/observatory?lens=hosting&sel=provider:p1');
    expect(await screen.findByText(/roles that manage takedowns/)).toBeInTheDocument();
    expect(urls().some(u => u.includes('takedowns-geo'))).toBe(false);
    authState.user.role = 'super_admin';
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

describe('ObservatoryV3 bot share (a Baseline measure)', () => {
  const botReply = { success: true, data: { source: 'cloudflare_radar', latest: null, series: [], top_locations: [], top_asns: [], categories: [], bot_density: [], last_fetch: { status: null, last_success_at: null, last_error: null } } };

  it('the legacy mode=bot_density link lands on Baseline + Bot share; the stats bar says 7D and nothing queries observatory data', async () => {
    getMock.mockResolvedValue(botReply);
    renderAt('/observatory?mode=bot_density');
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/api/bot-traffic?days=7'));
    await waitFor(() => expect(search).toContain('lens=baseline'));
    expect(search).toContain('measure=bot');
    expect(search).not.toContain('mode=');
    const footer = screen.getByText(/countries/, { selector: 'div.font-mono' });
    expect(footer.textContent).toMatch(/^7D/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Baseline' })).toHaveAttribute('aria-selected', 'true');
  });

  it('choosing Bot share on the Baseline rail switches to that scene; Over-index goes back', async () => {
    getMock.mockResolvedValue(botReply);
    renderAt('/observatory?lens=baseline');
    await userEvent.click(await screen.findByRole('button', { name: 'Bot share' }));
    await waitFor(() => expect(search).toContain('measure=bot'));
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].mapMode).toBe('bot_density'));
    expect(mapProps.mock.calls.at(-1)![0].lens.bot).not.toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Over-index' }));
    await waitFor(() => expect(search).not.toContain('measure='));
  });
});

describe('ObservatoryV3 Threats lens Points | Heat', () => {
  it('Heat is a view of the Threats lens (view=heat), fetches the heatmap and skips nodes', async () => {
    renderAt('/observatory');
    await userEvent.click(await screen.findByRole('button', { name: 'Heat' }));
    await waitFor(() => expect(search).toContain('view=heat'));
    await waitFor(() => expect(called('/api/observatory/heatmap')).toBe(true));
    expect(mapProps.mock.calls.at(-1)![0].mapMode).toBe('heatmap');
    expect(screen.getByRole('tab', { name: 'Threats' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('side-panel')).not.toBeInTheDocument();
  });
});

describe('ObservatoryV3 Threats lens: Fast weaponization view', () => {
  const vnode = { lat: 52, lng: 5, threat_count: 9, country_code: 'NL', very_fast: 6, fast: 3, precision: 'country' };
  const tl = { bucket: '1h', points: [{ t: '2026-10-14T00:00:00Z', total: 9, critical: 0, high: 0, medium: 0, low: 0, very_fast: 6, fast: 3 }] };

  it('fetches velocity nodes + the velocity timeline, with NO source, and none of the threat queries', async () => {
    route({ '/api/observatory/velocity-nodes': [vnode], '/api/observatory/timeline': tl });
    renderAt('/observatory?view=fast&source=spam_trap&period=30d');
    await waitFor(() => expect(called('/api/observatory/velocity-nodes')).toBe(true));
    expect(urls().find(u => u.startsWith('/api/observatory/velocity-nodes'))).toBe('/api/observatory/velocity-nodes?period=30d&flag=all');
    await waitFor(() => expect(called('/api/observatory/timeline')).toBe(true));
    expect(urls().find(u => u.startsWith('/api/observatory/timeline'))).toBe('/api/observatory/timeline?period=30d&velocity=all');
    expect(urls().some(u => u.includes('source_feed'))).toBe(false);
    for (const p of ['nodes', 'arcs', 'heatmap', 'stats', 'live']) expect(called(`/api/observatory/${p}`)).toBe(false);
  });

  it('the source select reads All sources and is disabled (the URL source is kept for the other views)', async () => {
    renderAt('/observatory?view=fast&source=spam_trap');
    const select = await screen.findByRole('combobox', { name: 'Source' });
    expect(select).toBeDisabled();
    expect(select).toHaveValue('all');
    expect(search).toContain('source=spam_trap');
  });

  it('the map gets the velocity model, no threat layers, and the selection stays a country', async () => {
    route({ '/api/observatory/velocity-nodes': [vnode], '/api/observatory/timeline': tl });
    renderAt('/observatory?view=fast');
    await waitFor(() => {
      const p = mapProps.mock.calls.at(-1)![0];
      expect(p.lens.velocity?.points).toHaveLength(1);
    });
    const p = mapProps.mock.calls.at(-1)![0];
    expect(p).toMatchObject({ mapMode: 'global', showNodes: false, showParticles: false, showBeams: false });
    expect(p.sceneKey).toBe('threats|fast|index');
    // the Points view hands the map no velocity model
    await userEvent.click(screen.getByRole('button', { name: 'Points' }));
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].lens.velocity).toBeNull());
  });

  it('keeps the model identity stable between renders with unchanged data (no per-poll layer rebuilds)', async () => {
    route({ '/api/observatory/velocity-nodes': [vnode], '/api/observatory/timeline': tl });
    renderAt('/observatory?view=fast');
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].lens.velocity).not.toBeNull());
    const a = mapProps.mock.calls.at(-1)![0].lens.velocity;
    await act(async () => { await userEvent.click(screen.getByRole('radio', { name: '7D' })); });
    await new Promise(r => setTimeout(r, 30));
    expect(mapProps.mock.calls.at(-1)![0].lens.velocity).toBe(a);
  });

  it('the replay bar is the still velocity chart, and the panel ranks countries; a node opens the country drawer', async () => {
    route({ '/api/observatory/velocity-nodes': [vnode], '/api/observatory/timeline': tl });
    renderAt('/observatory?view=fast');
    expect(await screen.findByRole('group', { name: 'Fast weaponization timeline' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Fastest to weaponize' })).toBeInTheDocument();
    expect(screen.queryByTestId('side-panel')).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('region', { name: 'Fastest to weaponize' })).getByRole('button', { name: /Netherlands/ }));
    await waitFor(() => expect(search).toContain('sel=country%3ANL'));
  });

  it('an empty answer reads as coverage still filling in the legend chip and the panel', async () => {
    route({ '/api/observatory/velocity-nodes': [], '/api/observatory/timeline': { bucket: '1h', points: [] } });
    renderAt('/observatory?view=fast');
    expect(await screen.findByRole('button', { name: /Legend.*coverage filling/ })).toBeInTheDocument();
    // the panel's empty state (the legend carries the same words, collapsed)
    expect((await screen.findAllByText(/Velocity coverage is still filling/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/no fast-weaponized threats\b/i)).not.toBeInTheDocument();
  });

  it('a velocity failure raises the banner here and not in the Points view', async () => {
    route({ '/api/observatory/velocity-nodes': new Error('cube down') });
    const { unmount } = renderAt('/observatory?view=fast');
    expect(await screen.findByTestId('observatory-load-error')).toBeInTheDocument();
    unmount();
    renderAt('/observatory');
    await waitFor(() => expect(called('/api/observatory/nodes')).toBe(true));
    expect(screen.queryByTestId('observatory-load-error')).not.toBeInTheDocument();
  });

  it('choosing Fast on the rail writes view=fast; the number keys do not toggle layers in it', async () => {
    renderAt('/observatory');
    await userEvent.click(await screen.findByRole('button', { name: 'Fast weaponization' }));
    await waitFor(() => expect(search).toContain('view=fast'));
    const before = search;
    await userEvent.keyboard('3');
    expect(search).toBe(before);
  });
});

describe('ObservatoryV3 takedown outcomes (manage_takedowns)', () => {
  const trow = (key: string, td: number, refused: number, expired = 0) => ({
    key, label: `Label ${key}`, country: 'NL', lat: 52, lng: 5, submitted: td + refused + expired + 2, taken_down: td, refused, expired, pending: 2,
    share: td + refused + expired ? td / (td + refused + expired) : null, median_hours: 30,
  });
  const byCountry = [trow('US', 30, 10), trow('RU', 2, 38), trow('DE', 1, 1)];
  const byProvider = [trow('p1', 16, 4), trow('ghost', 1, 29), trow('unknown', 3, 3)];
  const prov = { id: 'p1', name: 'Host p1', asn: 'AS1', country: 'NL', active_threat_count: 5, total_threat_count: 9, trend_7d: 1, trend_30d: 2, is_bulletproof: false, reputation_score: null, takedown: null };
  const tdRoute = (u: string) => (u.includes('by=provider') ? byProvider : byCountry);
  const routeTd = () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/observatory/takedowns-geo')) return Promise.resolve({ success: true, data: tdRoute(url) });
      if (url.startsWith('/api/observatory/providers-geo')) return Promise.resolve({ success: true, data: [prov] });
      if (url.startsWith('/api/observatory/stats')) return Promise.resolve({ success: true, data: okStats });
      return Promise.resolve({ success: true, data: [] });
    });
  };
  const lastLens = () => mapProps.mock.calls.at(-1)![0].lens;

  beforeEach(() => { authState.user.role = 'super_admin'; });
  afterEach(() => { authState.user.role = 'super_admin'; });

  it.each(['super_admin', 'admin', 'analyst'])('%s: Baseline > Takedowns requests by=country for the page window and hands the map a model', async role => {
    authState.user.role = role;
    routeTd();
    renderAt('/observatory?lens=baseline&measure=takedowns');
    await waitFor(() => expect(urls()).toContain('/api/observatory/takedowns-geo?period=30d&by=country'));
    await waitFor(() => expect(lastLens().takedownCountries).not.toBeNull());
    expect(lastLens()).toMatchObject({ measure: 'takedowns', takedownProviders: null });
    expect(called('/api/observatory/overindex')).toBe(false);          // takedowns replace the Radar baseline
    expect(called('/api/observatory/takedowns-geo?period=30d&by=provider')).toBe(false);
    expect(mapProps.mock.calls.at(-1)![0].sceneKey).toBe('baseline|points|takedowns');
  });

  it('the window follows the period: 90D -> 90d, 24H / 7D -> 30d', async () => {
    routeTd();
    renderAt('/observatory?lens=baseline&measure=takedowns&period=90d');
    await waitFor(() => expect(urls()).toContain('/api/observatory/takedowns-geo?period=90d&by=country'));
  });

  it('the panel lists the hardest jurisdictions (lowest share, enough volume) and a row opens the country drawer', async () => {
    routeTd();
    renderAt('/observatory?lens=baseline&measure=takedowns');
    const list = await screen.findByRole('region', { name: 'Hardest jurisdictions' });
    const rows = await within(list).findAllByRole('button');
    expect(rows.map(r => r.textContent)).toEqual([expect.stringMatching(/^Russia.*5%$/), expect.stringMatching(/^United States.*75%$/)]);   // DE: 2 resolved
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(search).toContain('sel=country%3ARU'));
    expect(await screen.findByRole('dialog', { name: /Country details/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Takedowns · 30d' })).toBeInTheDocument();
  });

  it('Hosting > Takedowns requests by=provider next to providers-geo; the panel lists the hardest hosts', async () => {
    routeTd();
    renderAt('/observatory?lens=hosting&measure=takedowns');
    await waitFor(() => expect(urls()).toContain('/api/observatory/takedowns-geo?period=30d&by=provider'));
    expect(called('/api/observatory/providers-geo')).toBe(true);
    expect(called('/api/observatory/takedowns-geo?period=30d&by=country')).toBe(false);
    await waitFor(() => expect(lastLens().takedownProviders).not.toBeNull());
    const list = await screen.findByRole('region', { name: 'Hardest hosts' });
    expect(within(list).getAllByRole('listitem').map(li => li.textContent)).toEqual([expect.stringMatching(/^Label ghost/), expect.stringMatching(/^Label p1/)]);
    // only the host the map knows is a button
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('the closed legend counts hosts (the unknown-host row is not one); the panel asks the takedown question, not the lens\'s', async () => {
    routeTd();
    renderAt('/observatory?lens=hosting&measure=takedowns');
    expect(await screen.findByRole('button', { name: /Legend.*2 hosts/ })).toBeInTheDocument();
    // (the lens strip also announces the lens's own question in an sr-only live region: look at the panel's <p>)
    const panelQuestion = (text: string) => screen.queryAllByText(text).filter(el => el.tagName === 'P');
    expect(panelQuestion('Which hosts ignore or refuse takedowns most often?')).toHaveLength(1);
    expect(panelQuestion('Where do operators choose to host?')).toHaveLength(0);
  });

  it('Baseline asks its takedown question too; without the measure the lens keeps its own', async () => {
    routeTd();
    const { unmount } = renderAt('/observatory?lens=baseline&measure=takedowns');
    const panelQuestion = (text: string) => screen.queryAllByText(text).filter(el => el.tagName === 'P');
    await waitFor(() => expect(panelQuestion('In which countries do takedowns succeed least often?')).toHaveLength(1));
    unmount();
    renderAt('/observatory?lens=baseline');
    await waitFor(() => expect(panelQuestion('Where do we see more than normal attack traffic?')).toHaveLength(1));
  });

  it('the rail offers Takedowns to holders and writes measure=takedowns', async () => {
    routeTd();
    renderAt('/observatory?lens=baseline');
    await userEvent.click(await screen.findByRole('button', { name: 'Takedowns' }));
    await waitFor(() => expect(search).toContain('measure=takedowns'));
    await waitFor(() => expect(urls()).toContain('/api/observatory/takedowns-geo?period=30d&by=country'));
    await userEvent.click(screen.getByRole('button', { name: 'Over-index' }));
    await waitFor(() => expect(search).not.toContain('measure='));
  });

  it.each(['sales', 'support', 'billing', 'auditor'])('%s: no takedown option, no takedowns-geo request, and a shared measure=takedowns link shows the default measure', async role => {
    authState.user.role = role;
    routeTd();
    renderAt('/observatory?lens=baseline&measure=takedowns&period=90d');
    await waitFor(() => expect(called('/api/observatory/overindex')).toBe(true));
    await new Promise(r => setTimeout(r, 50));
    expect(urls().some(u => u.includes('takedowns-geo'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Takedowns' })).not.toBeInTheDocument();
    expect(lastLens()).toMatchObject({ measure: 'index', takedownCountries: null, takedownProviders: null });
    expect(mapProps.mock.calls.at(-1)![0].sceneKey).toBe('baseline|points|index');
    expect(screen.queryByRole('region', { name: 'Hardest jurisdictions' })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Most over-indexed' })).toBeInTheDocument();
  });

  it('Hosting for a non-holder: the lens works as before (providers-geo, no measure control, no takedown request)', async () => {
    authState.user.role = 'support';
    routeTd();
    renderAt('/observatory?lens=hosting&measure=takedowns');
    await waitFor(() => expect(called('/api/observatory/providers-geo')).toBe(true));
    await new Promise(r => setTimeout(r, 50));
    expect(urls().some(u => u.includes('takedowns-geo'))).toBe(false);
    expect(screen.queryByRole('group', { name: 'Hosting measure' })).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Top hosting providers' })).toBeInTheDocument();
  });

  it('a country drawer reads takedowns by country for a holder, on any lens, and for nobody else', async () => {
    routeTd();
    const { unmount } = renderAt('/observatory?lens=hosting&sel=country:US');
    await waitFor(() => expect(urls()).toContain('/api/observatory/takedowns-geo?period=30d&by=country'));
    expect(await screen.findByRole('img', { name: 'Taken down: 75%' })).toBeInTheDocument();
    unmount();
    fetchMock.mockClear();
    authState.user.role = 'sales';
    renderAt('/observatory?lens=hosting&sel=country:US');
    expect(await screen.findByText(/roles that manage takedowns/)).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 50));
    expect(urls().some(u => u.includes('takedowns-geo'))).toBe(false);
  });

  it('a failing takedown request raises the banner in a takedown view and not elsewhere', async () => {
    fetchMock.mockImplementation((url: string) => (url.startsWith('/api/observatory/takedowns-geo')
      ? Promise.resolve({ success: false, error: 'rollup down' })
      : Promise.resolve({ success: true, data: url.startsWith('/api/observatory/stats') ? okStats : [] })));
    const { unmount } = renderAt('/observatory?lens=baseline&measure=takedowns');
    expect(await screen.findByTestId('observatory-load-error')).toBeInTheDocument();
    unmount();
    renderAt('/observatory?lens=baseline');
    await waitFor(() => expect(called('/api/observatory/overindex')).toBe(true));
    expect(screen.queryByTestId('observatory-load-error')).not.toBeInTheDocument();
  });

  it('the map gets the SAME model objects while the data is unchanged (no per-poll layer rebuild)', async () => {
    routeTd();
    renderAt('/observatory?lens=hosting&measure=takedowns');
    await waitFor(() => expect(lastLens().takedownProviders).not.toBeNull());
    const a = lastLens().takedownProviders;
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Hide intelligence panel' })); });
    await new Promise(r => setTimeout(r, 30));
    expect(lastLens().takedownProviders).toBe(a);
  });
});

describe('ObservatoryV3 country shapes load only for a visible choropleth', () => {
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'NL', properties: { n: 'Netherlands' }, geometry: { type: 'Polygon', coordinates: [] } }] };
  it('not for Hosting + a country drawer, yes for Baseline', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation((() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fc) })) as unknown as typeof fetch);
    const shapeCalls = () => f.mock.calls.filter(c => String(c[0]).includes('countries-110m')).length;
    const { unmount } = renderAt('/observatory?lens=hosting&sel=country:NL');
    await waitFor(() => expect(called('/api/observatory/overindex')).toBe(true));
    expect(shapeCalls()).toBe(0);
    unmount();
    renderAt('/observatory?lens=baseline');
    await waitFor(() => expect(shapeCalls()).toBeGreaterThan(0));
    f.mockRestore();
  });
});

describe('ObservatoryV3 reduced motion', () => {
  it('the flow control reads "Static beams" and the map draws beams instead of dead particles; nothing rewrites the URL', async () => {
    stubMatchMedia(true);
    renderAt('/observatory');
    const flow = await screen.findByRole('button', { name: 'Nodes + Static beams' });
    expect(flow).toHaveAttribute('aria-pressed', 'true'); // the URL layer state is unchanged
    expect(search).not.toContain('layers=');
    expect(screen.getByText('Motion reduced')).toBeInTheDocument();
    // other controls stay live
    expect(within(screen.getByRole('group', { name: 'Map options' })).getByRole('button', { name: 'Beams' })).not.toHaveAttribute('aria-disabled');
    // the map still receives the particles flag: it is the map that swaps them for static beams
    expect(mapProps.mock.calls.at(-1)![0]).toMatchObject({ showParticles: true, showBeams: false });
  });
});

describe('ObservatoryV3 chrome', () => {
  it('does not render a second LIVE badge (the shell top bar owns it)', async () => {
    renderAt('/observatory');
    await screen.findByRole('tablist', { name: 'Observatory lens' });
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('one 44px toolbar row: lens strip, search, period, source, refresh', async () => {
    renderAt('/observatory');
    const bar = await waitFor(() => {
      const el = document.querySelector('[data-toolbar]') as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(bar.style.height).toBe('44px');
    expect(within(bar).getByRole('tablist', { name: 'Observatory lens' })).toBeInTheDocument();
    expect(within(bar).getByRole('combobox', { name: 'Find on map' })).toBeInTheDocument();
    expect(within(bar).getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument();
    expect(within(bar).getByRole('combobox', { name: 'Source' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Refresh Observatory data' })).toBeInTheDocument();
  });

  it('the search folds to an icon on a narrower toolbar', async () => {
    window.innerWidth = 1100;
    renderAt('/observatory');
    expect(await screen.findByRole('button', { name: 'Find on map' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Find on map' })).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument(); // period + source still inline
  });

  it('period + source fold into one popover when the MAP is narrow, whatever the window says', async () => {
    window.innerWidth = 1000;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 700 }); // the map beside an open sidebar
    try {
      renderAt('/observatory');
      const filters = await screen.findByRole('button', { name: /^Filters: 7D/ });
      expect(screen.queryByRole('radiogroup', { name: 'Period' })).not.toBeInTheDocument(); // hidden inside the closed popover
      expect(document.getElementById(filters.getAttribute('aria-controls')!)).toHaveAttribute('hidden');
      await userEvent.click(filters);
      expect(document.getElementById(filters.getAttribute('aria-controls')!)).not.toHaveAttribute('hidden');
      // a 1000px window with a 700px map is the TABLET tier: no docked panel
      expect(screen.queryByTestId('side-panel')).not.toBeInTheDocument();
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });

  it('docks and opens the panel from DOCK_MIN_MAP of map width; below it the panel is closed and floats when opened', async () => {
    window.innerWidth = 1440;
    const wide = renderAt('/observatory');
    const dock = await screen.findByTestId('side-panel');
    expect(dock.dataset.placement).toBe('dock');
    wide.unmount();
    window.innerWidth = 1100;
    renderAt('/observatory');
    await screen.findByRole('button', { name: 'Show intelligence panel' });
    expect(screen.queryByTestId('side-panel')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show intelligence panel' }));
    expect((await screen.findByTestId('side-panel')).dataset.placement).toBe('overlay');
  });

  it('re-flows on resize: shrinking the window closes the docked panel, widening docks it again', async () => {
    window.innerWidth = 1440;
    renderAt('/observatory');
    expect((await screen.findByTestId('side-panel')).dataset.placement).toBe('dock');
    act(() => { window.innerWidth = 1000; window.dispatchEvent(new Event('resize')); });
    await waitFor(() => expect(screen.queryByTestId('side-panel')).not.toBeInTheDocument());
    act(() => { window.innerWidth = 1500; window.dispatchEvent(new Event('resize')); });
    expect((await screen.findByTestId('side-panel')).dataset.placement).toBe('dock');
  });

  it('hides "Threat Landscape Clear" when the map is in its fatal fallback', async () => {
    route({ '/api/observatory/nodes': [], '/api/observatory/stats': okStats });
    renderAt('/observatory');
    expect(await screen.findByText('Threat Landscape Clear')).toBeInTheDocument();
    act(() => mapProps.mock.calls.at(-1)![0].onFatalChange(true));
    expect(screen.queryByText('Threat Landscape Clear')).not.toBeInTheDocument();
    act(() => mapProps.mock.calls.at(-1)![0].onFatalChange(false));
    expect(await screen.findByText('Threat Landscape Clear')).toBeInTheDocument();
  });

  it('keeps labelling the footer numbers with the previous period until the new data arrives', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/observatory/stats') && url.includes('period=30d')) {
        return gate.then(() => ({ success: true, data: { ...okStats, threats_mapped: 999, period: '30d' } }));
      }
      if (url.startsWith('/api/observatory/stats')) return Promise.resolve({ success: true, data: { ...okStats, threats_mapped: 5 } });
      return Promise.resolve({ success: true, data: [] });
    });
    renderAt('/observatory');
    const footer = () => document.querySelector('div.font-mono[aria-busy]') as HTMLElement;
    await waitFor(() => expect(footer().textContent).toContain('5'));
    expect(footer().textContent).toMatch(/^7D/);

    await userEvent.click(screen.getByRole('radio', { name: '30D' }));
    await screen.findByText(/Updating to 30D/);
    expect(footer().textContent).toMatch(/^7D/);
    expect(footer().getAttribute('aria-busy')).toBe('true');

    await act(async () => { release(); await gate; });
    await waitFor(() => expect(footer().textContent).toMatch(/^30D/));
  });

  it('says what is animating in plain words, never "GPU layers active"', async () => {
    renderAt('/observatory');
    await screen.findByRole('tablist', { name: 'Observatory lens' });
    await waitFor(() => expect(screen.getByText('Replaying attacks')).toBeInTheDocument());
    expect(screen.queryByText(/GPU/)).not.toBeInTheDocument();
  });
});

describe('ObservatoryV3 footer label follows the stats query only', () => {
  it('relabels the threats / countries line as soon as stats arrive, even while nodes still load', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/observatory/nodes') && url.includes('period=30d')) return gate.then(() => ({ success: true, data: [] }));
      if (url.startsWith('/api/observatory/stats') && url.includes('period=30d')) return Promise.resolve({ success: true, data: { ...okStats, threats_mapped: 777, period: '30d' } });
      if (url.startsWith('/api/observatory/stats')) return Promise.resolve({ success: true, data: { ...okStats, threats_mapped: 5 } });
      return Promise.resolve({ success: true, data: [] });
    });
    renderAt('/observatory');
    const footer = () => document.querySelector('div.font-mono[aria-busy]') as HTMLElement;
    await waitFor(() => expect(footer().textContent).toMatch(/^7D/));
    await userEvent.click(screen.getByRole('radio', { name: '30D' }));
    await waitFor(() => expect(footer().textContent).toMatch(/^30D/));
    expect(footer().textContent).toContain('777');
    expect(footer().getAttribute('aria-busy')).toBe('false');
    await act(async () => { release(); await gate; });
  });
});

describe('ObservatoryV3 keyboard selection path', () => {
  it('selecting a side-panel origin writes the node to the URL (and passes it as the selection)', async () => {
    route({ '/api/observatory/nodes': [node], '/api/observatory/stats': { ...okStats, threats_mapped: 3, threats_total: 3 } });
    renderAt('/observatory');
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].threats).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'pick-origin' }));
    await waitFor(() => expect(search).toContain('node=10.00%2C20.00'));
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].selection).toMatchObject({ kind: 'node' }));
    // Not a map click: the camera is asked to frame the node.
    expect(mapProps.mock.calls.at(-1)![0].focus).toMatchObject({ points: [[20, 10]], instant: false });
  });

  it('closing the drawer returns focus to the intelligence-panel toggle when the row it was opened from is gone', async () => {
    route({ '/api/observatory/nodes': [node], '/api/observatory/stats': { ...okStats, threats_mapped: 3, threats_total: 3 } });
    renderAt('/observatory');
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].threats).toHaveLength(1));
    const row = screen.getByRole('button', { name: 'pick-origin' });
    await userEvent.click(row);
    const dlg = await screen.findByRole('dialog', { name: /Threat origin details/ });
    expect(dlg).toHaveFocus();
    expect(row).not.toBeInTheDocument(); // the drawer replaced the panel
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide intelligence panel' })).toHaveFocus());
  });

  it('closing the drawer opened from the search box returns focus to the search box', async () => {
    const op = { id: 'op1', name: 'OP ONE', component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 5, actor: null, countries: ['NL', 'MD'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null };
    route({ '/api/observatory/operations-geo': { operations: [op], components: [] }, '/api/observatory/stats': okStats });
    renderAt('/observatory');
    const box = await screen.findByRole('combobox', { name: 'Find on map' });
    await userEvent.click(box);
    await waitFor(() => expect(called('/api/observatory/operations-geo')).toBe(true));
    await userEvent.type(box, 'OP ONE');
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: /Operation details/ });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Find on map' })).toHaveFocus());
  });
});

describe('ObservatoryV3 lens-aware panel', () => {
  const prov = (id: string, n: number) => ({ id, name: `Host ${id}`, asn: 'AS1', country: 'NL', active_threat_count: n, total_threat_count: n, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null });
  it('Hosting shows its top providers; a row selects the provider and the drawer replaces the list', async () => {
    route({ '/api/observatory/providers-geo': [prov('a', 5), prov('b', 50)], '/api/observatory/stats': okStats });
    renderAt('/observatory?lens=hosting');
    const panel = await screen.findByRole('complementary', { name: 'Hosting panel' });
    const rows = await within(panel).findAllByRole('button');
    expect(rows[0]).toHaveTextContent('Host b');
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(search).toContain('sel=provider%3Ab'));
    expect(await screen.findByRole('dialog', { name: /Hosting provider details/ })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Hosting panel' })).not.toBeInTheDocument();
  });
  it('Threats keeps the global overview', async () => {
    renderAt('/observatory');
    expect(await screen.findByTestId('side-panel')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /panel$/ })).not.toBeInTheDocument();
  });
});

describe('ObservatoryV3 phone (< 900px)', () => {
  beforeEach(() => { window.innerWidth = 400; });

  it('top row is [summary][search][refresh] with the lens strip below it', async () => {
    renderAt('/observatory');
    const summary = await screen.findByRole('button', { name: /^Filters: 7D/ });
    const strip = screen.getByRole('tablist', { name: 'Observatory lens' });
    expect(screen.getByRole('button', { name: 'Find on map' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh Observatory data' })).toBeInTheDocument();
    expect(summary.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const t of within(strip).getAllByRole('tab')) expect(t.className).toMatch(/min-h-\[44px\]/);
    // no desktop rail on a phone
    expect(document.querySelector('[data-layout="rail"]')).toBeNull();
  });

  it('the summary opens the filters card: period, source and the same controls as the rail, as 44px rows', async () => {
    renderAt('/observatory');
    const summary = await screen.findByRole('button', { name: /^Filters: 7D/ });
    const card = document.getElementById(summary.getAttribute('aria-controls')!)!;
    expect(card).toHaveAttribute('hidden');
    await userEvent.click(summary);
    expect(card).not.toHaveAttribute('hidden');
    expect(within(card).getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument();
    const beams = within(card).getByRole('button', { name: 'Beams' });
    expect(beams.className).toMatch(/min-h-\[44px\]/);
    await userEvent.click(beams);
    await waitFor(() => expect(search).toContain('beams'));
  });

  it('a selection opens a NON-modal peek sheet (no scrim, no aria-modal) and the camera gets a bottom inset', async () => {
    const op = { id: 'op1', name: 'OP ONE', component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 5, actor: null, countries: ['NL', 'MD'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null };
    route({ '/api/observatory/operations-geo': { operations: [op], components: [] }, '/api/observatory/stats': okStats });
    renderAt('/observatory?lens=operations&sel=op:op1');
    const sheet = await screen.findByRole('dialog', { name: /details/i });
    expect(sheet).not.toHaveAttribute('aria-modal');
    expect(document.querySelector('.bg-black\\/60')).toBeNull(); // no scrim
    expect(await within(sheet).findByText('OP ONE')).toBeInTheDocument();
    expect(mapProps.mock.calls.at(-1)![0].cameraInsets.top).toBeGreaterThan(100);
  });
});

describe('ObservatoryV3 review round: stacking, short phones, sheet camera, bot-share keys', () => {
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const innerHeight = window.innerHeight;
  afterEach(() => {
    if (heightDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', heightDesc); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    window.innerHeight = innerHeight;
  });
  const op = { id: 'op1', name: 'OP ONE', component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 5, actor: null, countries: ['NL', 'MD'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null };

  it('the toolbar stacks ABOVE the intel panel / drill drawer (z-20), so its popovers open over them on tablet widths', async () => {
    renderAt('/observatory?lens=hosting');
    const bar = await waitFor(() => {
      const el = document.querySelector('[data-toolbar]') as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    const panel = await waitFor(() => {
      const el = document.querySelector('[class*="z-20"]') as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(panel.className).toMatch(/\bz-20\b/);
    expect(Number(bar.style.zIndex)).toBeGreaterThan(20);
    // ...but under the panel toggle and the load-error banner (z 30)
    expect(Number(bar.style.zIndex)).toBeLessThan(30);
  });

  it('phone toolbar is also above the panel layer', async () => {
    window.innerWidth = 400;
    renderAt('/observatory');
    const summary = await screen.findByRole('button', { name: /^Filters: 7D/ });
    const bar = summary.closest('div[style*="z-index"]') as HTMLElement;
    expect(Number(bar.style.zIndex)).toBeGreaterThan(20);
  });

  describe('landscape phone (844 x 390)', () => {
    beforeEach(() => { window.innerWidth = 844; window.innerHeight = 390; });

    it('lens strip, filters, search and refresh share ONE row, and the top chrome is one row tall', async () => {
      renderAt('/observatory');
      const summary = await screen.findByRole('button', { name: /^Filters: 7D/ });
      const strip = screen.getByRole('tablist', { name: 'Observatory lens' });
      expect(summary.parentElement!.parentElement).toBe(strip.parentElement!.parentElement);
      expect(screen.getByRole('button', { name: 'Find on map' }).parentElement).toBe(strip.parentElement!.parentElement);
      for (const t of within(strip).getAllByRole('tab')) expect(t.className).toMatch(/min-h-\[44px\]/);
      await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].cameraInsets.top).toBeLessThan(80));
    });

    it('no replay bar and no ticker band: the map keeps its height', async () => {
      renderAt('/observatory');
      await screen.findByRole('tablist', { name: 'Observatory lens' });
      expect(screen.queryByRole('slider')).toBeNull();
      const mapBox = screen.getByTestId('map').parentElement as HTMLElement;
      expect(mapBox.style.bottom).toBe('36px'); // stats bar only; a tall phone reserves 108
    });

    it('the sheets open at the half snap (a 30% peek of 320px is only the handle), and the first camera plan reserves that', async () => {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 320 });
      route({ '/api/observatory/operations-geo': { operations: [op], components: [] }, '/api/observatory/stats': okStats });
      renderAt('/observatory?lens=operations&sel=op:op1');
      const sheet = await screen.findByRole('dialog', { name: /details/i });
      expect(sheet.style.height).toBe('60%');
      await waitFor(() => expect(mapProps.mock.calls.some(c => c[0].focus != null)).toBe(true));
      const first = mapProps.mock.calls.map(c => c[0]).find(p => p.focus != null);
      expect(first.cameraInsets.bottom).toBe(Math.round(0.6 * 320) - 36 + 12);
    });

    it('a tall phone still gets the two-row chrome', async () => {
      window.innerHeight = 844; window.innerWidth = 400;
      renderAt('/observatory');
      const summary = await screen.findByRole('button', { name: /^Filters: 7D/ });
      const strip = screen.getByRole('tablist', { name: 'Observatory lens' });
      expect(summary.parentElement!.parentElement).not.toBe(strip.parentElement!.parentElement);
      expect((screen.getByTestId('map').parentElement as HTMLElement).style.bottom).toBe('108px');
    });
  });

  it('phone: the FIRST camera plan for a selection already reserves the peek sheet (it has not mounted yet)', async () => {
    window.innerWidth = 400;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
    route({ '/api/observatory/operations-geo': { operations: [op], components: [] }, '/api/observatory/stats': okStats });
    renderAt('/observatory?lens=operations&sel=op:op1');
    await screen.findByRole('dialog', { name: /details/i });
    await waitFor(() => expect(mapProps.mock.calls.some(c => c[0].focus != null)).toBe(true));
    const firstFocus = mapProps.mock.calls.map(c => c[0]).find(p => p.focus != null);
    // 30% of 800 = 240px sheet, 108px band already under the map, +12 gutter
    expect(firstFocus.cameraInsets.bottom).toBe(240 - 108 + 12);
  });

  it('phone: focus moves into the Intel sheet when it opens (the Intel button unmounts) and comes back to the button on close', async () => {
    window.innerWidth = 400;
    renderAt('/observatory?lens=hosting');
    const fab = await screen.findByRole('button', { name: 'Open intelligence panel' });
    await userEvent.click(fab);
    const sheet = await screen.findByRole('dialog', { name: 'Intelligence panel' });
    expect(sheet).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Intelligence panel' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Open intelligence panel' })).toHaveFocus();
  });

  it('the number keys do nothing in the bot-share scene (the layers they would toggle are not the ones on screen)', async () => {
    getMock.mockResolvedValue({ success: true, data: { source: 'cloudflare_radar', latest: null, series: [], top_locations: [], top_asns: [], categories: [], bot_density: [], last_fetch: { status: null, last_success_at: null, last_error: null } } });
    renderAt('/observatory?lens=baseline&measure=bot');
    await waitFor(() => expect(mapProps.mock.calls.at(-1)![0].mapMode).toBe('bot_density'));
    screen.getByRole('button', { name: 'Refresh Observatory data' }).focus();
    await userEvent.keyboard('7');
    await userEvent.keyboard('1');
    expect(search).not.toContain('layers=');
    expect(mapProps.mock.calls.at(-1)![0].lens.layers.baseline).toBe(true); // baseline never switched off by a hidden-layer toggle
  });
});
