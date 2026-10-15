/**
 * Map projection: Flat (Web Mercator, the analyst default) or Globe (MapLibre globe).
 *
 * Pure decisions, unit-tested without a map:
 *   - which projection actually applies (`effectiveProjection`): the density heatmap is
 *     a screen-space aggregation that deck.gl cannot draw on a globe, so it stays flat;
 *   - how the deck.gl overlay is attached (`overlayInterleaved`): the globe draws deck
 *     INTERLEAVED in MapLibre's own GL context (one depth buffer and the globe's clipping
 *     for free), the flat map keeps the cheaper separate overlay canvas;
 *   - the MapLibre projection spec and the sky that makes the globe read as a planet;
 *   - the zoom ceiling: MapLibre's `globe` blends into Mercator between zoom 11 and 12,
 *     and deck.gl's GlobeView would no longer match the transform there;
 *   - which side of the planet a point is on (labels on the far side are not placed).
 */

import { _GlobeView } from '@deck.gl/core';
import type { MapboxOverlayProps } from '@deck.gl/mapbox';
import type { SkySpecification } from 'maplibre-gl';
import type { LngLat } from '@/lib/country-centroids';
import { greatCircleAngle } from '../anim/great-circle';
import type { MapMode } from './url-state';

export const PROJECTION_IDS = ['flat', 'globe'] as const;
export type Projection = (typeof PROJECTION_IDS)[number];

export const DEFAULT_PROJECTION: Projection = 'flat';

export function isProjection(v: string | null | undefined): v is Projection {
  return v != null && (PROJECTION_IDS as readonly string[]).includes(v);
}

export const PROJECTION_LABEL: Record<Projection, string> = { flat: 'Flat map', globe: 'Globe' };

/**
 * The projection the map really draws for what was asked. The density heatmap (deck.gl
 * HeatmapLayer) aggregates in screen space and has no globe variant, so it is flat.
 */
export function effectiveProjection(requested: Projection, mapMode: MapMode): Projection {
  return requested === 'globe' && mapMode === 'heatmap' ? 'flat' : requested;
}

/** Globe: interleaved with the basemap's GL context. Flat: separate overlay canvas (cheaper, no basemap redraws). */
export function overlayInterleaved(projection: Projection): boolean {
  return projection === 'globe';
}

/** The MapLibre projection spec. `globe` is the shorthand that blends to Mercator at zoom 11-12. */
export function projectionSpec(projection: Projection): { type: 'globe' | 'mercator' } {
  return { type: projection === 'globe' ? 'globe' : 'mercator' };
}

/**
 * Highest zoom on the globe. MapLibre's `globe` interpolates to Mercator between zoom 11 and 12 while
 * the deck.gl overlay stays on a globe viewport until 12: stop at the start of the blend.
 */
export const GLOBE_MAX_ZOOM = 11;
export const FLAT_MAX_ZOOM = 12;
export const maxZoomFor = (projection: Projection): number => (projection === 'globe' ? GLOBE_MAX_ZOOM : FLAT_MAX_ZOOM);

/**
 * MapLibre's globe is drawn smaller than the orthographic 512 * 2^z / pi px (perspective: the camera is a
 * finite distance away); measured on the rendered limb it is ~85% of that.
 */
export const GLOBE_APPARENT_SCALE = 0.85;

/** Zoom at which the planet spans `fill` of the canvas's shorter side (the toolbar / timeline overlap the rest). */
export function globeFitZoom(width: number, height: number, fill = 0.72): number {
  const side = Math.min(width, height);
  if (!(side > 0)) return 1.2;
  return Math.max(0, Math.log2((side * fill * Math.PI) / (512 * GLOBE_APPARENT_SCALE)));
}

/**
 * Where the globe opens. Centred so the Americas, the Atlantic, Europe and Africa share the disc (the three regions most
 * threats originate in or target), not Europe alone: longitude -22 puts the eastern US/Canada in the left
 * half of the disc and Europe about a third in from its right edge (at -35 Europe sat on the limb, foreshortened), West Africa and the
 * Mediterranean in the right half; latitude 30 keeps the northern landmasses in view. Brazil sits nearer the lower-left limb. The idle spin
 * then carries on from here.
 */
export const GLOBE_START_CENTER: LngLat = [-22, 30];
/** The phone's centre: the disc is nearer square there, so it sits a little further east / north to keep Europe off the limb. */
export const GLOBE_START_CENTER_PHONE: LngLat = [-18, 32];
/** Share of the canvas's shorter side the planet spans at the start: a phone is narrow but tall, so it can afford more. */
export const GLOBE_START_FILL_DESKTOP = 0.72;
export const GLOBE_START_FILL_PHONE = 0.8;

/** The globe's opening camera for a canvas: the centre above and the zoom at which the planet spans `fill` of the shorter side. */
export function globeStartCamera(width: number, height: number, mobile: boolean): { center: LngLat; zoom: number } {
  return { center: mobile ? GLOBE_START_CENTER_PHONE : GLOBE_START_CENTER, zoom: globeFitZoom(width, height, mobile ? GLOBE_START_FILL_PHONE : GLOBE_START_FILL_DESKTOP) };
}

