import { describe, it, expect } from 'vitest';
import type { OperationGeo } from '@/hooks/useObservatoryLenses';
import {
  edgeLabel, buildOperationsModel, visibleEdges, aggregateEdges, flatArc, nodeInFootprint, operationEvidence, normalizeConfidence, kindLabel,
  MAX_EDGES, TOP_OPERATIONS,
} from './operations';
import { placeAround, spreadOffset, groupIndexes, iso2 } from './placement';
import { getCountryCentroid } from '@/lib/country-centroids';

const op = (o: Partial<OperationGeo> & { id: string }): OperationGeo => ({
  name: o.id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10,
  actor: null, countries: [], asns: [], last_seen: null, last_movement_pivot_at: null, ...o,
});

describe('placement', () => {
  it('index 0 sits on the centroid; others spread deterministically and never collide', () => {
    expect(spreadOffset(0, 1)).toEqual([0, 0]);
    const c: [number, number] = [10, 50];
    const pts = [0, 1, 2, 3, 4].map(i => placeAround(c, i, 1.2));
    expect(pts[0]).toEqual(c);
    expect(new Set(pts.map(p => p.join(','))).size).toBe(5);
    expect(placeAround(c, 3, 1.2)).toEqual(pts[3]); // deterministic
  });
  it('keeps latitude inside the map and wraps longitude', () => {
    const [lng, lat] = placeAround([179.5, 79], 7, 3);
    expect(Math.abs(lat)).toBeLessThanOrEqual(80);
    expect(Math.abs(lng)).toBeLessThanOrEqual(180);
  });
  it('groupIndexes counts per group in input order', () => {
    expect(groupIndexes(['a', 'b', 'a', 'a', 'b'], x => x)).toEqual([0, 0, 1, 2, 1]);
  });
  it('iso2 normalises and rejects junk', () => {
    expect(iso2(' de ')).toBe('DE');
    expect(iso2('DEU')).toBeNull();
    expect(iso2(null)).toBeNull();
  });
});

describe('buildOperationsModel', () => {
  const ops = [
    op({ id: 'a', component_id: 'c1', countries: ['NL', 'MD', 'SC'], asns: ['AS1', 'AS2', 'AS3'], threat_count: 50 }),
    op({ id: 'b', component_id: 'c1', countries: ['NL', 'MD'], kind: 'cert_serial', threat_count: 20 }),
    op({ id: 'c', countries: ['US', 'ZZ'], threat_count: 5 }),
  ];
  const m = buildOperationsModel(ops, []);

  it('makes ONE node per country, at the centroid, counting the operations there', () => {
    const nl = m.nodes.filter(n => n.country === 'NL');
    expect(nl).toHaveLength(1);
    expect(nl[0]!.position).toEqual(getCountryCentroid('NL'));
    expect(nl[0]!.opCount).toBe(2);
    expect(nl[0]!.opIds).toEqual(['a', 'b']); // biggest first
    expect(nl[0]!.threats).toBe(70);
    expect(m.nodes.map(n => n.country).sort()).toEqual(['MD', 'NL', 'SC', 'US']);
  });
  it('drops countries without a centroid and counts them', () => {
    expect(m.nodes.some(n => n.country === 'ZZ')).toBe(false);
    expect(m.unplaced).toBe(1);
  });
  it('makes ONE arc per unordered country pair, however many operations share it', () => {
    const nlmd = m.edges.filter(e => e.id === 'MD-NL');
    expect(nlmd).toHaveLength(1);
    expect(nlmd[0]!.opCount).toBe(2);
    expect(nlmd[0]!.opIds).toEqual(['a', 'b']);
    expect(new Set(m.edges.map(e => e.id)).size).toBe(m.edges.length);
    expect(m.edges.find(e => e.id === 'MD-SC')!.opCount).toBe(1);
  });
  it('labels an arc by its lead operation\'s evidence, and says how many operations share it', () => {
    const e = m.edges.find(e => e.id === 'MD-NL')!;
    expect(e.label).toBe('same ASN · AS1 AS2 +1 · 2 operations');
    expect(e.distances).toHaveLength(e.path.length);
    expect(e.distances[0]).toBe(0);
  });
  it('the default view links only the biggest operations; a selection shows only its footprint', () => {
    expect(m.topOpIds).toEqual(['a', 'b', 'c']);
    expect(visibleEdges(m, 'b').map(e => e.id)).toEqual(['MD-NL']);
    expect(visibleEdges(m, 'b').every(e => e.opIds.includes('b'))).toBe(true);
    expect(visibleEdges(m, 'nope')).toBe(visibleEdges(m, null)); // an unknown id is no selection
  });
  it('a hovered row\'s links are previewed on top of the default view; identity is stable per input', () => {
    const many = buildOperationsModel(Array.from({ length: 8 }, (_, i) => op({ id: `o${i}`, countries: i % 2 ? ['US', 'JP'] : ['DE', 'BR'], threat_count: 100 - i })), []);
    const base = visibleEdges(many, null);
    const withPreview = visibleEdges(many, null, 'o7');
    expect(withPreview.length).toBeGreaterThanOrEqual(base.length);
    expect(withPreview.some(e => e.opIds.includes('o7'))).toBe(true);
    expect(visibleEdges(many, null, 'o7')).toBe(withPreview);
    expect(visibleEdges(many, null)).toBe(base);
  });
  it('nodes of the selected footprint stay lit, the rest dim', () => {
    const nl = m.nodeByCc.get('NL')!;
    const us = m.nodeByCc.get('US')!;
    expect(nodeInFootprint(nl, 'a')).toBe(true);
    expect(nodeInFootprint(us, 'a')).toBe(false);
    expect(nodeInFootprint(us, null)).toBe(true);
  });
  it('is empty-safe', () => {
    const e = buildOperationsModel([], []);
    expect(e.nodes).toEqual([]);
    expect(e.edges).toEqual([]);
    expect(visibleEdges(e, null)).toEqual([]);
  });
});

