import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
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
    setMaxZoom = vi.fn();
    setProjection = vi.fn();
    setSky = vi.fn();
    resize = vi.fn();
    flyTo = vi.fn();
    jumpTo = vi.fn();
    transform = { _helper: { _latRange: [-85.051129, 85.051129] as [number, number] } };
    constructor(opts: Record<string, unknown> = {}) { this.opts = opts; maps.push(this); }
    on(ev: string, cb: Handler) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]); return this; }
    once(ev: string, cb: Handler) { return this.on(ev, cb); }
    emit(ev: string, payload?: unknown) { (this.handlers.get(ev) ?? []).forEach(h => h(payload)); }
    off(ev: string, cb: Handler) { this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter(h => h !== cb)); return this; }
    isStyleLoaded() { return false; }
    getCanvas() { return this.canvas; }
    addControl(c: unknown) { this.controls.push(c); }
    removeControl(c: unknown) { this.controls = this.controls.filter(x => x !== c); }
    project() { return { x: 100, y: 100 }; }
    getZoom() { return 2; }
    getCenter() { return { lng: 30, lat: 70 }; }
    isMoving() { return false; }
    cameraForBounds = vi.fn((b: [[number, number], [number, number]], o: { maxZoom?: number }) => ({
      center: { lng: (b[0][0] + b[1][0]) / 2, lat: (b[0][1] + b[1][1]) / 2 }, zoom: Math.min(o.maxZoom ?? 22, 3.1), bearing: 0,
    }));
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
import { GLOBE_MAX_ZOOM, FLAT_MAX_ZOOM, GLOBE_SKY, FLAT_SKY, GLOBE_DEPTH_BIAS } from '../lib/projection';

const node = { lat: 1, lng: 2, threat_count: 1, top_severity: 'low', critical: 0, high: 0, medium: 0, low: 1, country_code: 'US', top_threat_type: 'c2' };
const arc = {
  sourcePosition: [10, 20] as [number, number], targetPosition: [-100, 40] as [number, number], threat_type: 'phishing', severity: 'high',
  source_region: 'X', target_brand: 'b', brand_name: 'Brand', volume: 20,
};
const base: ThreatMapV3Props = {
  threats: [node], arcs: [arc], showBeams: true, showParticles: false, showNodes: true,
  colorBy: 'severity', mapMode: 'global', period: '7d',
};

const lastMap = () => maps[maps.length - 1]!;
const ready = () => act(() => { lastMap().emit('style.load'); });
const layerOf = (o: InstanceType<typeof FakeOverlay>, id: string) =>
  (o.props.layers as Array<{ props: Record<string, unknown>; id: string }>).find(l => l.id === id);

const sizeDescs = {
  w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};

beforeEach(() => {
  maps.length = 0;
  overlays.length = 0;
  stubMatchMedia(false);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
});
afterEach(() => {
  if (sizeDescs.w) Object.defineProperty(HTMLElement.prototype, 'clientWidth', sizeDescs.w);
  if (sizeDescs.h) Object.defineProperty(HTMLElement.prototype, 'clientHeight', sizeDescs.h);
});

const container = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-projection]')!;

describe('ThreatMapV3 projection: flat is untouched', () => {
  it('flat (the default) never touches the projection, keeps the separate overlay canvas and the 12 zoom ceiling', () => {
    const { container: c } = render(<ThreatMapV3 {...base} />);
    expect(lastMap().opts.maxZoom).toBe(FLAT_MAX_ZOOM);
    expect(lastMap().opts.pitch).toBe(20);
    ready();
    expect(lastMap().setProjection).not.toHaveBeenCalled();
    expect(lastMap().setSky).not.toHaveBeenCalled();
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.props.interleaved).toBe(false);
    expect(overlays[0]!.props.views).toBeUndefined();
    expect(container(c).dataset.projection).toBe('flat');
    expect(container(c).style.left).toBe('0px');
  });

  it('flat draws the bezier corridor (2D points), as before', () => {
    render(<ThreatMapV3 {...base} />);
    ready();
    const path = (layerOf(overlays[0]!, 'beam-core')!.props.getPath as (a: unknown) => number[][])(arc);
    expect(path[0]).toEqual([10, 20]);
  });
});

