/**
 * Camera framing for "go to this thing": which positions a target occupies, the
 * smallest longitude/latitude box that holds them (across the antimeridian when
 * that is the shorter way round) and the screen insets the overlays leave.
 *
 * Pure so it is unit-tested without a map. The map applies the result with
 * `cameraForBounds` + `flyTo` / `jumpTo` (see ThreatMapV3).
 */

import type { LngLat } from '@/lib/country-centroids';
import type { DrillTarget } from './drill';
import type { OperationsModel } from './lens/operations';
import type { HostingModel } from './lens/hosting';
import type { CampaignsModel } from './lens/campaigns';
import type { MovementModel } from './lens/movement';
import type { ActorModel } from './lens/actors';
import { countryCenter, iso2 } from './lens/placement';
import { hasValidArc } from './geo';
import { selectionLngLat } from './selection';

/** Never zoom in past this when framing a group (street level is meaningless for countries). */
export const FIT_MAX_ZOOM = 3.5;
/** Zoom for a target that is a single point (a node, a country, a provider). */
export const POINT_ZOOM = 3.4;
/** Fly-to duration cap, ms. */
export const FLY_MS = 720;
/** MapLibre flight curve: lower is flatter / quicker, 1.42 is the default. */
export const FLY_CURVE = 1.2;
/** Breathing room kept between a framed target and the edge of the free area, px (a node never sits on the edge). */
export const FRAME_MARGIN = 40;
/** Mercator world width at zoom 0, px (512px tiles). */
const WORLD_PX = 512;
/** Closest-in floor of the phone's minimum zoom: it never needs to be higher than the original 0.5. */
const PHONE_MIN_ZOOM_CAP = 0.5;

/** MapLibre's own default minimum zoom (restored when leaving the phone layout), and the lowest it accepts. */
export const DEFAULT_MIN_ZOOM = -2;

/**
 * Lowest zoom a phone map may reach, derived from its canvas width: low enough that the whole world fits
 * inside the framing margins on both sides, so a world-spanning target (US to Japan) can be framed in full.
 * A fixed 0.5 floor clipped those on 400px screens (the world is 512px * 2^z wide).
 *
 * Never below MapLibre's own -2 floor: a canvas narrower than 232px would ask for less (the free width is
 * pinned at 64px, log2(64/512) = -3) and `setMinZoom` rejects anything under -2.
 */
export function phoneMinZoom(canvasWidth: number): number {
  if (!(canvasWidth > 0)) return PHONE_MIN_ZOOM_CAP;
  const free = Math.max(64, canvasWidth - 2 * (12 + FRAME_MARGIN));
  return Math.max(DEFAULT_MIN_ZOOM, Math.min(PHONE_MIN_ZOOM_CAP, Math.log2(free / WORLD_PX)));
}

/** Mercator's own latitude limit (MapLibre's default `latRange`). */
export const WORLD_LAT_LIMIT = 85.051129;
/**
 * Latitude range a phone map may show. MapLibre keeps the world covering the canvas VERTICALLY, so on an
 * 800px-tall phone it cannot zoom out below ~0.3 however low `minZoom` is, and a 214 degree target (US to
 * Japan) does not fit 400px of width. Allowing the (empty, background-coloured) space beyond the poles lifts
 * that floor, so the width-derived `phoneMinZoom` is what actually applies.
 */
export const PHONE_LAT_LIMIT = 89.5;

/** Half-size of the box built round a single point so cameraForBounds has something to fit. */
const POINT_EPS = 0.02;

export type { Insets } from './layout';
import type { Insets } from './layout';
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** A longitude/latitude box. `east` may exceed 180 when the box crosses the antimeridian (west < east always). */
export interface LngLatBox { west: number; south: number; east: number; north: number }

/** [-180, 180) */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Smallest box holding every finite point. Longitudes are compared on the circle:
 * the box spans the whole circle EXCEPT its largest gap, so Fiji + Alaska is a
 * 40-degree box across the date line (west 175, east 215), not a 350-degree one.
 */
export function boundsOf(points: ReadonlyArray<readonly [number, number]>): LngLatBox | null {
  const pts = points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length === 0) return null;
  let south = Infinity;
  let north = -Infinity;
  for (const p of pts) { south = Math.min(south, p[1]); north = Math.max(north, p[1]); }
  const lngs = pts.map(p => wrapLng(p[0])).sort((a, b) => a - b);
  let gap = -1;
  let gapAfter = 0; // index whose successor starts the box
  for (let i = 0; i < lngs.length; i++) {
    const next = i + 1 < lngs.length ? lngs[i + 1]! : lngs[0]! + 360;
    const g = next - lngs[i]!;
    if (g > gap) { gap = g; gapAfter = i; }
  }
  const west = lngs[(gapAfter + 1) % lngs.length]!;
  const span = 360 - gap;
  return { west, south, east: west + span, north };
}

/** Scale insets down so at least `minFree` px of the canvas stays free on each axis. */
export function clampInsets(insets: Insets, width: number, height: number, minFree = 140): Insets {
  const fit = (a: number, b: number, total: number): [number, number] => {
    const lo = Math.max(0, a);
    const hi = Math.max(0, b);
    const room = Math.max(0, total - minFree);
    if (lo + hi <= room || lo + hi === 0) return [lo, hi];
    const k = room / (lo + hi);
    return [lo * k, hi * k];
  };
  const [left, right] = fit(insets.left, insets.right, width);
  const [top, bottom] = fit(insets.top, insets.bottom, height);
  return { top, right, bottom, left };
}

export interface CameraPlan {
  box: LngLatBox;
  padding: Insets;
  maxZoom: number;
  /** True when the target is a single point (the camera lands on a fixed zoom). */
  point: boolean;
}

