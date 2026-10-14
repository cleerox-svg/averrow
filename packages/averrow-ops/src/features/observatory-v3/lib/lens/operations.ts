/**
 * Operations lens model: NEXUS operations as pulsing nodes (one per operation
 * country) joined by evidence-labelled edges.
 *
 *  - A node per (operation, country), at the country centroid (operations that
 *    share a country are spread so none is hidden).
 *  - Every node of one component (or, without a component, one operation) shares
 *    a heartbeat phase, so the eye groups them without reading labels.
 *  - Edges: within an operation, a star from its first country (the cluster
 *    spans those countries by definition); between operations, the component
 *    edges (shared cert serial / SAN / IP) carrying the ASNs they share.
 *  - Selecting an operation highlights its whole component.
 */

import type { ComponentGeo, OperationGeo } from '@/hooks/useObservatoryLenses';
import { greatCirclePath } from '../../anim/great-circle';
import { cumulativeDistances } from '../../anim/dash-flow-extension';
import { phaseForKey } from '../../anim/pulse';
import { countryCenter, groupIndexes, groupSizes, iso2, placeAround, stepFor } from './placement';
import type { LngLat } from '@/lib/country-centroids';

export interface OpNode {
  id: string;
  opId: string;
  /** Heartbeat / highlight group: the component id, else the operation id. */
  group: string;
  country: string;
  position: LngLat;
  /** 0..1 */
  confidence: number | null;
  threats: number;
  name: string;
  phase: number;
}

export interface OpEdge {
  id: string;
  group: string;
  /** Operation ids at either end (a single id for an intra-operation edge). */
  opIds: string[];
  kind: string;
  /** Full evidence text (tooltip). */
  label: string;
  /** Glyph + a word or two for the map ("◆ cert", "● IP", "▲ ASN ×3"). */
  short: string;
  path: LngLat[];
  distances: number[];
  midpoint: LngLat;
  sharedAsns: string[];
}

export interface OperationsModel {
  nodes: OpNode[];
  edges: OpEdge[];
  /** Operations (by id) with at least one placeable country. */
  placedOps: Set<string>;
  /** Country entries that couldn't be placed (no centroid). */
  unplaced: number;
  byId: Map<string, OperationGeo>;
  /** opId -> group (component or itself). */
  groupOf: Map<string, string>;
}

