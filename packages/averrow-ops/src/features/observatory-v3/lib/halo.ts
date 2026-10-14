/**
 * Halo (bloom / glow / provider-ring) sizing by zoom.
 *
 * Halos are drawn in screen pixels, so a halo that reads well at city scale is the same size when the whole world is in
 * view, and the dense regions (Europe above all) turn into one overlapping smear. Two measures, both pure:
 *
 *   1. `haloScaleForZoom`: a factor 0.4..1 that shrinks every halo toward the world view (full size from zoom 4 in);
 *   2. `thinForHalos`: at the zoomed-out end, only the heaviest node per small screen cell keeps its bloom / glow, so
 *      neighbours that would still overlap at the reduced size do not stack. The cores (the data points themselves) are
 *      never thinned.
 */

/** Below this zoom halos are at their smallest. */
export const HALO_MIN_ZOOM = 1;
/** From this zoom in halos are drawn at full size. */
export const HALO_FULL_ZOOM = 4;
/** Smallest factor (the whole world in view). */
export const HALO_MIN_SCALE = 0.4;
/** Factor steps: the value feeds React state, so it must not change on every frame of a zoom. */
const HALO_STEP = 0.05;
/** Screen cell (px) one halo may own at the smallest scale; 0 at full size. */
export const HALO_CELL_PX = 16;

/** Smooth 0..1 ramp over the zoom range. */
function ramp(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  const t = Math.max(0, Math.min(1, (zoom - HALO_MIN_ZOOM) / (HALO_FULL_ZOOM - HALO_MIN_ZOOM)));
  return t * t * (3 - 2 * t);
}

/** Multiplier for halo radii at `zoom`: `HALO_MIN_SCALE` at the world view, 1 from `HALO_FULL_ZOOM`, in 0.05 steps. */
export function haloScaleForZoom(zoom: number): number {
  const raw = HALO_MIN_SCALE + (1 - HALO_MIN_SCALE) * ramp(zoom);
  return Math.min(1, Math.round(raw / HALO_STEP) * HALO_STEP);
}

/** What the layers need of the camera: the scale and the (coarsened) zoom the thinning cells are measured at. */
export interface HaloView { scale: number; zoom: number }
/** Full size, no thinning: the view before the camera is known, and everywhere from `HALO_FULL_ZOOM` in. */
export const HALO_FULL: HaloView = { scale: 1, zoom: HALO_FULL_ZOOM };

/** The halo view for a camera zoom. The zoom is rounded to quarter steps and pinned once the halos are full size, so React state only changes when the picture would. */
export function haloViewForZoom(zoom: number): HaloView {
  const scale = haloScaleForZoom(zoom);
  if (scale >= 1) return HALO_FULL;
  return { scale, zoom: Math.round(Math.max(-2, zoom) * 4) / 4 };
}

/** Screen cell size (px) for `thinForHalos` at a scale from `haloScaleForZoom`: 0 (no thinning) at full size. */
export function haloCellPx(scale: number): number {
  if (!(scale < 1)) return 0;
  const t = (1 - Math.max(HALO_MIN_SCALE, scale)) / (1 - HALO_MIN_SCALE);
  return HALO_CELL_PX * t;
}

/** Web Mercator world pixels (512px tiles) of a position at `zoom`; latitude clamped to the projection's limit. */
export function worldPx(lng: number, lat: number, zoom: number): [number, number] {
  const size = 512 * 2 ** zoom;
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  return [((lng + 180) / 360) * size, (0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI)) * size];
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * Thinning weight of a node: severity first, then threat count. A critical 3-threat node must keep its breathing bloom
 * over a low-severity 40-threat neighbour in the same cell. The count is clamped under 1e9 so it can never outrank a severity step.
 */
export function haloWeight(severity: string | null | undefined, count: number): number {
  const rank = SEVERITY_RANK[(severity ?? '').toLowerCase()] ?? 0;
  return rank * 1e9 + Math.max(0, Math.min(count, 1e9 - 1));
}

/**
 * Keep the heaviest item per `cellPx` x `cellPx` screen cell (all of them when `cellPx` is 0). The input order is kept,
 * and ties go to the earlier item, so the result is stable for the same data.
 */
export function thinForHalos<T>(items: readonly T[], position: (item: T) => readonly [number, number], weight: (item: T) => number, zoom: number, cellPx: number): readonly T[] {
  if (!(cellPx > 0) || items.length < 2) return items;
  const best = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const [lng, lat] = position(items[i]!);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const [x, y] = worldPx(lng, lat, zoom);
    const key = `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
    const cur = best.get(key);
    if (cur === undefined || weight(items[i]!) > weight(items[cur]!)) best.set(key, i);
  }
  if (best.size === items.length) return items;
  const keep = new Set(best.values());
  return items.filter((_, i) => keep.has(i));
}
