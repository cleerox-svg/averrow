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
import type { OpEdge, OperationsModel } from '../lib/lens/operations';
import { globeEdgePath } from '../lib/lens/operations-globe';
import { opCountRange, opNodePx, MAX_NODE_LABELS } from '../lib/lens/operations-draw';
import type { Projection } from '../lib/projection';
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

/** A country node's name with its operation count ("DE 37"). */
export interface NodeLabelSource {
  /** Country code. */
  id: string;
  text: string;
  position: LngLat;
  /**
   * The node's BLOOM radius, px: the label sits just below it. (Inside the bloom the glyph tops are cut off by the
   * translucent disc drawn before the text.)
   */
  radiusPx: number;
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
 * One label per evidence kind per lead operation among the arcs being DRAWN (`edges` is the visible set, see
 * `visibleEdges`): a star of "same ASN" arcs would otherwise repeat the same words N times. The selected
 * operation's arcs outrank everything else, then the ones shared by more operations.
 */
const edgeLabelSourcesFor = memoByModelAndKey((edges: OpEdge[], key: string): EdgeLabelSource[] => {
  const globe = key.startsWith('globe|');
  const selOpId = key.slice(key.indexOf('|') + 1);
  const best = new Map<string, OpEdge>();
  for (const e of edges) {
    const k = `${e.opIds[0]}|${e.short}`;
    const cur = best.get(k);
    if (!cur || pathLength(e) > pathLength(cur)) best.set(k, e);
  }
  const out: EdgeLabelSource[] = [];
  for (const e of best.values()) {
    // The label sits on the arc that is DRAWN: on the globe that is the great circle, not the flat polyline.
    const path: readonly LngLat[] = globe ? globeEdgePath(e).path.map(p => [p[0], p[1]] as LngLat) : e.path;
    const mid = Math.floor(path.length / 2);
    out.push({
      id: e.id,
      text: e.short,
      position: path[mid]!,
      before: path[Math.max(0, mid - 1)]!,
      after: path[Math.min(path.length - 1, mid + 1)]!,
      from: path[0]!,
      to: path[path.length - 1]!,
      priority: (selOpId && e.opIds.includes(selOpId) ? 1e6 : 0) + e.opCount * 1e3 + pathLength(e),
    });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, MAX_EDGE_CANDIDATES);
});

export const edgeLabelSources = (edges: OpEdge[], selOpId: string, projection: Projection = 'flat'): EdgeLabelSource[] =>
  edgeLabelSourcesFor(edges, `${projection === 'globe' ? 'globe' : 'flat'}|${selOpId}`);

/** "DE 37" for the busiest few country nodes (all of them when fewer): the rest are named by their tooltip. */
export const opNodeLabelSources = memoByModel((m: OperationsModel): NodeLabelSource[] => {
  const range = opCountRange(m);
  return [...m.nodes]
    .sort((a, b) => b.opCount - a.opCount || b.threats - a.threats || a.country.localeCompare(b.country))
    .slice(0, MAX_NODE_LABELS)
    .map(n => {
      return { id: n.country, text: `${n.country} ${n.opCount}`, position: n.position, radiusPx: opNodePx(n.opCount, range), priority: n.opCount * 1e6 + n.threats };
    });
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

/** `fade` (0..1, default 1) is the label's opacity: below 1 only near the globe's limb (see lib/projection.ts `limbFade`). */
export interface PlacedEdgeLabel { id: string; text: string; position: LngLat; angle: number; fade?: number }
export interface PlacedHostLabel { id: string; text: string; position: LngLat; radiusPx: number; fade?: number }
export interface PlacedActorLabel { id: string; text: string; position: LngLat; radiusPx: number; fade?: number }
/** `above`: the name did not fit under its node and sits over it instead. */
export interface PlacedNodeLabel { id: string; text: string; position: LngLat; radiusPx: number; fade?: number; above?: boolean }
export interface PlacedLabels {
  /** Operation country nodes ("DE 37"); absent = none. */
  opNodes?: PlacedNodeLabel[];
  edges: PlacedEdgeLabel[];
  hosts: PlacedHostLabel[];
  actors: PlacedActorLabel[];
}

export const NO_LABELS: PlacedLabels = { opNodes: [], edges: [], hosts: [], actors: [] };

/** Screen position of a point, or null when it cannot be labelled. `fade` (0..1, default 1): limb fade on the globe. */
export type Project = (p: LngLat) => { x: number; y: number; fade?: number } | null;

export interface PlaceInput {
  /** The Operations lens's busiest country nodes (placed first: a name beats a link's evidence word). */
  opNodes?: readonly NodeLabelSource[];
  edges: readonly EdgeLabelSource[];
  hosts: readonly HostLabelSource[];
  /** The Actors lens's country markers (optional: only that lens draws them). */
  actors?: readonly ActorLabelSource[];
  /** Discs the labels must clear (operation nodes, provider rings). */
  nodes: ReadonlyArray<{ position: LngLat; radiusPx: number; /** Provider id: its own label may sit against it. */ id?: string }>;
}

const CHAR_PX = 6.6; // 11px mono
const LABEL_H = 14;
/** Gap, px, between a node's bloom and its label: the same constant the layer offsets the text by. */
export const NODE_LABEL_GAP = 2;

/** Greedy screen-space placement of both label sets at the current camera. */
export function placeLensLabels(input: PlaceInput, project: Project, size: { width: number; height: number }): PlacedLabels {
  const obstacles: Obstacle[] = [];
  for (const n of input.nodes) {
    const p = project(n.position);
    if (p) obstacles.push({ x: p.x, y: p.y, r: n.radiusPx + 2, id: n.id });
  }

  // Country names first: they carry the identity of a node, the evidence words only describe a link. Below the node by
  // default; a name that does not fit below (a neighbour's bloom, an arc's label) gets one more try, above it.
  const nodeCands = (above: boolean): LabelCandidate[] => {
    const out: LabelCandidate[] = [];
    for (const n of input.opNodes ?? []) {
      const p = project(n.position);
      if (!p) continue;
      const dy = (n.radiusPx + NODE_LABEL_GAP + LABEL_H / 2) * (above ? -1 : 1);
      out.push({ id: n.id, text: n.text, x: p.x, y: p.y, dy, priority: n.priority });
    }
    return out;
  };
  const nodeById = new Map<string, NodeLabelSource>((input.opNodes ?? []).map(n => [n.id, n]));
  const nodeFade = new Map<string, number>();
  for (const n of input.opNodes ?? []) { const p = project(n.position); if (p) nodeFade.set(n.id, p.fade ?? 1); }
  const nodeOpts = { width: size.width, height: size.height, charPx: CHAR_PX, heightPx: LABEL_H, max: MAX_NODE_LABELS };
  const boxOf = (l: { position: LngLat; radiusPx: number; text: string }, above: boolean): Obstacle | null => {
    const p = project(l.position);
    return p ? { x: p.x, y: p.y + (l.radiusPx + NODE_LABEL_GAP + LABEL_H / 2) * (above ? -1 : 1), r: (l.text.length * CHAR_PX) / 2 } : null;
  };
  const placedNode = (id: string, above: boolean): PlacedNodeLabel => {
    const src = nodeById.get(id)!;
    return { id, text: src.text, position: src.position, radiusPx: src.radiusPx, fade: nodeFade.get(id) ?? 1, ...(above ? { above: true } : null) };
  };
  const below = placeLabels(nodeCands(false), { ...nodeOpts, obstacles }).map(p => placedNode(p.id, false));
  const belowBoxes = below.flatMap(l => boxOf(l, false) ?? []);
  const retry = nodeCands(true).filter(c => !below.some(l => l.id === c.id));
  const aboveLabels = retry.length === 0 ? [] : placeLabels(retry, { ...nodeOpts, max: MAX_NODE_LABELS - below.length, obstacles: obstacles.concat(belowBoxes) }).map(p => placedNode(p.id, true));
  const opNodes = [...below, ...aboveLabels].sort((x, y) => nodeById.get(y.id)!.priority - nodeById.get(x.id)!.priority);
  // ...and the edge words keep clear of the names that were placed.
  obstacles.push(...opNodes.flatMap(l => boxOf(l, !!l.above) ?? []));

  const edgeCands: LabelCandidate[] = [];
  const edgeById = new Map<string, EdgeLabelSource>();
  const edgeFade = new Map<string, number>();
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
    edgeFade.set(e.id, mid.fade ?? 1);
  }
  const edges = placeLabels(edgeCands, { width: size.width, height: size.height, charPx: CHAR_PX, heightPx: LABEL_H, max: MAX_EDGE_LABELS, obstacles })
    .map(p => {
      const src = edgeById.get(p.id)!;
      return { id: p.id, text: src.text, position: src.position, angle: p.angle, fade: edgeFade.get(p.id) ?? 1 } satisfies PlacedEdgeLabel;
    });

  const hostCands: LabelCandidate[] = [];
  const hostById = new Map<string, HostLabelSource>();
  const hostFade = new Map<string, number>();
  for (const h of input.hosts) {
    const p = project(h.position);
    if (!p) continue;
    hostFade.set(h.id, p.fade ?? 1);
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
      return { id: p.id, text: src.text, position: src.position, radiusPx: src.radiusPx, fade: hostFade.get(p.id) ?? 1 } satisfies PlacedHostLabel;
    });

  // Actor country markers: their names get the same treatment (no clipping at the edge, no collisions
  // with the edge / provider labels already placed).
  const actorCands: LabelCandidate[] = [];
  const actorById = new Map<string, ActorLabelSource>();
  const actorFade = new Map<string, number>();
  for (const a of input.actors ?? []) {
    const p = project(a.position);
    if (!p) continue;
    actorFade.set(a.id, p.fade ?? 1);
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
      return { id: p.id, text: src.text, position: src.position, radiusPx: src.radiusPx, fade: actorFade.get(p.id) ?? 1 } satisfies PlacedActorLabel;
    });

