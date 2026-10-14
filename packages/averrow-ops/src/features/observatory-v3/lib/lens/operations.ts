/**
 * Operations lens model: NEXUS operations as ONE node per country, joined by ONE arc per country pair.
 *
 * With real data (50 operations x ~15 countries, heavy overlap on US / DE / NL / GB ...) a node or an arc per
 * (operation, country) is thousands of overlapping marks: ropes of dashed arcs and solid blobs. So:
 *  - a node per COUNTRY at its centroid, sized by how many operations are there (the drawer lists them);
 *  - operations keep the server's ranking (evidence tier, then threat count): the client never re-ranks by size alone;
 *  - an arc per unordered country PAIR, its width / opacity by how many operations share it; an operation
 *    contributes a star from the busiest country it spans (ties: most threats, then country code) (it spans those countries by definition);
 *  - the default view draws links only for the few biggest operations; selecting one draws its whole footprint
 *    and dims everything else; hovering a panel row previews its links; never more than MAX_EDGES arcs;
 *  - flat arcs are drawn once, inside the primary world copy, with a lift capped by their length (they stay on
 *    the map); the globe draws the lifted great circle (layers/lens-layers.ts).
 */

import type { ComponentGeo, OperationGeo } from '@/hooks/useObservatoryLenses';
import { cumulativeDistances } from '../../anim/dash-flow-extension';
import { phaseForKey } from '../../anim/pulse';
import { countryCenter, iso2 } from './placement';
import type { LngLat } from '@/lib/country-centroids';

/** Links are drawn for this many biggest operations unless one is selected. */
export const TOP_OPERATIONS = 5;
/** Hard cap on arcs drawn at once (degrades by dropping the weakest pairs). */
export const MAX_EDGES = 150;

export interface OpNode {
  /** The country code. */
  id: string;
  country: string;
  position: LngLat;
  /** Operations present (ids, biggest first). */
  opIds: string[];
  opCount: number;
  threats: number;
  /** 0..1, the best-evidenced operation here. */
  confidence: number | null;
  name: string;
  phase: number;
}

export interface OpEdge {
  /** `AA-BB` (country codes, sorted). */
  id: string;
  a: string;
  b: string;
  /** Operations sharing this pair (ids, biggest first). */
  opIds: string[];
  opCount: number;
  threats: number;
  kind: string;
  /** Full evidence text (tooltip). */
  label: string;
  /** Glyph + a word or two for the map ("◆ cert", "● IP", "▲ 3 ASNs"). */
  short: string;
  /** Flat-map path: inside [-180, 180], one world copy, lift capped by length. */
  path: LngLat[];
  distances: number[];
  midpoint: LngLat;
  sharedAsns: string[];
}

export interface OperationsModel {
  /** One per country. */
  nodes: OpNode[];
  nodeByCc: Map<string, OpNode>;
  /** Operations (by id) with at least one placeable country. */
  placedOps: Set<string>;
  /** Country entries that couldn't be placed (no centroid). */
  unplaced: number;
  byId: Map<string, OperationGeo>;
  /** opId -> group (component or itself). */
  groupOf: Map<string, string>;
  /** opId -> its placeable countries, in the order the server gave them. */
  countriesOf: Map<string, string[]>;
  /** The biggest operations, whose links the default view draws. */
  topOpIds: string[];
}

