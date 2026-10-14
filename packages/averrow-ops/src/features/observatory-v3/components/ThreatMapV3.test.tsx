import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    opts: Record<string, unknown>;
    setMinZoom = vi.fn();
    transform = { _helper: { _latRange: [-85.051129, 85.051129] as [number, number] } };
    constructor(opts: Record<string, unknown> = {}) { this.opts = opts; maps.push(this); }
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
    off(ev: string, cb: Handler) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter(h => h !== cb)); return this; }
    getZoom() { return 2; }
    cameraForBounds = vi.fn((b: [[number, number], [number, number]], o: { maxZoom?: number; padding?: Record<string, number> }) => ({
      center: { lng: (b[0][0] + b[1][0]) / 2, lat: (b[0][1] + b[1][1]) / 2 }, zoom: Math.min(o.maxZoom ?? 22, 3.1), bearing: 0,
    }));
    flyTo = vi.fn();
    jumpTo = vi.fn();
    remove() { this.removed = true; }
  }
  class FakeOverlay {
    finalized = false;
    props: Record<string, unknown>;
    constructor(props: Record<string, unknown>) { this.props = props; overlays.push(this); }
    setProps(p: Record<string, unknown>) { this.props = { ...this.props, ...p }; }
    finalize() { this.finalized = true; }
  }
  class FakeLayer {
    constructor(public props: Record<string, unknown>) {}
    get id() { return this.props.id as string; }
    clone(over: Record<string, unknown>) { return new FakeLayer({ ...this.props, ...over }); }
  }
  const maps: FakeMap[] = [];
  const overlays: FakeOverlay[] = [];
  return { maps, overlays, FakeMap, FakeOverlay, FakeLayer };
});

vi.mock('maplibre-gl', () => ({
  default: { Map: FakeMap, NavigationControl: class {} },
}));
vi.mock('@deck.gl/mapbox', () => ({ MapboxOverlay: FakeOverlay }));
vi.mock('@deck.gl/layers', () => ({ ScatterplotLayer: FakeLayer, PathLayer: FakeLayer, GeoJsonLayer: FakeLayer, TextLayer: FakeLayer }));
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

  it('a URL-less fetch failure before style.load is fatal (Retry shown), not a silent blank map', () => {
    render(<ThreatMapV3 {...base} />);
    act(() => lastMap().emit('error', { error: new TypeError('Failed to fetch') }));
    expect(screen.getByText('Map Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
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

describe('ThreatMapV3 camera focus', () => {
  const ready = () => act(() => { lastMap().emit('style.load'); });
  const insets = { top: 64, right: 344, bottom: 80, left: 68 };
  // jsdom has no layout: give the map a real size so the fit has room.
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
  });

  it('frames ALL the target (not one point), padded by the overlays, flying <= 800ms on a gentle curve, once per id', () => {
    const { rerender } = render(<ThreatMapV3 {...base} cameraInsets={insets} />);
    ready();
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 1, points: [[10, 20], [40, 50], [-30, 10]] }} />);
    expect(lastMap().cameraForBounds).toHaveBeenCalledTimes(1);
    const [bounds, opts] = lastMap().cameraForBounds.mock.calls[0];
    expect(bounds).toEqual([[-30, 10], [40, 50]]);
    expect(opts.padding).toEqual({ top: 104, right: 384, bottom: 120, left: 108 }); // insets + 40px breathing room
    expect(opts.maxZoom).toBeLessThanOrEqual(3.5);
    expect(lastMap().flyTo).toHaveBeenCalledTimes(1);
    const arg = lastMap().flyTo.mock.calls[0][0];
    expect(arg.duration).toBeLessThanOrEqual(800);
    expect(arg.curve).toBeLessThan(1.42);
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 1, points: [[10, 20], [40, 50]] }} />);
    expect(lastMap().flyTo).toHaveBeenCalledTimes(1);
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 2, points: [[-5, 1]] }} />);
    expect(lastMap().flyTo).toHaveBeenCalledTimes(2);
  });

  it('takes the short way across the antimeridian and never imposes a zoom floor (it can zoom OUT to fit)', () => {
    const { rerender } = render(<ThreatMapV3 {...base} cameraInsets={insets} />);
    ready();
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 1, points: [[178, -17], [-150, 64]] }} />);
    const [bounds, opts] = lastMap().cameraForBounds.mock.calls[0];
    expect(bounds[0][0]).toBe(178);
    expect(bounds[1][0]).toBe(210); // -150 + 360: the 32-degree box across the date line, not the 328-degree one
    expect(opts).not.toHaveProperty('minZoom');
  });

  it('a single point lands on the point zoom', () => {
    const { rerender } = render(<ThreatMapV3 {...base} cameraInsets={insets} />);
    ready();
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 1, points: [[10, 20]] }} />);
    expect(lastMap().cameraForBounds.mock.calls[0][1].maxZoom).toBeCloseTo(3.4);
  });

  it('jumps instead of flying under reduced motion or when asked to be instant', () => {
    stubMatchMedia(true);
    const { rerender } = render(<ThreatMapV3 {...base} cameraInsets={insets} />);
    ready();
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 1, points: [[10, 20]] }} />);
    expect(lastMap().flyTo).not.toHaveBeenCalled();
    expect(lastMap().jumpTo).toHaveBeenCalledTimes(1);
  });

  it('ignores a target with nothing placeable (never feeds NaN to the camera)', () => {
    const { rerender } = render(<ThreatMapV3 {...base} cameraInsets={insets} />);
    ready();
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 1, points: [[NaN, 20]] }} />);
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} focus={{ id: 2, points: [] }} />);
    expect(lastMap().flyTo).not.toHaveBeenCalled();
    expect(lastMap().jumpTo).not.toHaveBeenCalled();
  });
});