describe('flat arcs stay on the map, once', () => {
  it('every point is inside one world copy and below the top of the map, whatever the pair', () => {
    for (const [a, b] of [[[-170, 60], [175, 62]], [[-120, 75], [140, 70]], [[0, 0], [0, 0.5]], [[10, -50], [-60, -50]]] as Array<[[number, number], [number, number]]>) {
      for (const [lng, lat] of flatArc(a, b).path) {
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
        expect(Math.abs(lat)).toBeLessThanOrEqual(78);
      }
    }
  });
  it('the lift is a capped fraction of the length (short hops stay low, long ones do not leave the viewport)', () => {
    const lift = (a: [number, number], b: [number, number]) => Math.max(...flatArc(a, b).path.map(p => Math.abs(p[1] - (a[1] + (b[1] - a[1]) * ((p[0] - a[0]) / (b[0] - a[0] || 1))))));
    expect(lift([0, 40], [4, 40])).toBeLessThan(1);
    expect(lift([-120, 40], [140, 40])).toBeLessThanOrEqual(10.01);
  });
  it('starts and ends on the two centroids', () => {
    const { path } = flatArc([5, 52], [-74, 40]);
    expect(path[0]).toEqual([5, 52]);
    expect(path.at(-1)![0]).toBeCloseTo(-74, 9);
  });
});

describe('evidence labels (the backend\'s tier fields are optional)', () => {
  it('prefers the tier, falls back to the kind, and flags shared infrastructure', () => {
    expect(operationEvidence({ kind: 'asn' })).toBe('same ASN');
    expect(operationEvidence({ kind: 'asn', evidence_tier: 'cert' })).toBe('shared cert');
    expect(operationEvidence({ kind: 'asn', evidence_tier: 'per_ip', shared_infra: true })).toBe('shared IP · shared infrastructure');
    expect(operationEvidence({ kind: 'asn', evidence_tier: 'brand_new_tier' })).toBe('brand new tier');
    expect(operationEvidence({ kind: 'asn', evidence_tier: null, shared_infra: false })).toBe('same ASN');
  });
});

