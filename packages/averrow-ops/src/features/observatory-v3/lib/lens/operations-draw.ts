/**
 * Drawing scales for the Operations lens, shared by the layers, the labels and the legend so the three cannot drift:
 * node size, node draw order and arc stroke.
 */

import type { OperationsModel, OpNode, OpEdge } from './operations';

export interface OpCountRange { min: number; max: number }

const rangeCache = new WeakMap<OperationsModel, OpCountRange>();
/** Smallest and largest operation count over the country nodes (memoised on the model). */
export function opCountRange(m: OperationsModel): OpCountRange {
  let r = rangeCache.get(m);
  if (!r) {
    let min = Infinity;
    let max = 0;
    for (const n of m.nodes) { min = Math.min(min, n.opCount); max = Math.max(max, n.opCount); }
    r = { min: Number.isFinite(min) ? min : 0, max };
    rangeCache.set(m, r);
  }
  return r;
}

/**
 * A country node's radius, px. Min-max normalised, not count/max: with 25 countries carrying 15..40 operations a
 * count/max scale put every node within a few px of the cap (a wall of identical blobs); this spends the whole
 * 6..14px range on the spread that exists. One shared count (min == max) sits mid-scale.
 */
export function opNodeRadius(count: number, range: OpCountRange): number {
  const f = range.max > range.min ? Math.sqrt((count - range.min) / (range.max - range.min)) : 0.5;
  return 6 + 8 * Math.max(0, Math.min(1, f));
}

/** Pixel radius a country node's bloom is drawn at (labels keep clear of it). */
export const opNodePx = (count: number, range: OpCountRange): number => opNodeRadius(count, range) * 2.1;

const drawOrderCache = new WeakMap<OperationsModel, OpNode[]>();
/** Country nodes in DRAW order: the biggest first, so a small node is never hidden (or unpickable) under a big one's bloom. */
export function opNodesDrawOrder(m: OperationsModel): OpNode[] {
  let out = drawOrderCache.get(m);
  if (!out) {
    out = [...m.nodes].sort((a, b) => b.opCount - a.opCount || a.country.localeCompare(b.country));
    drawOrderCache.set(m, out);
  }
  return out;
}

/** How many country nodes carry a text label ("DE 37"): the busiest few, the rest are in the tooltip. */
export const MAX_NODE_LABELS = 10;

/**
 * Arc stroke from the number of operations sharing the pair, RELATIVE to the busiest drawn pair so the scale
 * always spends its full range: one operation reads clearly lighter than the busiest, whatever the busiest is.
 */
export function opEdgeStyle(opCount: number, maxPairOps: number): { width: number; alpha: number } {
  const rel = maxPairOps > 0 ? Math.min(1, opCount / maxPairOps) : 1;
  return { width: 1 + Math.min(2.4, 0.7 * Math.sqrt(opCount)), alpha: Math.round(70 + 160 * rel) };
}

/** The most operations sharing one pair among `edges` (1 when empty, so the scale never divides by zero). */
export function maxPairOps(edges: readonly OpEdge[]): number {
  return edges.reduce((m, e) => Math.max(m, e.opCount), 1);
}

/** The faint solid line under the dashed flow keeps a link readable in the gaps (fraction of the flow's alpha). */
export const OP_EDGE_UNDERLAY = 0.4;
