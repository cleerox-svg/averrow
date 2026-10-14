/**
 * Map labels for the lens layers (operation evidence edges, hosting providers).
 *
 * Two stages, deliberately split:
 *   1. SOURCES — every label that could be shown, with its geographic anchor and
 *      priority. Derived from a model (+ selection) and memoised on that identity,
 *      so it is computed once, never per frame.
 *   2. PLACEMENT — which of them fit, in screen space, at the current camera.
 *      Needs a projection, so the map runs it when the camera settles and hands the
 *      result to the layers as `PlacedLabels`. Between camera moves its identity
 *      is stable (same data => deck does no work).
 */

import type { LngLat } from '@/lib/country-centroids';
import type { OperationsModel, OpEdge } from '../lib/lens/operations';
import type { HostingModel } from '../lib/lens/hosting';
import { placeLabels, samePlacement, type LabelCandidate, type Obstacle } from '../lib/label-placement';
import { memoByModelAndKey } from './memo';

// ─── Stage 1: sources ───────────────────────────────────────

export interface EdgeLabelSource {
  id: string;
  /** Short map text ("◆ cert"). */
  text: string;
  /** Anchor: the edge midpoint. */
  position: LngLat;
  /** Path vertices either side of the midpoint (for the screen angle). */
  before: LngLat;
  after: LngLat;
  /** Edge ends (to skip edges too short for their label). */
  from: LngLat;
  to: LngLat;
  priority: number;
}

export interface HostLabelSource {
  id: string;
  text: string;
  position: LngLat;
  radiusPx: number;
  priority: number;
}

/** Candidates considered per kind before screen-space de-dup. */
export const MAX_EDGE_CANDIDATES = 60;
export const MAX_HOST_CANDIDATES = 14;
/** Labels kept after de-dup. */
export const MAX_EDGE_LABELS = 10;
export const MAX_HOST_LABELS = 8;

const pathLength = (e: OpEdge): number => e.distances[e.distances.length - 1] ?? 0;

/**
 * One label per operation (and evidence kind): a star of "same ASN" edges would otherwise repeat the
 * same words N times. The selected component's edges outrank everything else.
 */
export const edgeLabelSources = memoByModelAndKey((m: OperationsModel, group: string): EdgeLabelSource[] => {
  const best = new Map<string, OpEdge>();
  for (const e of m.edges) {
    const key = `${e.opIds.join('+')}|${e.short}`;
    const cur = best.get(key);
    if (!cur || pathLength(e) > pathLength(cur)) best.set(key, e);
  }
  const out: EdgeLabelSource[] = [];
  for (const e of best.values()) {
    const mid = Math.floor(e.path.length / 2);
    out.push({
      id: e.id,
      text: e.short,
      position: e.midpoint,
      before: e.path[Math.max(0, mid - 1)]!,
      after: e.path[Math.min(e.path.length - 1, mid + 1)]!,
      from: e.path[0]!,
      to: e.path[e.path.length - 1]!,
      priority: (group && e.group === group ? 1e6 : 0) + pathLength(e),
    });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, MAX_EDGE_CANDIDATES);
});

export const hostLabelSources = memoByModelAndKey((m: HostingModel, selectedId: string): HostLabelSource[] => {
  const out: HostLabelSource[] = [];
  m.rings.forEach((r, i) => {
    if (i >= MAX_HOST_CANDIDATES && r.id !== selectedId) return;
    out.push({ id: r.id, text: r.name, position: r.position, radiusPx: r.radiusPx, priority: r.id === selectedId ? 1e9 : r.active });
  });
  return out;
});

// ─── Stage 2: placement ─────────────────────────────────────

export interface PlacedEdgeLabel { id: string; text: string; position: LngLat; angle: number }
export interface PlacedHostLabel { id: string; text: string; position: LngLat; radiusPx: number }
export interface PlacedLabels {
  edges: PlacedEdgeLabel[];
  hosts: PlacedHostLabel[];
}

export const NO_LABELS: PlacedLabels = { edges: [], hosts: [] };

export type Project = (p: LngLat) => { x: number; y: number } | null;

export interface PlaceInput {
  edges: readonly EdgeLabelSource[];
  hosts: readonly HostLabelSource[];
  /** Discs the labels must clear (operation nodes, provider rings). */
  nodes: ReadonlyArray<{ position: LngLat; radiusPx: number }>;
}

const CHAR_PX = 6.6; // 11px mono
const LABEL_H = 14;

/** Greedy screen-space placement of both label sets at the current camera. */
export function placeLensLabels(input: PlaceInput, project: Project, size: { width: number; height: number }): PlacedLabels {
  const obstacles: Obstacle[] = [];
  for (const n of input.nodes) {
    const p = project(n.position);
    if (p) obstacles.push({ x: p.x, y: p.y, r: n.radiusPx + 2 });
  }

  const edgeCands: LabelCandidate[] = [];
  const edgeById = new Map<string, EdgeLabelSource>();
  for (const e of input.edges) {
    const mid = project(e.position);
    const a = project(e.before);
    const b = project(e.after);
    const f = project(e.from);
    const t = project(e.to);
    if (!mid || !a || !b || !f || !t) continue;
    // An edge too short to carry its text between two nodes gets no label (the tooltip has it).
    const len = Math.hypot(t.x - f.x, t.y - f.y);
    if (len < e.text.length * CHAR_PX + 28) continue;
    edgeCands.push({
      id: e.id, text: e.text, x: mid.x, y: mid.y, priority: e.priority,
      angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
    });
    edgeById.set(e.id, e);
  }
  const edges = placeLabels(edgeCands, { width: size.width, height: size.height, charPx: CHAR_PX, heightPx: LABEL_H, max: MAX_EDGE_LABELS, obstacles })
    .map(p => {
      const src = edgeById.get(p.id)!;
      return { id: p.id, text: src.text, position: src.position, angle: p.angle } satisfies PlacedEdgeLabel;
    });

  const hostCands: LabelCandidate[] = [];
  const hostById = new Map<string, HostLabelSource>();
  for (const h of input.hosts) {
    const p = project(h.position);
    if (!p) continue;
    hostCands.push({ id: h.id, text: h.text, x: p.x, y: p.y, dy: h.radiusPx + 10, priority: h.priority });
    hostById.set(h.id, h);
  }
  // Edge labels already placed are obstacles for provider names too (they can share a lens when layers compose).
  const hostObstacles = obstacles.concat(edges.flatMap(e => {
    const p = project(e.position);
    return p ? [{ x: p.x, y: p.y, r: (e.text.length * CHAR_PX) / 2 }] : [];
  }));
  const hosts = placeLabels(hostCands, { width: size.width, height: size.height, charPx: 6.4, heightPx: LABEL_H, max: MAX_HOST_LABELS, obstacles: hostObstacles })
    .map(p => {
      const src = hostById.get(p.id)!;
      return { id: p.id, text: src.text, position: src.position, radiusPx: src.radiusPx } satisfies PlacedHostLabel;
    });

  return { edges, hosts };
}

/** Keep the previous object when nothing visible changed, so layer `data` identity survives no-op camera moves. */
export function stablePlacement(prev: PlacedLabels, next: PlacedLabels): PlacedLabels {
  const same =
    samePlacement(prev.edges.map(e => ({ id: e.id, angle: e.angle })), next.edges.map(e => ({ id: e.id, angle: e.angle }))) &&
    samePlacement(prev.hosts.map(h => ({ id: h.id, angle: 0 })), next.hosts.map(h => ({ id: h.id, angle: 0 })));
  return same ? prev : next;
}