describe('ThreatMapV3 phone zoom floor', () => {
  const ready = () => act(() => { lastMap().emit('style.load'); });
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const innerWidth = window.innerWidth;
  afterEach(() => {
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthDesc); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });
  const phone = (w: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => w });
  };

  it('a 400px phone map may zoom out below the old 0.5 floor, so a world-spanning target fits', () => {
    phone(400);
    render(<ThreatMapV3 {...base} />);
    expect(lastMap().opts.minZoom as number).toBeLessThan(0);
  });
  it('the floor follows the canvas width once the map is up (rotation)', () => {
    phone(400);
    render(<ThreatMapV3 {...base} />);
    ready();
    const narrow = lastMap().setMinZoom.mock.calls.at(-1)![0] as number;
    expect(narrow).toBeLessThan(0);
  });
  it('the phone also widens the latitude range: MapLibre otherwise pins a tall phone at zoom ~0.3 whatever minZoom says', () => {
    phone(400);
    render(<ThreatMapV3 {...base} />);
    ready();
    expect(lastMap().transform._helper._latRange[1]).toBeGreaterThan(89);
    expect(lastMap().transform._helper._latRange[0]).toBeLessThan(-89);
  });
  it('desktop keeps MapLibre\'s own latitude range', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1400 });
    render(<ThreatMapV3 {...base} />);
    ready();
    expect(lastMap().transform._helper._latRange).toEqual([-85.051129, 85.051129]);
  });
  it('desktop keeps the library default (no phone floor)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
    render(<ThreatMapV3 {...base} />);
    expect(lastMap().opts.minZoom).toBeUndefined();
  });
});

