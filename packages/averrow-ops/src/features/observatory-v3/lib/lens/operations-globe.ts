/**
 * The arc the globe draws for an Operations pair: the lifted great circle between the two countries.
 * Shared by the arc layer and by the edge labels, so a label sits ON the arc that is drawn (the flat path would put it
 * on a straight line through the planet's interior).
 */

import { greatCirclePath3D, EARTH_RADIUS_M, type LngLatAlt } from '../../anim/great-circle';
import { cumulativeDistances } from '../../anim/dash-flow-extension';
import type { OpEdge } from './operations';

export interface GlobeArc { path: LngLatAlt[]; distances: number[] }

const SEGMENTS = 24;
const LIFT = 0.12;
const cache = new WeakMap<OpEdge, GlobeArc>();

export function globeEdgePath(e: OpEdge): GlobeArc {
  let hit = cache.get(e);
  if (!hit) {
    const path = greatCirclePath3D(e.path[0]!, e.path[e.path.length - 1]!, SEGMENTS, EARTH_RADIUS_M * LIFT);
    hit = { path, distances: cumulativeDistances(path.map(p => [p[0], p[1]] as [number, number])) };
    cache.set(e, hit);
  }
  return hit;
}