export const KIND_LABELS: Record<string, string> = {
  cert: 'shared cert',
  cert_serial: 'shared cert serial',
  cert_san: 'shared cert SAN',
  per_ip: 'shared IP',
  ip: 'shared IP',
  subnet: 'same subnet',
  registrar: 'same registrar',
  asn: 'same ASN',
  app_store: 'app store',
  dark_web: 'dark web',
  residue: 'weak evidence',
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

/**
 * Label for an edge; an unresolved (null) kind falls back to "linked". The shared ASNs are listed only when the
 * evidence IS the ASN (a cert or IP link has ASNs too, but they are not why the countries are joined).
 */
export function edgeLabel(kind: string | null, asns: readonly string[]): string {
  const base = kind === null ? 'linked' : kindLabel(kind);
  if (kind !== 'asn' || asns.length === 0) return base;
  const shown = asns.slice(0, 2).join(' ');
  return `${base} · ${shown}${asns.length > 2 ? ` +${asns.length - 2}` : ''}`;
}

/** Evidence glyphs: distinct shapes, all in the geometric-shapes block every mono font carries. */
const KIND_GLYPH: Record<string, string> = {
  cert: '◆', cert_serial: '◆', cert_san: '◆', per_ip: '●', ip: '●', subnet: '■', registrar: '◇', asn: '▲',
};
const KIND_SHORT: Record<string, string> = {
  cert: 'cert', cert_serial: 'cert', cert_san: 'SAN', per_ip: 'IP', ip: 'IP', subnet: 'subnet', registrar: 'registrar', asn: 'ASN',
  app_store: 'app store', dark_web: 'dark web', residue: 'weak',
};

/** Short map label for an edge: "◆ cert", "● IP", "▲ 3 ASNs" (×N = number of shared ASNs, shown for the ASN kind). */
export function edgeShortLabel(kind: string | null, asns: readonly string[]): string {
  const k = kind ?? 'other';
  const glyph = KIND_GLYPH[k] ?? '·';
  if (k === 'asn' && asns.length > 1) return `${glyph} ${asns.length} ASNs`;
  const word = KIND_SHORT[k] ?? (kind === null ? 'link' : kind.replace(/_/g, ' '));
  return `${glyph} ${word}`;
}

/**
 * A flat-map arc between two centroids: one polyline inside the primary world copy (no wrapping across the
 * antimeridian, so it is never drawn twice), bowed toward the nearer pole by a lift that is a fraction of its
 * length and capped, and kept below the map's top edge.
 */
export function flatArc(a: LngLat, b: LngLat, segments = 20): { path: LngLat[]; distances: number[]; midpoint: LngLat } {
  const dLng = b[0] - a[0];
  const dLat = b[1] - a[1];
  const len = Math.hypot(dLng, dLat);
  const lift = Math.min(10, len * 0.14);
  const dir = (a[1] + b[1]) / 2 >= 0 ? 1 : -1;
  const path: LngLat[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const lat = a[1] + dLat * t + dir * lift * 4 * t * (1 - t);
    path.push([a[0] + dLng * t, Math.max(-78, Math.min(78, lat))]);
  }
  return { path, distances: cumulativeDistances(path), midpoint: path[Math.floor(segments / 2)]! };
}

const asEvidence = (o: OperationGeo): string => o.evidence_tier ?? o.kind;

/** The server's evidence ranking (worker EVIDENCE_TIER_RANK): strongest evidence first. Unknown tiers rank last. */
const TIER_RANK: Record<string, number> = {
  cert: 0, cert_serial: 0, cert_san: 0, ip: 1, per_ip: 1, subnet: 2, registrar: 3, asn: 4, residue: 5,
};
export const tierRank = (o: Pick<OperationGeo, 'evidence_tier' | 'kind'>): number => TIER_RANK[o.evidence_tier ?? o.kind] ?? 6;

/** The server's operation order: evidence tier, then threat count (largest first), then id. Without tiers: threats, id. */
export function compareOperations(a: OperationGeo, b: OperationGeo): number {
  const t = a.evidence_tier != null && b.evidence_tier != null ? tierRank(a) - tierRank(b) : 0;
  return t || b.threat_count - a.threat_count || a.id.localeCompare(b.id);
}

/** One operation's evidence label for the panel / drawer: its tier when the server sends one, else its kind. */
export function operationEvidence(o: Pick<OperationGeo, 'evidence_tier' | 'kind' | 'shared_infra'>): string {
  const base = kindLabel(o.evidence_tier ?? o.kind);
  return o.shared_infra ? `${base} · shared infrastructure` : base;
}

type Pair = { a: string; b: string; ops: Map<string, OperationGeo> };

/** Aggregate the stars of `opIds` into one edge per country pair, strongest first, at most MAX_EDGES. */
export function aggregateEdges(m: OperationsModel, opIds: readonly string[]): OpEdge[] {
  const pairs = new Map<string, Pair>();
  for (const id of opIds) {
    const op = m.byId.get(id);
    const list = m.countriesOf.get(id);
    if (!op || !list || list.length < 2) continue;
    // The star's centre is the busiest country the operation spans, so operations that overlap share their arcs.
    const hub = list.reduce((best, cc) => {
      const n = m.nodeByCc.get(cc)!;
      const b = m.nodeByCc.get(best)!;
      return n.opCount > b.opCount || (n.opCount === b.opCount && (n.threats > b.threats || (n.threats === b.threats && cc < best))) ? cc : best;
    });
    for (const other of list) {
      if (other === hub) continue;
      const [a, b] = hub < other ? [hub, other] : [other, hub];
      const key = `${a}-${b}`;
      let p = pairs.get(key);
      if (!p) { p = { a, b, ops: new Map() }; pairs.set(key, p); }
      p.ops.set(id, op);
    }
  }
  const out: OpEdge[] = [];
  for (const [key, p] of pairs) {
    const ops = [...p.ops.values()].sort(compareOperations);
    const lead = ops[0]!;
    const na = m.nodeByCc.get(p.a)!;
    const nb = m.nodeByCc.get(p.b)!;
    if (na.position[0] === nb.position[0] && na.position[1] === nb.position[1]) continue;
    const kind = asEvidence(lead);
    const g = flatArc(na.position, nb.position);
    out.push({
      id: key, a: p.a, b: p.b,
      opIds: ops.map(o => o.id), opCount: ops.length,
      threats: ops.reduce((n, o) => n + o.threat_count, 0),
      kind,
      label: edgeLabel(kind, lead.asns) + (ops.length > 1 ? ` · ${ops.length} operations` : ''),
      short: edgeShortLabel(kind, lead.asns),
      sharedAsns: kind === 'asn' ? lead.asns.slice(0, 20) : [],
      ...g,
    });
  }
  out.sort((x, y) => y.opCount - x.opCount || y.threats - x.threats || x.id.localeCompare(y.id));
  return out.length > MAX_EDGES ? out.slice(0, MAX_EDGES) : out;
}

export function buildOperationsModel(
  operations: readonly OperationGeo[],
  _components: readonly ComponentGeo[] = [],
): OperationsModel {
  const byId = new Map<string, OperationGeo>();
  const groupOf = new Map<string, string>();
  for (const op of operations) {
    byId.set(op.id, op);
    groupOf.set(op.id, op.component_id ?? op.id);
  }

  const ordered = [...operations].sort(compareOperations);
  const countriesOf = new Map<string, string[]>();
  const perCountry = new Map<string, OperationGeo[]>();
  let unplaced = 0;
  for (const op of ordered) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of op.countries) {
      const cc = iso2(raw);
      if (!cc || seen.has(cc)) continue;
      seen.add(cc);
      if (!countryCenter(cc)) { unplaced++; continue; }
      list.push(cc);
      const there = perCountry.get(cc);
      if (there) there.push(op); else perCountry.set(cc, [op]);
    }
    if (list.length > 0) countriesOf.set(op.id, list);
  }

  const nodes: OpNode[] = [...perCountry.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cc, ops]) => {
      const confs = ops.map(o => normalizeConfidence(o.confidence_score)).filter((c): c is number => c !== null);
      return {
        id: cc, country: cc, position: countryCenter(cc)!,
        opIds: ops.map(o => o.id), opCount: ops.length,
        threats: ops.reduce((n, o) => n + o.threat_count, 0),
        confidence: confs.length > 0 ? Math.max(...confs) : null,
        name: ops.length === 1 ? (ops[0]!.name ?? ops[0]!.id) : `${ops.length} operations`,
        phase: phaseForKey(cc),
      };
    });
  const nodeByCc = new Map(nodes.map(n => [n.country, n]));

  const model: OperationsModel = {
    nodes, nodeByCc, placedOps: new Set(countriesOf.keys()), unplaced, byId, groupOf, countriesOf,
    topOpIds: ordered.filter(o => countriesOf.has(o.id)).slice(0, TOP_OPERATIONS).map(o => o.id),
  };
  return model;
}