describe('ThreatMapV3 projection: globe', () => {
  it('starts as a globe: planet-fit camera, globe projection + sky once the style is up, interleaved deck overlay', () => {
    const { container: c } = render(<ThreatMapV3 {...base} projection="globe" />);
    expect(lastMap().opts.pitch).toBe(0);
    expect(lastMap().opts.maxZoom).toBe(GLOBE_MAX_ZOOM);
    ready();
    expect(lastMap().setProjection).toHaveBeenCalledWith({ type: 'globe' });
    expect(lastMap().setMaxZoom).toHaveBeenCalledWith(GLOBE_MAX_ZOOM);
    expect(lastMap().setSky).toHaveBeenCalledWith(GLOBE_SKY);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.props.interleaved).toBe(true);
    expect(overlays[0]!.props.views).toBeDefined();
    expect(overlays[0]!.props.parameters).toEqual({ depthBias: GLOBE_DEPTH_BIAS, depthWriteEnabled: false });
    expect(container(c).dataset.projection).toBe('globe');
  });

  it('the projection is applied BEFORE the overlay is built (the overlay reads it)', () => {
    render(<ThreatMapV3 {...base} projection="globe" />);
    const order: string[] = [];
    const m = lastMap();
    m.setProjection.mockImplementation(() => { order.push('projection'); });
    const addControl = m.addControl.bind(m);
    m.addControl = (c: unknown) => { if (c instanceof FakeOverlay) order.push('overlay'); addControl(c); };
    ready();
    expect(order.indexOf('projection')).toBeLessThan(order.indexOf('overlay'));
  });

  it('arcs are drawn as lifted great circles (3D points), not the flat bezier', () => {
    render(<ThreatMapV3 {...base} projection="globe" />);
    ready();
    const getPath = layerOf(overlays[0]!, 'beam-core')!.props.getPath as (a: unknown) => number[][];
    const path = getPath(arc);
    expect(path.every(p => p.length === 3)).toBe(true);
    expect(Math.max(...path.map(p => p[2]!))).toBeGreaterThan(100_000); // metres above the surface
    expect(path[0]![2]).toBe(0);
  });

  it('the density heatmap has no globe variant: it stays flat even when the globe is requested', () => {
    const { container: c } = render(<ThreatMapV3 {...base} mapMode="heatmap" projection="globe" heatmapData={[{ lat: 1, lng: 2, severity: 'low', threat_type: 'c2', weight: 1 } as never]} />);
    ready();
    expect(lastMap().setProjection).not.toHaveBeenCalled();
    expect(overlays[0]!.props.interleaved).toBe(false);
    expect(container(c).dataset.projection).toBe('flat');
  });

  it('the canvas is the area the chrome leaves free (so the planet is centred in it); flat uses the whole box', () => {
    const insets = { top: 64, right: 344, bottom: 80, left: 68 };
    const { container: c, rerender } = render(<ThreatMapV3 {...base} cameraInsets={insets} projection="globe" />);
    ready();
    expect(container(c).style.left).toBe('68px');
    expect(container(c).style.right).toBe('344px');
    lastMap().resize.mockClear();
    rerender(<ThreatMapV3 {...base} cameraInsets={{ ...insets, right: 0 }} projection="globe" />);
    expect(container(c).style.right).toBe('0px');
    expect(lastMap().resize).toHaveBeenCalled(); // the GL canvas follows the new box
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} projection="flat" />);
    expect(container(c).style.left).toBe('0px');
    expect(container(c).style.right).toBe('0px');
  });

  it('camera framing on the globe: only top / bottom insets remain (left / right are the canvas box)', () => {
    const insets = { top: 64, right: 344, bottom: 80, left: 68 };
    const { rerender } = render(<ThreatMapV3 {...base} cameraInsets={insets} projection="globe" />);
    ready();
    rerender(<ThreatMapV3 {...base} cameraInsets={insets} projection="globe" focus={{ id: 1, points: [[10, 20], [40, 50]] }} />);
    expect(lastMap().cameraForBounds).toHaveBeenCalledTimes(1);
    const opts = lastMap().cameraForBounds.mock.calls[0]![1] as { padding: Record<string, number> };
    expect(opts.padding).toEqual({ top: 104, right: 40, bottom: 120, left: 40 });
    expect(lastMap().flyTo).toHaveBeenCalledTimes(1);
  });
});

