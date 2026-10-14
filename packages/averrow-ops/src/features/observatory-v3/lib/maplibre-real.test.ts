// Contract tests against the REAL maplibre-gl classes (a real `Map` with its real Mercator / Globe transforms), not
// the stubs the component tests use. The observatory reaches into three things MapLibre does not document, so a
// library upgrade that moves them would pass every stub test and break in the browser:
//   - `transform._helper._latRange` (the widened phone latitude range, lib/camera.ts `setLatRange`),
//   - `transform.isLocationOccluded` (globe label occlusion, lib/projection.ts `globeLabelOpacity`),
//   - `setSky(undefined)` (flat mode has no sky, lib/projection.ts `skyFor`).
// jsdom has no WebGL, workers or ResizeObserver: just enough is faked for the Map to construct and load an empty style.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.hoisted(() => { (window.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:stub'; });
import maplibregl from 'maplibre-gl';
import { setLatRange, resetLatRangeWarning } from './camera';
import { GLOBE_SKY, applySky, globeLabelOpacity, projectionSpec, type OcclusionProbe } from './projection';

function fakeGl(canvas: HTMLCanvasElement): WebGLRenderingContext {
  const target: Record<string, unknown> = { canvas, drawingBufferWidth: 100, drawingBufferHeight: 100 };
  return new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'getParameter') return () => 16;
      if (k === 'getExtension') return () => null;
      if (k === 'getContextAttributes') return () => ({ antialias: true });
      if (k === 'getShaderPrecisionFormat') return () => ({ rangeMin: 1, rangeMax: 1, precision: 1 });
      if (k === 'isContextLost') return () => false;
      if (/^[A-Z_0-9]+$/.test(k)) return 1;
      return () => ({});
    },
  }) as unknown as WebGLRenderingContext;
}

let map: maplibregl.Map;
const transform = () => map.transform as unknown as OcclusionProbe & { latRange: [number, number]; _helper: { _latRange: [number, number] | null } };

beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ImageData', class {});
  vi.stubGlobal('Worker', class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} onmessage = null; });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { return fakeGl(this) as never; });
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800 });
  Object.defineProperty(container, 'clientHeight', { value: 600 });
  map = new maplibregl.Map({ container, attributionControl: false, center: [0, 0], zoom: 1 });
  map.setStyle({ version: 8, sources: {}, layers: [] });
  await Promise.race([
    new Promise<void>(r => map.once('style.load', () => r())),
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error('style did not load')), 3000)),
  ]);
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('MapLibre transform: the latitude range hack (lib/camera.ts)', () => {
  it('the private field is still where setLatRange writes it, and the public getter reads it back', () => {
    resetLatRangeWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(setLatRange(map.transform, 89.5)).toBe(true);
    expect(transform()._helper._latRange).toEqual([-89.5, 89.5]);
    expect(transform().latRange).toEqual([-89.5, 89.5]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives a flip to the globe and back (MapLibre copies it across transforms)', () => {
    setLatRange(map.transform, 89.5);
    map.setProjection(projectionSpec('globe'));
    expect(map.getProjection().type).toBe('globe');
    expect(setLatRange(map.transform, 80)).toBe(true);
    expect(transform().latRange).toEqual([-80, 80]);
    map.setProjection(projectionSpec('flat'));
    expect(transform().latRange).toEqual([-80, 80]);
    setLatRange(map.transform, 85.051129);
  });
});

describe('MapLibre transform: globe occlusion (lib/projection.ts globeLabelOpacity)', () => {
  it('on the globe the far side is occluded and the near side is not; Mercator occludes nothing', () => {
    map.setProjection(projectionSpec('flat'));
    map.jumpTo({ center: [0, 0], zoom: 1, pitch: 0 });
    expect(typeof transform().isLocationOccluded).toBe('function');
    expect(transform().isLocationOccluded!({ lng: 170, lat: 0 })).toBe(false);

    map.setProjection(projectionSpec('globe'));
    map.jumpTo({ center: [0, 0], zoom: 1, pitch: 0 });
    expect(transform().isLocationOccluded!({ lng: 0, lat: 0 })).toBe(false);
    expect(transform().isLocationOccluded!({ lng: 30, lat: 10 })).toBe(false);
    expect(transform().isLocationOccluded!({ lng: 170, lat: 0 })).toBe(true);
    expect(transform().isLocationOccluded!({ lng: 180, lat: 0 })).toBe(true);
    map.setProjection(projectionSpec('flat'));
  });

  it('globeLabelOpacity gives the real probe the last word: far side 0, centre 1, in between thinned', () => {
    map.setProjection(projectionSpec('globe'));
    map.jumpTo({ center: [0, 0], zoom: 1, pitch: 0 });
    const t = map.transform as unknown as OcclusionProbe;
    expect(globeLabelOpacity([0, 0], [0, 0], t)).toBe(1);
    expect(globeLabelOpacity([0, 0], [170, 0], t)).toBe(0);
    const edge = globeLabelOpacity([0, 0], [64, 0], t);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
    map.setProjection(projectionSpec('flat'));
  });
});

describe('MapLibre sky (lib/projection.ts skyFor)', () => {
  it('the globe sky is applied as given; flat removes the sky entirely (setSky(undefined))', () => {
    applySky(map, 'globe');
    expect(map.getSky()).toEqual(GLOBE_SKY);
    applySky(map, 'flat');
    expect(map.getSky()).toBeUndefined();
  });
});