describe('a realistic day: 50 operations x ~15 countries with heavy overlap', () => {
  const HOT = ['US', 'DE', 'NL', 'GB', 'FR', 'SG', 'JP', 'AU', 'CA', 'BR', 'IN', 'RU', 'CN', 'HK', 'IE', 'SE', 'PL', 'IT', 'ES', 'ZA', 'MX', 'TR', 'KR', 'ID', 'UA'];
  const real = Array.from({ length: 50 }, (_, i) => op({
    id: `op${String(i).padStart(2, '0')}`, threat_count: 1000 - i * 13,
    kind: (['asn', 'per_ip', 'cert_serial'] as const)[i % 3],
    countries: Array.from({ length: 15 }, (_, k) => HOT[(i * 3 + k * 2 + (k % 3)) % HOT.length]!),
  }));
  const m = buildOperationsModel(real, []);

  it('one node per country (never one per operation per country)', () => {
    expect(m.nodes.length).toBeLessThanOrEqual(HOT.length);
    expect(new Set(m.nodes.map(n => n.country)).size).toBe(m.nodes.length);
    expect(m.nodes.reduce((n, x) => n + x.opCount, 0)).toBeGreaterThan(m.nodes.length * 5); // ...yet they are crowded
  });
  it('the whole model has at most MAX_EDGES arcs, one per pair, strongest first', () => {
    expect(m.edges.length).toBeLessThanOrEqual(MAX_EDGES);
    expect(new Set(m.edges.map(e => e.id)).size).toBe(m.edges.length);
    for (let i = 1; i < m.edges.length; i++) expect(m.edges[i - 1]!.opCount).toBeGreaterThanOrEqual(m.edges[i]!.opCount);
  });
  it('the default view draws only the top operations\' links: a handful of arcs, not hundreds', () => {
    const shown = visibleEdges(m, null);
    expect(m.topOpIds).toHaveLength(TOP_OPERATIONS);
    expect(shown.length).toBeLessThanOrEqual(TOP_OPERATIONS * 14);
    expect(shown.length).toBeLessThanOrEqual(MAX_EDGES);
    expect(shown.every(e => e.opIds.some(id => m.topOpIds.includes(id)))).toBe(true);
  });
  it('a selection is that operation\'s footprint alone (<= its country count - 1 arcs)', () => {
    const shown = visibleEdges(m, 'op17');
    expect(shown.length).toBeLessThanOrEqual(new Set(real[17]!.countries).size - 1);
    expect(shown.every(e => e.opIds.includes('op17'))).toBe(true);
  });
  it('no arc is drawn twice: no duplicate pair, every path inside one world copy', () => {
    const all = aggregateEdges(m, [...m.countriesOf.keys()]);
    expect(new Set(all.map(e => `${e.a}-${e.b}`)).size).toBe(all.length);
    for (const e of all) for (const [lng, lat] of e.path) {
      expect(lng).toBeGreaterThanOrEqual(-180); expect(lng).toBeLessThanOrEqual(180); expect(Math.abs(lat)).toBeLessThanOrEqual(78);
    }
  });
  it('arc width / alpha inputs: busy pairs carry more operations than quiet ones', () => {
    expect(m.edges[0]!.opCount).toBeGreaterThan(5); // the overlap collapses into few, heavy arcs
    expect(m.edges[0]!.opCount).toBeGreaterThan(m.edges.at(-1)!.opCount);
  });
});

describe('edges with an unresolved kind', () => {
  it('label falls back to "linked" (+ shared ASNs) and the model still builds', () => {
    expect(edgeLabel(null, [])).toBe('linked');
    expect(edgeLabel(null, ['AS9'])).toBe('linked · AS9');
    const m = buildOperationsModel([op({ id: 'a', countries: ['NL'] }), op({ id: 'b', countries: ['US'] })], []);
    expect(m.edges).toEqual([]); // single-country operations have nothing to link
  });
});

describe('helpers', () => {
  it('normalises confidence from 0..100 or 0..1', () => {
    expect(normalizeConfidence(80)).toBe(0.8);
    expect(normalizeConfidence(0.4)).toBe(0.4);
    expect(normalizeConfidence(null)).toBeNull();
    expect(normalizeConfidence(250)).toBe(1);
  });
  it('labels known and unknown kinds', () => {
    expect(kindLabel('cert_serial')).toBe('shared cert serial');
    expect(kindLabel('some_new_kind')).toBe('some new kind');
  });
});