/**
 * Horizontal room the console's chrome takes (rail on the left, panel / drawer on the right). The flat map
 * runs underneath it, but a globe is a disc: while the WHOLE planet is in view it is centred in what is left by giving
 * the CANVAS that box (deck.gl's globe viewport has no `padding`, so MapLibre's own padding would put the overlay out of
 * register). Once zoomed in past the disc (`bleed`) the planet fills the view and flows under the chrome like the flat
 * map: an inset canvas would only cut it off at hard edges.
 */
export function globeCanvasBox(insets: { left: number; right: number }, projection: Projection, bleed = false): { left: number; right: number } {
  return projection === 'globe' && !bleed ? { left: Math.max(0, insets.left), right: Math.max(0, insets.right) } : { left: 0, right: 0 };
}

/** Apparent diameter (px) of the planet at `zoom` (MapLibre draws it at GLOBE_APPARENT_SCALE of the orthographic 512 * 2^z / pi). */
export function globeDiscPx(zoom: number): number {
  return ((512 * 2 ** zoom) / Math.PI) * GLOBE_APPARENT_SCALE;
}

/** The disc must be this much larger than the free area before the canvas goes full-bleed, and this much smaller before it is inset again. */
export const BLEED_ENTER = 1.02;
export const BLEED_EXIT = 0.9;

/**
 * Whether the globe canvas should be full-bleed at `zoom`: the disc no longer fits the area the chrome leaves free
 * (`freePx` = its shorter side). Hysteresis, so a zoom resting near the threshold does not flip the canvas back and forth.
 */
export function globeBleeds(zoom: number, freePx: number, wasBleeding: boolean): boolean {
  if (!(freePx > 0) || !Number.isFinite(zoom)) return wasBleeding;
  const disc = globeDiscPx(zoom);
  return wasBleeding ? disc > freePx * BLEED_EXIT : disc >= freePx * BLEED_ENTER;
}

/**
 * Animation frame cap on the globe. The interleaved overlay draws into MapLibre's own GL context, so every animated
 * frame repaints the WHOLE basemap (globe tiles, atmosphere, borders) as well as the layers; the flat map's separate
 * overlay canvas redraws only itself. Half the frames is indistinguishable for trails, pulses and rings and roughly
 * halves the GPU / CPU cost of a running globe. The camera (drag, zoom, spin) is MapLibre's and is not capped.
 */
export const GLOBE_ANIMATION_FPS = 30;

/** Backdrop behind the planet: deep space, whatever the page theme. */
export const GLOBE_BACKDROP = '#04070f';

/**
 * Atmosphere for the dark basemap: a cool limb glow and a fade to space, strongest when the
 * whole planet is in view and gone once zoomed in (the blend is zoom-driven by MapLibre).
 */
export const GLOBE_SKY: SkySpecification = {
  'sky-color': '#0a1530',
  'sky-horizon-blend': 0.7,
  'horizon-color': '#1d6fa5',
  'horizon-fog-blend': 0.6,
  'fog-color': '#0d2a4a',
  'fog-ground-blend': 0.35,
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 1, 7, 0],
};

/**
 * The sky to give MapLibre for a projection. Flat has NONE: `setSky(undefined)` removes the style's sky entirely, which
 * is exactly the state before the globe was ever shown. (The old flat sky, `{ 'atmosphere-blend': 0 }`, kept a sky
 * object alive with the library's default colours, so a steeply pitched flat map could show a default-coloured sky.)
 */
export function skyFor(projection: Projection): SkySpecification | undefined {
  return projection === 'globe' ? GLOBE_SKY : undefined;
}

/**
 * Set (or remove) the sky for `projection`. MapLibre's own `Map.setSky` is typed as requiring a specification although
 * the style layer behind it removes the sky on `undefined` (verified against the real library in maplibre-real.test.ts).
 */
export function applySky(map: { setSky(sky?: SkySpecification): unknown }, projection: Projection): void {
  map.setSky(skyFor(projection));
}

/**
 * Label visibility on the globe has two parts (the projector in ThreatMapV3 combines them):
 *   1. HARD occlusion: MapLibre's own `transform.isLocationOccluded` (exact for any pitch / zoom / bearing; a point
 *      behind the planet is never labelled);
 *   2. SOFT limb fade: text squashed against the horizon reads badly even while the point is still visible, so a
 *      label's opacity falls off with its angular distance from the view centre, from full at `LABEL_FADE_START_DEG`
 *      to gone at `LABEL_FADE_END_DEG`. (Centre distance is only an approximation of "how close to the limb" once the
 *      camera is pitched, which is why it is never the occlusion test.)
 */
export const LABEL_FADE_START_DEG = 52;
export const LABEL_FADE_END_DEG = 74;

