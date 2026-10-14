/**
 * Splitting polygon rings at the antimeridian.
 *
 * Natural Earth ships countries that straddle ±180° (Russia's Chukotka, Fiji) as
 * rings whose consecutive vertices jump from +180 to -180. A planar renderer
 * (deck.gl in Web Mercator) connects those vertices with an edge that sweeps
 * across the whole world, painting a horizontal smear. The fix is to cut the ring
 * where it crosses ±180 and close each piece along the meridian, so every ring
 * lives inside [-180, 180] and has no edge longer than a hemisphere.
 *
 * Self-contained plain TypeScript (no aliases, no enums) on purpose: the geometry
 * asset is regenerated with `node --experimental-strip-types`, and the same code
 * is what the shipped-asset test exercises.
 */

export type Position = [number, number];
export type Ring = Position[];

/** Largest longitude step between consecutive vertices a correct ring may have. */
export const MAX_LNG_JUMP = 180;

/** Make longitudes continuous: each vertex is moved by ±360 until it is within 180° of the previous one. */
export function unwrapRing(ring: Ring): Ring {
  const out: Ring = [];
  for (const [lng, lat] of ring) {
    let x = lng;
    if (out.length > 0) {
      const prev = out[out.length - 1]![0];
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
    }
    out.push([x, lat]);
  }
  return out;
}

/** Sutherland–Hodgman against one vertical edge. `keep(x)` is true on the inside; the cut sits at `edge`. */
function clipAgainst(ring: Ring, edge: number, keep: (x: number) => boolean): Ring {
  if (ring.length === 0) return [];
  const out: Ring = [];
  const cross = (a: Position, b: Position): Position => {
    const f = (edge - a[0]) / (b[0] - a[0]);
    return [edge, a[1] + (b[1] - a[1]) * f];
  };
  // The ring is closed (first == last): iterate its distinct edges.
  const pts = ring.slice(0, -1);
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i]!;
    const prev = pts[(i + pts.length - 1) % pts.length]!;
    const curIn = keep(cur[0]);
    const prevIn = keep(prev[0]);
    if (curIn) {
      if (!prevIn) out.push(cross(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(cross(prev, cur));
    }
  }
  if (out.length > 0) out.push([out[0]![0], out[0]![1]]);
  return out;
}

/** Absolute planar area of a ring (shoelace). */
export function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 1; i < ring.length; i++) a += ring[i - 1]![0] * ring[i]![1] - ring[i]![0] * ring[i - 1]![1];
  return Math.abs(a) / 2;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Cut a closed ring at ±180. Returns the ring unchanged (as a single piece) when
 * it has no jump; otherwise the unwrapped ring is clipped to each 360° window it
 * overlaps and every piece is shifted back into [-180, 180].
 */
export function splitRingAtAntimeridian(ring: Ring): Ring[] {
  let jumps = false;
  for (let i = 1; i < ring.length; i++) {
    if (Math.abs(ring[i]![0] - ring[i - 1]![0]) > MAX_LNG_JUMP) { jumps = true; break; }
  }
  if (!jumps) return [ring];

  const un = unwrapRing(ring);
  let min = Infinity;
  let max = -Infinity;
  for (const p of un) { if (p[0] < min) min = p[0]; if (p[0] > max) max = p[0]; }

  const pieces: Ring[] = [];
  // Window k covers [-180 + 360k, 180 + 360k].
  for (let k = Math.floor((min + 180) / 360); k <= Math.floor((max + 180) / 360); k++) {
    const lo = -180 + 360 * k;
    const hi = 180 + 360 * k;
    let piece = clipAgainst(un, lo, x => x >= lo);
    piece = clipAgainst(piece, hi, x => x <= hi);
    if (piece.length < 4) continue;
    const shifted: Ring = piece.map(([x, y]) => [round1(x - 360 * k), round1(y)]);
    if (ringArea(shifted) < 1e-6) continue; // a zero-width sliver along the meridian
    pieces.push(shifted);
  }
  return pieces;
}

export interface PolygonGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

/** Split every ring of a (Multi)Polygon at the antimeridian. Holes stay with the piece that contains them only when they do not cross. */
export function splitGeometryAtAntimeridian(g: PolygonGeometry): { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } {
  const polys: Ring[][] = g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
  const out: Ring[][] = [];
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (!outer) continue;
    const pieces = splitRingAtAntimeridian(outer);
    if (pieces.length === 1 && pieces[0] === outer) { out.push(poly); continue; }
    for (const piece of pieces) out.push([piece]);
    // Holes in countries that cross ±180 do not occur at 110m; if one ever does it is dropped rather than mis-drawn.
    void holes;
  }
  return out.length === 1 ? { type: 'Polygon', coordinates: out[0] } : { type: 'MultiPolygon', coordinates: out };
}

/** Largest |Δlongitude| between consecutive vertices of any ring (the number the asset test bounds). */
export function maxLongitudeJump(g: PolygonGeometry): number {
  const polys: Ring[][] = g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
  let max = 0;
  for (const poly of polys) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
    max = Math.max(max, Math.abs(ring[i]![0] - ring[i - 1]![0]));
  }
  return max;
}
