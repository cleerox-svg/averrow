import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

// ─── Fakes (hoisted so the vi.mock factories can reference them) ──
const { maps, overlays, FakeMap, FakeOverlay, FakeLayer } = vi.hoisted(() => {
  type Handler = (e?: unknown) => void;

  class FakeMap {
    handlers = new Map<string, Handler[]>();
    removed = false;
    controls: unknown[] = [];
    canvas = document.createElement('canvas');
    constructor() { maps.push(this); }
    on(ev: string, cb: Handler) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]); return this; }
    once(ev: string, cb: Handler) { return this.on(ev, cb); }
    emit(ev: string, payload?: unknown) { (this.handlers.get(ev) ?? []).forEach(h => h(payload)); }
    loaded() { return false; }
    isStyleLoaded() { return false; }
    getCanvas() { return this.canvas; }
    addControl(c: unknown) { this.controls.push(c); }
    removeControl(c: unknown) { this.controls = this.controls.filter(x => x !== c); }
    resize() {}
    project() { return { x: 100, y: 100 }; }
    remove() { this.removed = true; }
  }
  class FakeOverlay {
    finalized = false;
    props: Record<string, unknown>;
    constructor(props: Record<string, unknown>) { this.props = props; overlays.push(this); }
    setProps(p: Record<string, unknown>) { this.props = { ...this.props, ...p }; }
    finalize() { this.finalized = true; }
  }
  class FakeLayer { constructor(public props: Record<string, unknown>) {} }
  const maps: FakeMap[] = [];
  const overlays: FakeOverlay[] = [];
  return { maps, overlays, FakeMap, FakeOverlay, FakeLayer };
});

vi.mock('maplibre-gl', () => ({
  default: { Map: FakeMap, NavigationControl: class {} },
}));
vi.mock('@deck.gl/mapbox', () => ({ MapboxOverlay: FakeOverlay }));
vi.mock('@deck.gl/layers', () => ({ ScatterplotLayer: FakeLayer, PathLayer: FakeLayer }));
vi.mock('@deck.gl/aggregation-layers', () => ({ HeatmapLayer: FakeLayer }));
vi.mock('@/lib/trips-layer', () => ({ TripsLayer: FakeLayer }));

import { ThreatMapV3, type ThreatMapV3Props } from './ThreatMapV3';

const base: ThreatMapV3Props = {
  threats: [], arcs: [], showBeams: false, showParticles: false, showNodes: true,
  colorBy: 'severity', mapMode: 'global', period: '7d',
};

const lastMap = () => maps[maps.length - 1];

beforeEach(() => {
  maps.length = 0;
  overlays.length = 0;
  stubMatchMedia(false);
});