/** Opacity (0..1) for a label `angleDeg` from the view centre: 1 inside the start, 0 past the end, smooth between. */
export function limbFade(angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) return 0;
  const t = (LABEL_FADE_END_DEG - angleDeg) / (LABEL_FADE_END_DEG - LABEL_FADE_START_DEG);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Angular distance in degrees between the view centre and a point. */
export function centreAngleDeg(center: LngLat, point: LngLat): number {
  return greatCircleAngle(center, point) * (180 / Math.PI);
}

/** The minimal slice of MapLibre's transform the label projector needs (absent on test doubles and old builds). */
export interface OcclusionProbe {
  isLocationOccluded?: (lngLat: { lng: number; lat: number }) => boolean;
}

/**
 * Opacity for a label anchored at `point` on the globe, or 0 when it must not be drawn. `transform` is
 * `map.transform`; guarded because it is not part of MapLibre's documented API: without it the fade alone applies.
 */
export function globeLabelOpacity(center: LngLat, point: LngLat, transform?: OcclusionProbe | null): number {
  try {
    if (typeof transform?.isLocationOccluded === 'function' && transform.isLocationOccluded({ lng: point[0], lat: point[1] })) return 0;
  } catch { /* an unsupported transform: fall back to the fade */ }
  return limbFade(centreAngleDeg(center, point));
}

/**
 * Mesh resolution (degrees) deck.gl cuts flat features into on the globe (default 10). Country
 * polygons are triangulated flat inside each cell, so a 10 degree cell sinks ~24 km under the
 * surface in the middle and the basemap hides it: choropleth fills came out as ragged strips along
 * the borders. At 1 degree the chord sag is ~0.2 km.
 */
export const GLOBE_RESOLUTION_DEG = 1;
/**
 * Depth bias pulling the overlay toward the camera, so what is left of that sag (and anything lying
 * exactly on the surface) wins the depth test against the basemap instead of z-fighting with it.
 * -4 left hatching in disc centres; -40 is clean (measured in the browser at zoom 2-4).
 */
export const GLOBE_DEPTH_BIAS = -40;

/**
 * The deck layers still TEST against the basemap's depth (that is what hides the far side of the
 * planet and what the bias above is for) but do not WRITE depth: coplanar layers (a node's bloom,
 * glow and core are discs on the same tangent plane) fought each other per pixel into a hatch
 * pattern. They are drawn in layer order instead, as on the flat map's overlay.
 */
export const GLOBE_DEPTH_WRITE = false;

/**
 * Layers whose geometry is offset in SCREEN pixels from a point on the surface (text labels) cannot use
 * the depth test on a globe: the offset fragments land on a different part of the curved surface, which is
 * nearer the camera than the anchor's depth, so the basemap hides them (and the globe's back-face culling
 * drops the glyph quads outright). They draw unconditionally instead; that is safe because their anchors
 * are only placed on the near side (`onNearSide`).
 */
export const GLOBE_SCREEN_SPACE_PARAMETERS = { depthCompare: 'always', depthWriteEnabled: false, cullMode: 'none' } as const;

/** The deck.gl overlay props that only the globe needs (interleaved mode). */
export function globeOverlayProps(): Pick<MapboxOverlayProps, 'views' | 'parameters'> {
  return {
    // The id is the one MapboxOverlay looks its view up by.
    // DeckProps types `views` as `null` unless the props are generic over the view; a GlobeView is what it takes.
    views: new _GlobeView({ id: 'mapbox', resolution: GLOBE_RESOLUTION_DEG }) as unknown as MapboxOverlayProps['views'],
    parameters: { depthBias: GLOBE_DEPTH_BIAS, depthWriteEnabled: GLOBE_DEPTH_WRITE },
  };
}

/**
 * The projection to leave a wall screen on. The wall opens on the globe by default, so the globe it shows is not the viewer's
 * choice: they get back what they had before it (`before`), or, with no earlier view in this page (a link that opened on the
 * wall), the console default. A projection picked on the wall itself (`chosen`) is kept as it is.
 */
export function wallExitProjection(current: Projection, before: Projection | null, chosen: boolean): Projection {
  if (chosen) return current;
  if (before) return before;
  return current === 'globe' ? DEFAULT_PROJECTION : current;
}

const BEFORE_WALL_KEY = 'averrow.observatory.projBeforeWall';

/**
 * The projection the viewer had before a wall screen, kept for the tab session: entering the wall by in-app navigation
 * remounts the page, which loses a component ref. Storage can be unavailable (private window, blocked site data): every
 * access is guarded and a miss is simply "no earlier view".
 */
export function readProjBeforeWall(): Projection | null {
  try {
    const v = window.sessionStorage.getItem(BEFORE_WALL_KEY);
    return isProjection(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeProjBeforeWall(proj: Projection): void {
  try {
    window.sessionStorage.setItem(BEFORE_WALL_KEY, proj);
  } catch {
    /* storage unavailable: the exit falls back to the console default */
  }
}