/** Framing for a set of positions: the box, the clamped padding and the zoom ceiling. */
export function planCamera(
  points: ReadonlyArray<readonly [number, number]>,
  canvas: { width: number; height: number },
  insets: Insets,
  opts: { maxZoom?: number; pointZoom?: number } = {},
): CameraPlan | null {
  const box = boundsOf(points);
  if (!box) return null;
  const padding = clampInsets(
    { top: insets.top + FRAME_MARGIN, right: insets.right + FRAME_MARGIN, bottom: insets.bottom + FRAME_MARGIN, left: insets.left + FRAME_MARGIN },
    canvas.width, canvas.height,
  );
  const degenerate = box.east - box.west < 1e-6 && box.north - box.south < 1e-6;
  if (degenerate) {
    const lng = box.west;
    const lat = box.south;
    return {
      box: { west: lng - POINT_EPS, east: lng + POINT_EPS, south: Math.max(-85, lat - POINT_EPS), north: Math.min(85, lat + POINT_EPS) },
      padding,
      maxZoom: opts.pointZoom ?? POINT_ZOOM,
      point: true,
    };
  }
  return { box, padding, maxZoom: opts.maxZoom ?? FIT_MAX_ZOOM, point: false };
}

// ─── What a target occupies ─────────────────────────────────

export interface FocusModels {
  operations: OperationsModel | null;
  hosting: HostingModel | null;
  campaigns: CampaignsModel | null;
  movement: MovementModel | null;
  actors: ActorModel | null;
}

const present = (list: Array<LngLat | null | undefined>): LngLat[] => list.filter((p): p is LngLat => !!p);
const centers = (codes: readonly string[] | undefined): LngLat[] => present((codes ?? []).map(c => countryCenter(iso2(c))));

/**
 * Every placeable position a target occupies, so the camera can frame ALL of it
 * (an operation spanning five countries, a campaign's adversaries and targets, a
 * movement's hops). Falls back to the target's own country list when the lens
 * model for it is not built yet.
 */
export function drillPoints(t: DrillTarget, m: FocusModels): LngLat[] {
  switch (t.kind) {
    case 'node': {
      const p = selectionLngLat({ kind: 'node', node: t.node });
      return p ? [p] : [];
    }
    case 'arc': {
      if (!hasValidArc(t.arc)) return [];
      return [t.arc.sourcePosition, t.arc.targetPosition];
    }
    case 'country':
      return present([countryCenter(t.code)]);
    case 'operation': {
      const ccs = m.operations?.countriesOf.get(t.id) ?? [];
      const nodes = ccs.flatMap(cc => m.operations?.nodeByCc.get(cc)?.position ?? []);
      return nodes.length > 0 ? ccs.map(cc => m.operations!.nodeByCc.get(cc)!.position) : centers(t.op?.countries);
    }
    case 'provider': {
      const ring = m.hosting?.byId.get(t.id);
      return ring ? [ring.position] : present([countryCenter(iso2(t.provider?.country ?? null))]);
    }
    case 'actor':
      return m.actors && m.actors.actorId === t.id ? m.actors.countries.map(c => c.position) : [];
    case 'campaign': {
      const arcs = m.campaigns?.arcs.filter(a => a.campaignId === t.id) ?? [];
      if (arcs.length > 0) {
        const out: LngLat[] = [];
        for (const a of arcs) {
          const from = countryCenter(a.from);
          const to = countryCenter(a.to);
          if (from) out.push(from);
          if (to) out.push(to);
        }
        return out;
      }
      return [...centers(t.campaign?.adversary_countries), ...centers(t.campaign?.target_countries)];
    }
    case 'movement': {
      const hops = m.movement?.hops.filter(h => h.eventId === t.id && !h.id.endsWith(':w')) ?? [];
      const pulses = m.movement?.pulses.filter(p => p.eventId === t.id) ?? [];
      if (hops.length > 0 || pulses.length > 0) {
        return [...hops.flatMap(h => [h.from, h.to]), ...pulses.map(p => p.position)];
      }
      return [...centers(t.movement?.from.countries), ...centers(t.movement?.to.countries)];
    }
  }
}

/** The slice of MapLibre 5's transform that holds the latitude range (private: there is no public setter that keeps lngRange null). */
interface LatRangeHolder {
  _helper?: { _latRange?: [number, number] | null };
}

/**
 * Set the latitude range the map may show. MapLibre 5 made `transform.latRange` a read-only getter over
 * `transform._helper._latRange`, and `setMaxBounds` also pins the longitude range (which would stop the world
 * wrapping), so the range is written to the helper directly. Guarded: when the shape is not there (a future
 * major, a stub) nothing happens and the library default applies. Returns whether it was applied.
 * MapLibre copies the range across projection switches (`transform.apply`), so it survives flat <-> globe.
 */
export function setLatRange(transform: unknown, lat: number): boolean {
  const helper = (transform as LatRangeHolder | null | undefined)?._helper;
  if (!helper || !('_latRange' in helper)) {
    warnLatRangeOnce();
    return false;
  }
  helper._latRange = [-lat, lat];
  return true;
}

let latRangeWarned = false;
/** Test seam. */
export function resetLatRangeWarning(): void { latRangeWarned = false; }
/**
 * This writes a private field, so a MapLibre upgrade can silently turn it into a no-op (the phone would be pinned at
 * ~zoom 0.3 and a world-spanning target clipped). In development say so, once; production builds drop the branch.
 */
function warnLatRangeOnce(): void {
  if (process.env.NODE_ENV === 'production' || latRangeWarned) return;
  latRangeWarned = true;
  console.warn('[observatory] setLatRange: MapLibre\'s transform no longer has _helper._latRange, so the widened phone latitude range is NOT applied. Re-check lib/camera.ts after the MapLibre upgrade.');
}