describe('ThreatMapV3 projection: switching', () => {
  it('flat -> globe -> flat rebuilds the overlay (interleaving is fixed at construction), re-frames the camera and swaps the sky', () => {
    const { rerender } = render(<ThreatMapV3 {...base} />);
    ready();
    expect(overlays).toHaveLength(1);
    const flatOverlay = overlays[0]!;

    rerender(<ThreatMapV3 {...base} projection="globe" />);
    expect(lastMap().setProjection).toHaveBeenLastCalledWith({ type: 'globe' });
    expect(lastMap().setMaxZoom).toHaveBeenLastCalledWith(GLOBE_MAX_ZOOM);
    expect(lastMap().setSky).toHaveBeenLastCalledWith(GLOBE_SKY);
    expect(flatOverlay.finalized).toBe(true);
    expect(overlays).toHaveLength(2);
    expect(overlays[1]!.props.interleaved).toBe(true);
    expect(lastMap().controls).toContain(overlays[1]);
    expect(lastMap().controls).not.toContain(flatOverlay);
    expect(lastMap().jumpTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 0, bearing: 0 }));
    const toGlobe = lastMap().jumpTo.mock.calls.at(-1)![0] as { zoom: number; center: [number, number] };
    expect(toGlobe.zoom).toBeGreaterThan(0);
    expect(Math.abs(toGlobe.center[1])).toBeLessThanOrEqual(45); // a high-latitude view is brought toward the equator

    rerender(<ThreatMapV3 {...base} projection="flat" />);
    expect(lastMap().setProjection).toHaveBeenLastCalledWith({ type: 'mercator' });
    expect(lastMap().setMaxZoom).toHaveBeenLastCalledWith(FLAT_MAX_ZOOM);
    expect(lastMap().setSky).toHaveBeenLastCalledWith(FLAT_SKY);
    expect(overlays[1]!.finalized).toBe(true);
    expect(overlays).toHaveLength(3);
    expect(overlays[2]!.props.interleaved).toBe(false);
    expect(lastMap().jumpTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 20, zoom: 2.2 }));
  });

  it('a data change on the globe does not rebuild the overlay (it is updated in place)', () => {
    const { rerender } = render(<ThreatMapV3 {...base} projection="globe" />);
    ready();
    rerender(<ThreatMapV3 {...base} threats={[{ ...node }]} projection="globe" />);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.finalized).toBe(false);
  });

  it('re-places screen-space labels once the new projection has drawn', () => {
    const { rerender } = render(<ThreatMapV3 {...base} />);
    ready();
    rerender(<ThreatMapV3 {...base} projection="globe" />);
    expect((lastMap().handlers.get('idle') ?? []).length).toBeGreaterThan(0);
  });

  it('never re-applies the same projection', () => {
    const { rerender } = render(<ThreatMapV3 {...base} projection="globe" />);
    ready();
    rerender(<ThreatMapV3 {...base} projection="globe" period="30d" />);
    expect(lastMap().setProjection).toHaveBeenCalledTimes(1);
  });

  it('finalizes the interleaved overlay on unmount', () => {
    const { unmount } = render(<ThreatMapV3 {...base} projection="globe" />);
    ready();
    unmount();
    expect(overlays[0]!.finalized).toBe(true);
    expect(lastMap().removed).toBe(true);
  });
});

describe('ThreatMapV3 projection: idle spin wiring', () => {
  let queue: Array<(ts: number) => void>;
  let nowMs: number;
  beforeEach(() => {
    queue = [];
    nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => { queue.push(cb); return queue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const frame = (ts: number) => { nowMs = ts; const run = queue; queue = []; act(() => run.forEach(cb => cb(ts))); };
  const spinMoves = () => lastMap().jumpTo.mock.calls.filter(c => (c[1] as { spin?: boolean } | undefined)?.spin === true);

  it('the globe drifts after the idle time, with its moves tagged', () => {
    render(<ThreatMapV3 {...base} projection="globe" spinIdleMs={500} />);
    ready();
    frame(100); frame(700); frame(800);
    expect(spinMoves().length).toBeGreaterThan(0);
  });

  it('the flat map never drifts', () => {
    render(<ThreatMapV3 {...base} spinIdleMs={500} />);
    ready();
    frame(100); frame(5000); frame(5100);
    expect(spinMoves()).toHaveLength(0);
  });

  it('a selection holds the globe still', () => {
    render(<ThreatMapV3 {...base} projection="globe" spinIdleMs={500} selection={{ kind: 'node', node: node as never }} />);
    ready();
    frame(100); frame(5000); frame(5100);
    expect(spinMoves()).toHaveLength(0);
  });

  it('reduced motion holds the globe still', () => {
    stubMatchMedia(true);
    render(<ThreatMapV3 {...base} projection="globe" spinIdleMs={500} />);
    ready();
    frame(100); frame(5000); frame(5100);
    expect(spinMoves()).toHaveLength(0);
  });
});