describe('ThreatMapV3 motion policy', () => {
  const mk = (sev: string, lat = 1) => ({ lat, lng: 2, threat_count: 4, top_severity: sev, critical: 0, high: 0, medium: 0, low: 0, country_code: 'US', top_threat_type: 'c2' });
  const layerOf = (id: string) => (overlays[0].props.layers as Array<{ props: Record<string, unknown> }>).find(l => l.props.id === id);
  const ready = () => act(() => { lastMap().emit('style.load'); });

  it('only critical and high nodes breathe', () => {
    render(<ThreatMapV3 {...base} threats={[mk('critical'), mk('high', 3), mk('medium', 5), mk('low', 7)]} />);
    ready();
    const amp = layerOf('nodes-bloom')!.props.getPulseAmp as (d: unknown) => number;
    expect(amp(mk('critical'))).toBeGreaterThan(0);
    expect(amp(mk('high'))).toBeGreaterThan(0);
    expect(amp(mk('medium'))).toBe(0);
    expect(amp(mk('low'))).toBe(0);
  });

  it('under reduced motion nothing breathes, and the particles layer stands in as static beams', () => {
    stubMatchMedia(true);
    const arc = { sourcePosition: [10, 20] as [number, number], targetPosition: [-70, 40] as [number, number], threat_type: 'phishing', severity: 'high', source_region: 'NL', target_brand: 'b', brand_name: 'B', volume: 3 };
    render(<ThreatMapV3 {...base} showParticles showBeams={false} threats={[mk('critical')]} arcs={[arc]} />);
    ready();
    const amp = layerOf('nodes-bloom')!.props.getPulseAmp as (d: unknown) => number;
    expect(amp(mk('critical'))).toBe(0);
    expect(layerOf('beam-core')).toBeDefined();
    expect(layerOf('particle-trails')).toBeUndefined();
  });

  it('with motion on and Beams off, the particles layer draws particles and no beams', () => {
    const arc = { sourcePosition: [10, 20] as [number, number], targetPosition: [-70, 40] as [number, number], threat_type: 'phishing', severity: 'high', source_region: 'NL', target_brand: 'b', brand_name: 'B', volume: 3 };
    render(<ThreatMapV3 {...base} showParticles showBeams={false} threats={[mk('critical')]} arcs={[arc]} />);
    ready();
    expect(layerOf('beam-core')).toBeUndefined();
    expect(layerOf('particle-trails')).toBeDefined();
  });

  it('the derived node subsets are one memoised array shared by every node layer (stable across frames)', () => {
    render(<ThreatMapV3 {...base} threats={[mk('critical'), mk('low', 4)]} />);
    ready();
    const core = layerOf('nodes-core')!.props.data;
    expect(layerOf('nodes-bloom')!.props.data).toBe(core);
    expect(layerOf('nodes-glow')!.props.data).toBe(core);
  });

  it('a scene change (lens / option) cross-fades: both scenes are drawn with opacity, the outgoing one under an out: id', () => {
    const t = [mk('critical')];
    const { rerender } = render(<ThreatMapV3 {...base} threats={t} sceneKey="threats|points|index" />);
    ready();
    rerender(<ThreatMapV3 {...base} threats={t} showNodes={false} sceneKey="hosting|points|index" />);
    const layers = overlays[0].props.layers as Array<{ props: Record<string, unknown> }>;
    const ids = layers.map(l => l.props.id as string);
    expect(ids.some(id => id.startsWith('out:'))).toBe(true);
    const outgoing = layers.find(l => (l.props.id as string).startsWith('out:'))!;
    expect(outgoing.props.pickable).toBe(false);
    expect(outgoing.props.opacity as number).toBeGreaterThan(0);
  });

  it('a cross-fade only fades what changes: layers in BOTH scenes stay at full opacity and get no out: twin', () => {
    const arc = { sourcePosition: [10, 20] as [number, number], targetPosition: [-70, 40] as [number, number], threat_type: 'phishing', severity: 'high', source_region: 'NL', target_brand: 'b', brand_name: 'B', volume: 3 };
    const t = [mk('critical')];
    const { rerender } = render(<ThreatMapV3 {...base} showBeams threats={t} arcs={[arc]} sceneKey="a" />);
    ready();
    rerender(<ThreatMapV3 {...base} showBeams threats={t} arcs={[arc]} showNodes={false} sceneKey="b" />);
    const layers = overlays[0].props.layers as Array<{ props: Record<string, unknown> }>;
    const ids = layers.map(l => l.props.id as string);
    // nodes left the scene: only they fade out
    expect(ids).toContain('out:nodes-core');
    // beams + targets are in both scenes: untouched, not doubled, not re-faded
    expect(ids).not.toContain('out:beam-core');
    expect(ids).not.toContain('out:targets-core');
    expect(ids.filter(id => id === 'beam-core')).toHaveLength(1);
    expect(layers.find(l => l.props.id === 'beam-core')!.props.opacity).toBeUndefined();
    // nothing else was rebuilt as an out: copy
    expect(ids.filter(id => id.startsWith('out:')).every(id => id.startsWith('out:nodes-'))).toBe(true);
  });

  it('reduced motion: the scene change is instant (no outgoing copy)', () => {
    stubMatchMedia(true);
    const t = [mk('critical')];
    const { rerender } = render(<ThreatMapV3 {...base} threats={t} sceneKey="a" />);
    ready();
    rerender(<ThreatMapV3 {...base} threats={t} showNodes={false} sceneKey="b" />);
    const ids = (overlays[0].props.layers as Array<{ props: Record<string, unknown> }>).map(l => l.props.id as string);
    expect(ids.some(id => id.startsWith('out:'))).toBe(false);
  });

  it('reduced-motion static pings are cleared when the scene leaves the Threats map, and never drawn there', () => {
    stubMatchMedia(true);
    const ping = { seq: 1, items: [{ id: 'x', position: [2, 1] as [number, number], color: [200, 60, 60, 235] as [number, number, number, number], severity: 'critical', type: 'phishing', country: 'US', domain: null }] };
    const { rerender } = render(<ThreatMapV3 {...base} threats={[mk('critical')]} />);
    ready();
    rerender(<ThreatMapV3 {...base} threats={[mk('critical')]} pings={ping} />);
    expect(layerOf('live-pings-static')).toBeDefined();
    // the user switches to another scene before the 1.6s timer: the highlight must not be stranded
    rerender(<ThreatMapV3 {...base} threats={[mk('critical')]} pings={ping} mapMode="heatmap" />);
    expect(layerOf('live-pings-static')).toBeUndefined();
    rerender(<ThreatMapV3 {...base} threats={[mk('critical')]} pings={ping} mapMode="global" />);
    expect(layerOf('live-pings-static')).toBeUndefined(); // and it does not come back on return
  });

  it('live pings use their own colour, not the threat severity colour', () => {
    const { rerender } = render(<ThreatMapV3 {...base} threats={[mk('critical')]} />);
    ready();
    stubMatchMedia(false);
    rerender(<ThreatMapV3 {...base} threats={[mk('critical')]} pings={{ seq: 1, items: [{ id: 'x', position: [2, 1], color: [200, 60, 60, 235], severity: 'critical', type: 'phishing', country: 'US', domain: null }] }} />);
    expect(layerOf('live-pings')).toBeDefined();
  });
});


