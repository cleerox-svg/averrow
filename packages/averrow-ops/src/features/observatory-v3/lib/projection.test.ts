import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PROJECTION, PROJECTION_IDS, isProjection, effectiveProjection, overlayInterleaved, projectionSpec, maxZoomFor,
  globeFitZoom, globeCanvasBox, globeDiscPx, globeBleeds, BLEED_ENTER, BLEED_EXIT, limbFade, globeLabelOpacity, LABEL_FADE_START_DEG, LABEL_FADE_END_DEG, globeOverlayProps, centreAngleDeg, GLOBE_MAX_ZOOM, FLAT_MAX_ZOOM, GLOBE_SKY, skyFor,
  GLOBE_RESOLUTION_DEG, GLOBE_DEPTH_BIAS, GLOBE_DEPTH_WRITE, GLOBE_APPARENT_SCALE, GLOBE_START_CENTER, GLOBE_START_CENTER_PHONE, globeStartCamera,
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
    expect(skyFor('flat')).toBeUndefined(); // no sky at all: setSky(undefined) restores the pre-globe state
    expect(skyFor('globe')).toBe(GLOBE_SKY);
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
  it('globe zoomed past the disc (bleed): the planet flows under the chrome, the canvas is the whole box', () => {
    expect(globeCanvasBox({ left: 60, right: 340 }, 'globe', true)).toEqual({ left: 0, right: 0 });
    expect(globeCanvasBox({ left: 60, right: 340 }, 'globe', false)).toEqual({ left: 60, right: 340 });
  });
});

describe('globeBleeds: inset only while the disc fits', () => {
  const free = 700;
  const zoomWhereDiscIs = (frac: number) => Math.log2((frac * free * Math.PI) / (512 * GLOBE_APPARENT_SCALE));
  it('the disc grows with zoom and matches globeFitZoom\'s planet size', () => {
    expect(globeDiscPx(3)).toBeCloseTo(2 * globeDiscPx(2), 6);
    const z = globeFitZoom(1000, 700, 0.72);
    expect(globeDiscPx(z)).toBeCloseTo(0.72 * 700, 3);
  });
  it('the default planet-fit view is inset; zoomed far in it is full-bleed', () => {
    expect(globeBleeds(globeFitZoom(1000, 700), 700, false)).toBe(false);
    expect(globeBleeds(6, 700, false)).toBe(true);
  });
  it('enters bleed once the disc exceeds the free area, leaves it once it is well inside (hysteresis)', () => {
    expect(globeBleeds(zoomWhereDiscIs(BLEED_ENTER - 0.01), free, false)).toBe(false);
    expect(globeBleeds(zoomWhereDiscIs(BLEED_ENTER + 0.01), free, false)).toBe(true);
    expect(globeBleeds(zoomWhereDiscIs(1), free, true)).toBe(true);                 // resting at the threshold: stays
    expect(globeBleeds(zoomWhereDiscIs(BLEED_EXIT + 0.01), free, true)).toBe(true);
    expect(globeBleeds(zoomWhereDiscIs(BLEED_EXIT - 0.01), free, true)).toBe(false);
  });
  it('an unknown size or zoom changes nothing', () => {
    expect(globeBleeds(4, 0, false)).toBe(false);
    expect(globeBleeds(4, 0, true)).toBe(true);
    expect(globeBleeds(NaN, 700, true)).toBe(true);
  });
});