describe('ThreatMapV3 error handling', () => {
  it('a tile/source error leaves the map on screen', () => {
    render(<ThreatMapV3 {...base} />);
    act(() => lastMap().emit('error', { sourceId: 'carto', tile: {}, error: new Error('tile 404') }));
    expect(screen.queryByText('Map Unavailable')).not.toBeInTheDocument();
    expect(lastMap().removed).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent(/tiles/i);
  });

  it('a base-style failure shows the fallback and tears the map down', () => {
    render(<ThreatMapV3 {...base} />);
    const first = lastMap();
    act(() => first.emit('error', { error: Object.assign(new Error('Failed to fetch'), { url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' }) }));
    expect(screen.getByText('Map Unavailable')).toBeInTheDocument();
    expect(first.removed).toBe(true);
  });

  it('WebGL context loss is fatal, and Retry builds a NEW map instance (no page reload)', async () => {
    render(<ThreatMapV3 {...base} />);
    const first = lastMap();
    const evt = new Event('webglcontextlost', { cancelable: true });
    act(() => { first.canvas.dispatchEvent(evt); });
    expect(evt.defaultPrevented).toBe(true);
    expect(screen.getByText(/WebGL context was lost/)).toBeInTheDocument();
    expect(first.removed).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(maps).toHaveLength(2);
    expect(lastMap()).not.toBe(first);
    expect(screen.queryByText('Map Unavailable')).not.toBeInTheDocument();
  });

  it('a sprite 404 (URL under the style directory) is NOT fatal and the map still loads on style.load', () => {
    render(<ThreatMapV3 {...base} threats={[{ lat: 1, lng: 2, threat_count: 1, top_severity: 'low', critical: 0, high: 0, medium: 0, low: 1, country_code: 'US', top_threat_type: 'c2' }]} />);
    act(() => lastMap().emit('error', {
      error: Object.assign(new Error('Failed to fetch'), { status: 404, url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/sprite.json' }),
    }));
    expect(screen.queryByText('Map Unavailable')).not.toBeInTheDocument();
    act(() => lastMap().emit('style.load'));
    expect(overlays).toHaveLength(1); // deck attached: style.load, not the tile-dependent load, marks the map ready
  });

  it('StrictMode double-mount: webglcontextlost from the DISPOSED first map never replaces the healthy second map', () => {
    const onFatalChange = vi.fn();
    render(<React.StrictMode><ThreatMapV3 {...base} onFatalChange={onFatalChange} /></React.StrictMode>);
    expect(maps).toHaveLength(2);
    const [disposed, live] = maps;
    expect(disposed.removed).toBe(true);
    // map.remove() on the old instance dispatches this on its (detached) canvas.
    act(() => { disposed.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); });
    expect(screen.queryByText('Map Unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText(/WebGL context was lost/)).not.toBeInTheDocument();
    expect(live.removed).toBe(false);
    expect(onFatalChange).not.toHaveBeenCalledWith(true);
  });

  it('reports the fatal state to the page via onFatalChange', async () => {
    const onFatalChange = vi.fn();
    render(<ThreatMapV3 {...base} onFatalChange={onFatalChange} />);
    expect(onFatalChange).toHaveBeenLastCalledWith(false);
    act(() => { lastMap().canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); });
    expect(onFatalChange).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onFatalChange).toHaveBeenLastCalledWith(false);
  });

  it('finalizes the deck overlay on unmount', () => {
    const { unmount } = render(<ThreatMapV3 {...base} threats={[{ lat: 1, lng: 2, threat_count: 1, top_severity: 'low', critical: 0, high: 0, medium: 0, low: 1, country_code: 'US', top_threat_type: 'c2' }]} />);
    act(() => lastMap().emit('style.load'));
    expect(overlays).toHaveLength(1);
    unmount();
    expect(overlays[0].finalized).toBe(true);
    expect(lastMap().removed).toBe(true);
  });
});

describe('ThreatMapV3 position filtering', () => {
  const mk = (lat: number, lng: number) => ({ lat, lng, threat_count: 1, top_severity: 'low', critical: 0, high: 0, medium: 0, low: 1, country_code: 'XX', top_threat_type: 'c2' });
  const coreData = () => {
    const layers = overlays[0].props.layers as Array<{ props: { id: string; data: Array<{ lat: number; lng: number }> } }>;
    return layers.find(l => l.props.id === 'nodes-core')!.props.data;
  };

  it('keeps lat=0 / lng=0 cells, drops only null island and non-finite coordinates', () => {
    render(<ThreatMapV3 {...base} threats={[mk(0, 25), mk(5, 0), mk(0, 0), mk(Number.NaN, 3)]} />);
    act(() => lastMap().emit('style.load'));
    expect(coreData().map(d => [d.lat, d.lng])).toEqual([[0, 25], [5, 0]]);
  });
});

describe('ThreatMapV3 layer memoisation', () => {
  const t = { lat: 1, lng: 2, threat_count: 1, top_severity: 'low', critical: 0, high: 0, medium: 0, low: 1, country_code: 'US', top_threat_type: 'c2' };

  it('does not rebuild layers when the parent re-renders with identical data, even with a new onSelect', () => {
    const threats = [t];
    const { rerender } = render(<ThreatMapV3 {...base} threats={threats} onSelect={() => {}} />);
    act(() => lastMap().emit('style.load'));
    const layersBefore = overlays[0].props.layers;
    rerender(<ThreatMapV3 {...base} threats={threats} onSelect={() => {}} />);
    expect(overlays[0].props.layers).toBe(layersBefore);
  });

  it('rebuilds when the data identity changes', () => {
    const { rerender } = render(<ThreatMapV3 {...base} threats={[t]} />);
    act(() => lastMap().emit('style.load'));
    const before = overlays[0].props.layers;
    rerender(<ThreatMapV3 {...base} threats={[{ ...t }]} />);
    expect(overlays[0].props.layers).not.toBe(before);
  });
});

describe('ThreatMapV3 selection card', () => {
  const t = { lat: 1, lng: 2, threat_count: 4, top_severity: 'high', critical: 0, high: 4, medium: 0, low: 0, country_code: 'DE', top_threat_type: 'phishing' };

  it('renders a card for a URL-restored selection, closes on Esc and via the labelled button', async () => {
    const onSelect = vi.fn();
    render(<ThreatMapV3 {...base} threats={[t]} selection={{ kind: 'node', node: t }} onSelect={onSelect} />);
    act(() => lastMap().emit('style.load'));
    const card = await screen.findByRole('dialog', { name: 'Threat node details' });
    expect(card).toHaveTextContent('4 threats');

    await userEvent.keyboard('{Escape}');
    expect(onSelect).toHaveBeenCalledWith(null);

    await userEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