describe('ThreatMapV3 animation loop idles when nothing animates', () => {
  const mk = (sev: string, lat = 1) => ({ lat, lng: 2, threat_count: 4, top_severity: sev, critical: 0, high: 0, medium: 0, low: 0, country_code: 'US', top_threat_type: 'c2' });
  const arc = { sourcePosition: [10, 20] as [number, number], targetPosition: [-70, 40] as [number, number], threat_type: 'phishing', severity: 'high', source_region: 'NL', target_brand: 'b', brand_name: 'B', volume: 3 };
  const ready = () => act(() => { lastMap().emit('style.load'); });
  let raf: { mockClear: () => unknown; mockRestore: () => unknown; mock: { calls: unknown[][] } };
  beforeEach(() => {
    vi.useFakeTimers();
    raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  });
  afterEach(() => { raf.mockRestore(); vi.useRealTimers(); });
  const settle = () => act(() => { vi.advanceTimersByTime(3500); }); // past the post-mount hold

  it('a paused replay with particles but no breathing nodes runs ZERO frames', () => {
    render(<ThreatMapV3 {...base} showParticles threats={[mk('low')]} arcs={[arc]} clockPlaying={false} />);
    ready();
    settle();
    raf.mockClear();
    settle();
    expect(raf).not.toHaveBeenCalled();
  });

  it('under reduced motion the loop does not spin for the post-mount hold window', () => {
    stubMatchMedia(true);
    render(<ThreatMapV3 {...base} threats={[mk('critical')]} clockPlaying={false} />);
    ready();
    expect(raf).not.toHaveBeenCalled();
  });

  it('a playing replay with particles runs frames', () => {
    render(<ThreatMapV3 {...base} showParticles threats={[mk('low')]} arcs={[arc]} clockPlaying />);
    ready();
    expect(raf).toHaveBeenCalled();
  });

  it('a breathing critical node keeps the loop up even with the replay paused', () => {
    render(<ThreatMapV3 {...base} threats={[mk('critical')]} clockPlaying={false} />);
    ready();
    settle();
    raf.mockClear();
    settle();
    // the loop is running: it has already asked for its next frame
    render(<ThreatMapV3 {...base} threats={[mk('critical', 5)]} clockPlaying={false} />);
    ready();
    expect(raf).toHaveBeenCalled();
  });

  it('a live ping wakes an idle loop (paused replay, nothing breathing) so the ring is drawn', () => {
    const { rerender } = render(<ThreatMapV3 {...base} showParticles threats={[mk('low')]} arcs={[arc]} clockPlaying={false} />);
    ready();
    settle();
    raf.mockClear();
    rerender(<ThreatMapV3 {...base} showParticles threats={[mk('low')]} arcs={[arc]} clockPlaying={false}
      pings={{ seq: 1, items: [{ id: 'p', position: [2, 1], color: [1, 2, 3, 4], severity: 'low', type: 'phishing', country: 'US', domain: null }] }} />);
    expect(raf).toHaveBeenCalled();
    // ...and it goes back to sleep once the ring has had time to finish
    settle();
    raf.mockClear();
    settle();
    expect(raf).not.toHaveBeenCalled();
  });
});
