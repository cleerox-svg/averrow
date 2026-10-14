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
import { confidenceBand, actorNodePx, type ActorModel } from '../lib/lens/actors';
import { placeLabels, type LabelCandidate, type Obstacle } from '../lib/label-placement';
import { memoByModel, memoByModelAndKey } from './memo';

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

export interface ActorLabelSource {
  /** Country code. */
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
export const MAX_ACTOR_LABELS = 10;

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

/** One label per attributed country: "DE · high". Most-attested, best-evidenced first. */
export const actorLabelSources = memoByModel((m: ActorModel): ActorLabelSource[] =>
  m.countries.map(c => ({
    id: c.country,
    text: `${c.country} · ${confidenceBand(c.confidence)}`,
    position: c.position,
    radiusPx: actorNodePx(c.items),
    priority: c.items + (c.confidence ?? 0),
  })));

// ─── Stage 2: placement ─────────────────────────────────────

export interface PlacedEdgeLabel { id: string; text: string; position: LngLat; angle: number }
export interface PlacedHostLabel { id: string; text: string; position: LngLat; radiusPx: number }
export interface PlacedActorLabel { id: string; text: string; position: LngLat; radiusPx: number }
export interface PlacedLabels {
  edges: PlacedEdgeLabel[];
  hosts: PlacedHostLabel[];
  actors: PlacedActorLabel[];
}

export const NO_LABELS: PlacedLabels = { edges: [], hosts: [], actors: [] };

export type Project = (p: LngLat) => { x: number; y: number } | null;

export interface PlaceInput {
  edges: readonly EdgeLabelSource[];
  hosts: readonly HostLabelSource[];
  /** The Actors lens's country markers (optional: only that lens draws them). */
  actors?: readonly ActorLabelSource[];
  /** Discs the labels must clear (operation nodes, provider rings). */
  nodes: ReadonlyArray<{ position: LngLat; radiusPx: number; /** Provider id: its own label may sit against it. */ id?: string }>;
}

const CHAR_PX = 6.6; // 11px mono
const LABEL_H = 14;

/** Greedy screen-space placement of both label sets at the current camera. */
export function placeLensLabels(input: PlaceInput, project: Project, size: { width: number; height: number }): PlacedLabels {
  const obstacles: Obstacle[] = [];
  for (const n of input.nodes) {
    const p = project(n.position);
    if (p) obstacles.push({ x: p.x, y: p.y, r: n.radiusPx + 2, id: n.id });
  }

  const edgeCands: LabelCandidate[] = [];
  const edgeById = new Map<string, EdgeLabelSource>();
  for (const e of input.edges) {
    const mid = project(e.position);
    const a = project(e.before);
    const b = project(e.after);
    const f = project(e.from);
    const t = project(e.to);
    if (!mid || !a || !b) continue;
    // An edge too short to carry its text between two nodes gets no label (the tooltip has it).
    // An end the projection cannot place (past the globe's horizon) means the edge is long, not short.
    if (f && t && Math.hypot(t.x - f.x, t.y - f.y) < e.text.length * CHAR_PX + 28) continue;
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

  // Actor country markers: their names get the same treatment (no clipping at the edge, no collisions
  // with the edge / provider labels already placed).
  const actorCands: LabelCandidate[] = [];
  const actorById = new Map<string, ActorLabelSource>();
  for (const a of input.actors ?? []) {
    const p = project(a.position);
    if (!p) continue;
    actorCands.push({ id: a.id, text: a.text, x: p.x, y: p.y, dy: a.radiusPx + 10, priority: a.priority });
    actorById.set(a.id, a);
  }
  const actorObstacles = hostObstacles.concat(hosts.flatMap(h => {
    const p = project(h.position);
    return p ? [{ x: p.x, y: p.y + h.radiusPx + 10, r: (h.text.length * 6.4) / 2 }] : [];
  }));
  const actors = placeLabels(actorCands, { width: size.width, height: size.height, charPx: CHAR_PX, heightPx: LABEL_H, max: MAX_ACTOR_LABELS, obstacles: actorObstacles })
    .map(p => {
      const src = actorById.get(p.id)!;
      return { id: p.id, text: src.text, position: src.position, radiusPx: src.radiusPx } satisfies PlacedActorLabel;
    });

  return { edges, hosts, actors };
}

const samePos = (a: LngLat, b: LngLat): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Keep the previous object when nothing visible changed, so layer `data` identity survives no-op camera moves.
 * "Visible" is everything a label draws from: id and order, text, anchor position, ring radius and (edges)
 * the screen angle to the degree. A refetch that keeps the same ids but moves a provider, renames it or
 * resizes its ring must NOT be swallowed here, or the map keeps painting the old label.
 */
export function stablePlacement(prev: PlacedLabels, next: PlacedLabels): PlacedLabels {
  const edgesSame = prev.edges.length === next.edges.length && prev.edges.every((e, i) => {
    const n = next.edges[i]!;
    return e.id === n.id && e.text === n.text && samePos(e.position, n.position) && Math.round(e.angle) === Math.round(n.angle);
  });
  const hostsSame = prev.hosts.length === next.hosts.length && prev.hosts.every((h, i) => {
    const n = next.hosts[i]!;
    return h.id === n.id && h.text === n.text && h.radiusPx === n.radiusPx && samePos(h.position, n.position);
  });
  const actorsSame = prev.actors.length === next.actors.length && prev.actors.every((a, i) => {
    const n = next.actors[i]!;
    return a.id === n.id && a.text === n.text && a.radiusPx === n.radiusPx && samePos(a.position, n.position);
  });
  return edgesSame && hostsSame && actorsSame ? prev : next;
}
