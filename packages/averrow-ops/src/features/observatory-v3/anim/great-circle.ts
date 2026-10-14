/**
 * Great-circle geometry for arcs, flows and (later) the globe.
 *
 * Mercator rendering and the antimeridian: a great circle that crosses ±180°
 * must not be drawn as a path that jumps from +179° to -179° (it would streak
 * across the whole map). `greatCirclePath` therefore UNWRAPS longitudes — each
 * point is within 180° of the previous one, so the path is one continuous
 * polyline that may run past ±180 (MapLibre/deck draw the adjacent world copy).
 * That keeps one path per arc, which is what TripsLayer-style timestamps need.
 * Consumers that need strictly in-range longitudes use `splitAtAntimeridian`.
 */

import type { LngLat } from '@/lib/country-centroids';

export type LngLatAlt = [number, number, number];

export const MAX_GREAT_CIRCLE_SEGMENTS = 64;
export const EARTH_RADIUS_M = 6_371_008.8;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EPS = 1e-9;

type Vec3 = [number, number, number];

function toVec(lng: number, lat: number): Vec3 {
  const phi = lat * D2R;
  const lam = lng * D2R;
  const c = Math.cos(phi);
  return [c * Math.cos(lam), c * Math.sin(lam), Math.sin(phi)];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Wrap a longitude into [-180, 180). */
export function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Central angle between two points, radians (haversine; stable for tiny and near-antipodal spans). */
export function greatCircleAngle(a: LngLat, b: LngLat): number {
  const p1 = a[1] * D2R;
  const p2 = b[1] * D2R;
  const dl = (b[0] - a[0]) * D2R;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Parabolic arc altitude: 0 at both ends, `peak` at t = 0.5. */
export function arcAltitude(t: number, peak: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 4 * peak * c * (1 - c);
}

/** Peak altitude (metres) scaled by span: antipodal arcs reach `maxAltitude`, short hops stay low. */
export function arcPeakAltitude(angleRad: number, maxAltitude: number = EARTH_RADIUS_M * 0.2): number {
  return maxAltitude * Math.min(1, Math.max(0, angleRad / Math.PI));
}

function clampSegments(segments: number): number {
  if (!Number.isFinite(segments)) return 32;
  return Math.min(MAX_GREAT_CIRCLE_SEGMENTS, Math.max(1, Math.floor(segments)));
}

/** Unit vectors along the great circle a -> b at fractions t = i / n, i = 0..n. */
function slerpPoints(a: LngLat, b: LngLat, n: number): Vec3[] {
  const A = toVec(a[0], a[1]);
  const B = toVec(b[0], b[1]);
  const theta = Math.acos(Math.min(1, Math.max(-1, dot(A, B))));
  const out: Vec3[] = [];

  if (theta < EPS) {
    for (let i = 0; i <= n; i++) out.push(A);
    return out;
  }

  if (Math.PI - theta < 1e-7) {
    // Antipodal: the great circle is not unique. Rotate A by π about an axis ⟂ A
    // (prefer the one through the poles so the route runs over a pole).
    let k = cross(A, [0, 0, 1]);
    if (norm(k) < EPS) k = cross(A, [1, 0, 0]);
    const kn = norm(k);
    const K: Vec3 = [k[0] / kn, k[1] / kn, k[2] / kn];
    const KxA = cross(K, A);
    for (let i = 0; i <= n; i++) {
      const phi = (Math.PI * i) / n;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      out.push([A[0] * c + KxA[0] * s, A[1] * c + KxA[1] * s, A[2] * c + KxA[2] * s]);
    }
    return out;
  }

  const sinTheta = Math.sin(theta);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    out.push([wa * A[0] + wb * B[0], wa * A[1] + wb * B[1], wa * A[2] + wb * B[2]]);
  }
  return out;
}

/**
 * Great-circle polyline from `a` to `b` with `segments` (1..64) segments, i.e.
 * segments + 1 points. First point is `a` exactly; last is `b`, expressed on the
 * same unwrapped branch as the rest of the path (so it may differ from b[0] by a
 * multiple of 360). Longitudes are continuous: consecutive points never jump by
 * more than 180°.
 */
export function greatCirclePath(a: LngLat, b: LngLat, segments = 32): LngLat[] {
  const n = clampSegments(segments);
  const pts = slerpPoints(a, b, n);
  const path: LngLat[] = [];
  let prevLng = a[0];
  for (let i = 0; i <= n; i++) {
    const v = pts[i]!;
    const lat = Math.asin(Math.min(1, Math.max(-1, v[2]))) * R2D;
    let lng: number;
    if (i === 0) {
      lng = a[0];
    } else {
      const raw = Math.atan2(v[1], v[0]) * R2D;
      lng = raw + 360 * Math.round((prevLng - raw) / 360);
    }
    if (i === n) {
      // Land exactly on b, on the branch nearest the previous point.
      path.push([b[0] + 360 * Math.round((prevLng - b[0]) / 360), b[1]]);
    } else if (i === 0) {
      path.push([a[0], a[1]]);
    } else {
      path.push([lng, lat]);
    }
    prevLng = path[i]![0];
  }
  return path;
}

/** greatCirclePath with a parabolic altitude (metres) per point, for 3D / globe rendering. */
export function greatCirclePath3D(
  a: LngLat, b: LngLat, segments = 32, maxAltitude: number = EARTH_RADIUS_M * 0.2,
): LngLatAlt[] {
  const flat = greatCirclePath(a, b, segments);
  const peak = arcPeakAltitude(greatCircleAngle(a, b), maxAltitude);
  const n = flat.length - 1;
  return flat.map((p, i) => [p[0], p[1], arcAltitude(n === 0 ? 0 : i / n, peak)] as LngLatAlt);
}

/**
 * Split a (possibly unwrapped) polyline into pieces whose longitudes all lie in
 * [-180, 180], inserting interpolated points on the ±180 meridian at each crossing.
 */
export function splitAtAntimeridian(path: ReadonlyArray<LngLat>): LngLat[][] {
  if (path.length === 0) return [];
  const segments: LngLat[][] = [];
  let current: LngLat[] = [];
  let prevUnwrapped = path[0]![0];
  let prevWorld = Math.floor((prevUnwrapped + 180) / 360);
  current.push([prevUnwrapped - prevWorld * 360, path[0]![1]]);

  for (let i = 1; i < path.length; i++) {
    const [lng, lat] = path[i]!;
    const prevLat = path[i - 1]![1];
    const world = Math.floor((lng + 180) / 360);
    if (world !== prevWorld) {
      // Crossed one or more ±180 boundaries between prevUnwrapped and lng.
      const dir = world > prevWorld ? 1 : -1;
      let fromLng = prevUnwrapped;
      let fromLat = prevLat;
      for (let w = prevWorld; w !== world; w += dir) {
        const boundary = dir > 0 ? (w + 1) * 360 - 180 : w * 360 - 180;
        const f = (boundary - fromLng) / (lng - fromLng);
        const crossLat = fromLat + (lat - fromLat) * f;
        current.push([dir > 0 ? 180 : -180, crossLat]);
        segments.push(current);
        current = [[dir > 0 ? -180 : 180, crossLat]];
        fromLng = boundary;
        fromLat = crossLat;
      }
    }
    current.push([lng - world * 360, lat]);
    prevUnwrapped = lng;
    prevWorld = world;
  }
  segments.push(current);
  return segments;
}