  return { opNodes, edges, hosts, actors };
}

const samePos = (a: LngLat, b: LngLat): boolean => a[0] === b[0] && a[1] === b[1];
/** A fade differing by < 5% is not visible: it must not replace the placement (and re-upload the labels). */
const sameFade = (a: number, b: number): boolean => Math.round(a * 20) === Math.round(b * 20);

/**
 * Keep the previous object when nothing visible changed, so layer `data` identity survives no-op camera moves.
 * "Visible" is everything a label draws from: id and order, text, anchor position, ring radius and (edges)
 * the screen angle to the degree. A refetch that keeps the same ids but moves a provider, renames it or
 * resizes its ring must NOT be swallowed here, or the map keeps painting the old label.
 */
export function stablePlacement(prev: PlacedLabels, next: PlacedLabels): PlacedLabels {
  const nodesSame = (prev.opNodes ?? []).length === (next.opNodes ?? []).length && (prev.opNodes ?? []).every((l, i) => {
    const n = next.opNodes![i]!;
    return l.id === n.id && l.text === n.text && l.radiusPx === n.radiusPx && !!l.above === !!n.above && samePos(l.position, n.position) && sameFade(l.fade ?? 1, n.fade ?? 1);
  });
  const edgesSame = prev.edges.length === next.edges.length && prev.edges.every((e, i) => {
    const n = next.edges[i]!;
    return e.id === n.id && e.text === n.text && samePos(e.position, n.position) && Math.round(e.angle) === Math.round(n.angle) && sameFade(e.fade ?? 1, n.fade ?? 1);
  });
  const hostsSame = prev.hosts.length === next.hosts.length && prev.hosts.every((h, i) => {
    const n = next.hosts[i]!;
    return h.id === n.id && h.text === n.text && h.radiusPx === n.radiusPx && samePos(h.position, n.position) && sameFade(h.fade ?? 1, n.fade ?? 1);
  });
  const actorsSame = prev.actors.length === next.actors.length && prev.actors.every((a, i) => {
    const n = next.actors[i]!;
    return a.id === n.id && a.text === n.text && a.radiusPx === n.radiusPx && samePos(a.position, n.position) && sameFade(a.fade ?? 1, n.fade ?? 1);
  });
  return nodesSame && edgesSame && hostsSame && actorsSame ? prev : next;
}
