import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROJECTION, PROJECTION_IDS, isProjection, effectiveProjection, overlayInterleaved, projectionSpec, maxZoomFor,
  globeFitZoom, globeCanvasBox, onNearSide, globeOverlayProps, GLOBE_MAX_ZOOM, FLAT_MAX_ZOOM, GLOBE_SKY, FLAT_SKY, HORIZON_DEG,
  GLOBE_RESOLUTION_DEG, GLOBE_DEPTH_BIAS, GLOBE_DEPTH_WRITE,
} from './projection';

describe('projection ids', () => {
  it('flat is the default; only flat and globe are projections', () => {
    expect(DEFAULT_PROJECTION).toBe('flat');
    expect([...PROJECTION_IDS]).toEqual(['flat', 'globe']);
    expect(isProjection('globe')).toBe(true);
    expect(isProjection('mercator')).toBe(false);
    expect(isProjection(null)).toBe(false);
  });
});

describe('effectiveProjection: what the map actually draws for what was asked', () => {
  it('the globe applies on every scene except the density heatmap, which is a screen-space aggregation', () => {
    expect(effectiveProjection('globe', 'global')).toBe('globe');
    expect(effectiveProjection('globe', 'bot_density')).toBe('globe');
    expect(effectiveProjection('globe', 'heatmap')).toBe('flat');
  });
  it('flat stays flat everywhere', () => {
    for (const mode of ['global', 'heatmap', 'bot_density'] as const) expect(effectiveProjection('flat', mode)).toBe('flat');
  });
});

describe('overlay + spec decisions', () => {
  it('the globe interleaves deck.gl with the basemap; the flat map keeps the separate overlay canvas', () => {
    expect(overlayInterleaved('globe')).toBe(true);
    expect(overlayInterleaved('flat')).toBe(false);
  });
  it('maps to MapLibre projection specs', () => {
    expect(projectionSpec('globe')).toEqual({ type: 'globe' });
    expect(projectionSpec('flat')).toEqual({ type: 'mercator' });
  });
  it('the globe stops zooming before MapLibre starts blending into Mercator (zoom 11)', () => {
    expect(maxZoomFor('globe')).toBe(GLOBE_MAX_ZOOM);
    expect(GLOBE_MAX_ZOOM).toBeLessThanOrEqual(11);
    expect(maxZoomFor('flat')).toBe(FLAT_MAX_ZOOM);
  });
  it('the flat sky has no atmosphere; the globe sky has a glow that fades with zoom', () => {
    expect(FLAT_SKY['atmosphere-blend']).toBe(0);
    expect(GLOBE_SKY['atmosphere-blend']).toBeTruthy();
    expect(GLOBE_SKY['horizon-color']).toBeTruthy();
  });
});

describe('globeOverlayProps: what only the interleaved globe overlay needs', () => {
  it('a GlobeView under the id MapboxOverlay looks up, with a fine mesh, and a depth bias toward the camera and no depth writes', () => {
    const p = globeOverlayProps();
    const view = p.views as unknown as { id: string; props: { resolution?: number } };
    expect(view.id).toBe('mapbox');
    expect(view.props.resolution).toBe(GLOBE_RESOLUTION_DEG);
    expect(GLOBE_RESOLUTION_DEG).toBeLessThan(10); // deck's default (10) sinks country fills under the surface
    expect(p.parameters).toEqual({ depthBias: GLOBE_DEPTH_BIAS, depthWriteEnabled: false });
    expect(GLOBE_DEPTH_BIAS).toBeLessThan(0);
    expect(GLOBE_DEPTH_WRITE).toBe(false); // coplanar layers must not fight each other on the globe
  });
});

describe('globeFitZoom', () => {
  it('fits the planet in the shorter side, larger canvases zoom in further', () => {
    expect(globeFitZoom(1200, 800)).toBeCloseTo(globeFitZoom(2000, 800), 6); // limited by height
    expect(globeFitZoom(1200, 1000)).toBeGreaterThan(globeFitZoom(1200, 800));
    expect(globeFitZoom(400, 800)).toBeLessThan(globeFitZoom(800, 800)); // limited by width
  });
  it('is finite and non-negative for degenerate canvases', () => {
    expect(globeFitZoom(0, 0)).toBeGreaterThan(0);
    expect(globeFitZoom(10, 10)).toBeGreaterThanOrEqual(0);
  });
  it('a ~800px canvas lands near the zoom measured on the rendered globe (~1.9)', () => {
    expect(globeFitZoom(1190, 820)).toBeGreaterThan(1.6);
    expect(globeFitZoom(1190, 820)).toBeLessThan(2.3);
  });
});

describe('globeCanvasBox: the globe is centred in what the chrome leaves free', () => {
  it('flat: the canvas is the whole box', () => {
    expect(globeCanvasBox({ left: 60, right: 340 }, 'flat')).toEqual({ left: 0, right: 0 });
  });
  it('globe: the canvas takes the horizontal insets', () => {
    expect(globeCanvasBox({ left: 60, right: 340 }, 'globe')).toEqual({ left: 60, right: 340 });
    expect(globeCanvasBox({ left: -5, right: 0 }, 'globe')).toEqual({ left: 0, right: 0 });
  });
});

describe('onNearSide: which points face the camera', () => {
  it('the view centre and its neighbourhood are near; the antipode and the far hemisphere are not', () => {
    const c: [number, number] = [20, 10];
    expect(onNearSide(c, [20, 10])).toBe(true);
    expect(onNearSide(c, [60, 30])).toBe(true);
    expect(onNearSide(c, [-160, -10])).toBe(false);
    expect(onNearSide(c, [-120, 40])).toBe(false);
  });
  it('the horizon sits inside 90 degrees so labels never hug the limb', () => {
    expect(HORIZON_DEG).toBeLessThan(90);
    expect(onNearSide([0, 0], [HORIZON_DEG + 2, 0])).toBe(false);
    expect(onNearSide([0, 0], [HORIZON_DEG - 2, 0])).toBe(true);
  });
  it('is longitude-wrap safe', () => {
    expect(onNearSide([179, 0], [-179, 0])).toBe(true);
  });
});