/** Operations whose links the default view draws (the top ones that span two or more placeable countries). */
export function linkedOperationIds(m: OperationsModel): Set<string> {
  return new Set(m.topOpIds.filter(id => (m.countriesOf.get(id)?.length ?? 0) >= 2));
}

const visibleCache = new WeakMap<OperationsModel, Map<string, OpEdge[]>>();

/**
 * The arcs to draw: the selected operation's full footprint, else the top operations' links; a hovered panel
 * row's links are added as a preview. Memoised per (model, selection, preview) so data identity is stable.
 */
export function visibleEdges(m: OperationsModel, selectedOpId: string | null, previewOpId: string | null = null): OpEdge[] {
  const sel = selectedOpId && m.countriesOf.has(selectedOpId) ? selectedOpId : null;
  const base = sel ? [sel] : m.topOpIds;
  const ids = previewOpId && m.countriesOf.has(previewOpId) && !base.includes(previewOpId) ? [...base, previewOpId] : base;
  const key = ids.join('|');
  let inner = visibleCache.get(m);
  if (!inner) { inner = new Map(); visibleCache.set(m, inner); }
  let hit = inner.get(key);
  if (!hit) {
    if (inner.size >= 8) inner.delete(inner.keys().next().value as string);
    hit = aggregateEdges(m, ids);
    inner.set(key, hit);
  }
  return hit;
}

/** Whether a node belongs to the selected operation's footprint (everything else dims). */
export function nodeInFootprint(n: OpNode, selectedOpId: string | null): boolean {
  return selectedOpId === null || n.opIds.includes(selectedOpId);
}