export const KIND_LABELS: Record<string, string> = {
  cert_serial: 'shared cert serial',
  cert_san: 'shared cert SAN',
  per_ip: 'shared IP',
  subnet: 'same subnet',
  registrar: 'same registrar',
  asn: 'same ASN',
  app_store: 'app store',
  dark_web: 'dark web',
  other: 'linked',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

/** Confidence arrives 0..100 (or 0..1): normalise to 0..1, null stays null. */
export function normalizeConfidence(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = v > 1 ? v / 100 : v;
  return Math.max(0, Math.min(1, f));
}

/** Label for an edge; an unresolved (null) kind falls back to "linked" plus whatever ASNs are shared. */
export function edgeLabel(kind: string | null, asns: readonly string[]): string {
  const base = kind === null ? 'linked' : kindLabel(kind);
  if (asns.length === 0) return base;
  const shown = asns.slice(0, 2).join(' ');
  return `${base} · ${shown}${asns.length > 2 ? ` +${asns.length - 2}` : ''}`;
}

/** Evidence glyphs: distinct shapes, all in the geometric-shapes block every mono font carries. */
const KIND_GLYPH: Record<string, string> = {
  cert_serial: '◆', cert_san: '◆', per_ip: '●', subnet: '■', registrar: '◇', asn: '▲',
};
const KIND_SHORT: Record<string, string> = {
  cert_serial: 'cert', cert_san: 'SAN', per_ip: 'IP', subnet: 'subnet', registrar: 'registrar', asn: 'ASN',
  app_store: 'app store', dark_web: 'dark web',
};

/** Short map label for an edge: "◆ cert", "● IP", "▲ ASN ×3" (×N = number of shared ASNs, shown for the ASN kind). */
export function edgeShortLabel(kind: string | null, asns: readonly string[]): string {
  const k = kind ?? 'other';
  const glyph = KIND_GLYPH[k] ?? '·';
  const word = KIND_SHORT[k] ?? (kind === null ? 'link' : kind.replace(/_/g, ' '));
  const times = k === 'asn' && asns.length > 1 ? ` ×${asns.length}` : '';
  return `${glyph} ${word}${times}`;
}

function arcPath(a: LngLat, b: LngLat): { path: LngLat[]; distances: number[]; midpoint: LngLat } {
  const path = greatCirclePath(a, b, 24);
  return { path, distances: cumulativeDistances(path), midpoint: path[Math.floor(path.length / 2)]! };
}

export function buildOperationsModel(
  operations: readonly OperationGeo[],
  components: readonly ComponentGeo[],
): OperationsModel {
  const byId = new Map<string, OperationGeo>();
  const groupOf = new Map<string, string>();
  for (const op of operations) {
    byId.set(op.id, op);
    groupOf.set(op.id, op.component_id ?? op.id);
  }

  // Stable order: biggest operations first (they claim the centre of a shared country).
  const ordered = [...operations].sort((a, b) => b.threat_count - a.threat_count || a.id.localeCompare(b.id));
  const entries: Array<{ op: OperationGeo; country: string }> = [];
  let unplaced = 0;
  for (const op of ordered) {
    const seen = new Set<string>();
    for (const raw of op.countries) {
      const cc = iso2(raw);
      if (!cc || seen.has(cc)) continue;
      seen.add(cc);
      if (!countryCenter(cc)) { unplaced++; continue; }
      entries.push({ op, country: cc });
    }
  }

  const idx = groupIndexes(entries, e => e.country);
  const sizes = groupSizes(entries, e => e.country);
  const nodes: OpNode[] = entries.map((e, i) => {
    const group = groupOf.get(e.op.id) ?? e.op.id;
    return {
      id: `${e.op.id}|${e.country}`,
      opId: e.op.id,
      group,
      country: e.country,
      position: placeAround(countryCenter(e.country)!, idx[i]!, stepFor(sizes[i]!, 1.4, 3), 3),
      confidence: normalizeConfidence(e.op.confidence_score),
      threats: e.op.threat_count,
      name: e.op.name ?? e.op.id,
      phase: phaseForKey(group),
    };
  });

  const nodesByOp = new Map<string, OpNode[]>();
  for (const n of nodes) {
    const list = nodesByOp.get(n.opId);
    if (list) list.push(n); else nodesByOp.set(n.opId, [n]);
  }

  const edges: OpEdge[] = [];
  // Intra-operation: a star from the first country.
  for (const [opId, list] of nodesByOp) {
    if (list.length < 2) continue;
    const op = byId.get(opId)!;
    const hub = list[0]!;
    for (let i = 1; i < list.length; i++) {
      const to = list[i]!;
      const g = arcPath(hub.position, to.position);
      edges.push({
        id: `${opId}:${hub.country}-${to.country}`,
        group: hub.group,
        opIds: [opId],
        kind: op.kind,
        label: edgeLabel(op.kind, op.asns),
        short: edgeShortLabel(op.kind, op.asns),
        sharedAsns: op.asns.slice(0, 20),
        ...g,
      });
    }
  }
  // Inter-operation: the component edges between returned operations.
  for (const comp of components) {
    for (const e of comp.edges) {
      const a = nodesByOp.get(e.a)?.[0];
      const b = nodesByOp.get(e.b)?.[0];
      if (!a || !b) continue;
      if (a.position[0] === b.position[0] && a.position[1] === b.position[1]) continue;
      const g = arcPath(a.position, b.position);
      edges.push({
        id: `${comp.component_id}:${e.a}-${e.b}`,
        group: comp.component_id,
        opIds: [e.a, e.b],
        kind: e.kind ?? 'other',
        label: edgeLabel(e.kind, e.shared_asns),
        short: edgeShortLabel(e.kind, e.shared_asns),
        sharedAsns: e.shared_asns,
        ...g,
      });
    }
  }

  return { nodes, edges, placedOps: new Set(nodesByOp.keys()), unplaced, byId, groupOf };
}

/** Groups to highlight for a selected operation (its whole component), or null when nothing is selected / it is unknown. */
export function highlightGroup(model: OperationsModel, selectedOpId: string | null): string | null {
  if (!selectedOpId) return null;
  return model.groupOf.get(selectedOpId) ?? null;
}

/** The operation node / edge dimming rule: everything outside the selected group fades. */
export function isDimmed(group: string, selectedGroup: string | null): boolean {
  return selectedGroup !== null && group !== selectedGroup;
}