describe('limbFade: labels thin out toward the limb', () => {
  it('is full inside the start angle, gone past the end, monotone and smooth between', () => {
    expect(limbFade(0)).toBe(1);
    expect(limbFade(LABEL_FADE_START_DEG)).toBe(1);
    expect(limbFade(LABEL_FADE_END_DEG)).toBe(0);
    expect(limbFade(89)).toBe(0);
    let prev = 1;
    for (let a = LABEL_FADE_START_DEG; a <= LABEL_FADE_END_DEG; a += 2) {
      const f = limbFade(a);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
    const mid = limbFade((LABEL_FADE_START_DEG + LABEL_FADE_END_DEG) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });
  it('the fade ends well inside the horizon, so text is never squashed against the limb', () => {
    expect(LABEL_FADE_END_DEG).toBeLessThan(90);
    expect(LABEL_FADE_START_DEG).toBeLessThan(LABEL_FADE_END_DEG);
  });
  it('a non-finite angle is hidden', () => {
    expect(limbFade(NaN)).toBe(0);
  });
});

describe('globeLabelOpacity: occlusion is MapLibre\'s, the fade is ours', () => {
  const c: [number, number] = [20, 10];
  it('without a transform the fade alone applies: the centre is full, the antipode is gone', () => {
    expect(globeLabelOpacity(c, [20, 10])).toBe(1);
    expect(globeLabelOpacity(c, [-160, -10])).toBe(0);
  });
  it('is longitude-wrap safe', () => {
    expect(globeLabelOpacity([179, 0], [-179, 0])).toBe(1);
  });
  it('a point MapLibre says is occluded is hidden even when it is close to the view centre (a pitched camera)', () => {
    const isLocationOccluded = vi.fn(() => true);
    expect(globeLabelOpacity(c, [25, 12], { isLocationOccluded })).toBe(0);
    expect(isLocationOccluded).toHaveBeenCalledWith({ lng: 25, lat: 12 });
  });
  it('a visible point keeps its fade', () => {
    expect(globeLabelOpacity(c, [25, 12], { isLocationOccluded: () => false })).toBe(1);
    const near = globeLabelOpacity([0, 0], [63, 0], { isLocationOccluded: () => false });
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
  });
  it('a transform that throws or lacks the method falls back to the fade', () => {
    expect(globeLabelOpacity(c, [20, 10], { isLocationOccluded: () => { throw new Error('nope'); } })).toBe(1);
    expect(globeLabelOpacity(c, [20, 10], {})).toBe(1);
    expect(globeLabelOpacity(c, [20, 10], null)).toBe(1);
  });
});

describe('globeStartCamera: where the globe opens', () => {
  it('shows the Americas, the Atlantic, Europe and Africa together, not Europe alone', () => {
    const [lng, lat] = GLOBE_START_CENTER;
    // The centre of the disc is over the Atlantic: the eastern Americas (west of it) and Europe / Africa (east) all sit
    // inside the 74 degree radius where labels still draw. North America, Europe and Africa are inside the 52 degree
    // no-fade zone; South America sits in the fade band beyond it (but well inside the 62 degrees checked below).
    const angle = (a: [number, number], b: [number, number]) => centreAngleDeg(a, b);
    expect(lng).toBeLessThan(0);
    expect(angle([lng, lat], [-74, 40.7])).toBeLessThan(52);    // New York
    expect(angle([lng, lat], [-46.6, -23.5])).toBeLessThan(62); // Sao Paulo: south-west of the retuned centre, still drawn with labels
    expect(angle([lng, lat], [2.35, 48.85])).toBeLessThan(52);  // Paris
    expect(angle([lng, lat], [3.4, 6.5])).toBeLessThan(52);     // Lagos
    expect(angle([lng, lat], [-122.4, 37.8])).toBeLessThan(90); // San Francisco is on the near side, at the limb
    expect(angle([lng, lat], [139.7, 35.7])).toBeGreaterThan(90); // Tokyo is on the far side
  });

  it('is a fixed centre and the same planet-fit zoom the flip uses, a little larger (and a touch further east) on a phone', () => {
    const desktop = globeStartCamera(1440, 900, false);
    const phone = globeStartCamera(390, 844, true);
    expect(desktop.center).toBe(GLOBE_START_CENTER);
    expect(phone.center).toBe(GLOBE_START_CENTER_PHONE);
    expect(desktop.zoom).toBeCloseTo(globeFitZoom(1440, 900, 0.72), 9);
    expect(phone.zoom).toBeCloseTo(globeFitZoom(390, 844, 0.8), 9);
  });

  it('keeps the whole planet inside the canvas on desktop and phone (the disc is under the shorter side)', () => {
    for (const [w, h, m] of [[1440, 900, false], [1024, 700, false], [390, 844, true], [844, 390, true]] as const) {
      const { zoom } = globeStartCamera(w, h, m);
      expect(globeDiscPx(zoom)).toBeLessThan(Math.min(w, h));
      expect(globeDiscPx(zoom)).toBeGreaterThan(Math.min(w, h) * 0.5);
    }
  });
});
