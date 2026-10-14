import { describe, it, expect } from 'vitest';
import type { OperationGeo, ComponentGeo } from '@/hooks/useObservatoryLenses';
import { edgeLabel, buildOperationsModel, highlightGroup, isDimmed, normalizeConfidence, kindLabel } from './operations';
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
    op({ id: 'b', component_id: 'c1', countries: ['NL'], kind: 'cert_serial', threat_count: 20 }),
    op({ id: 'c', countries: ['US', 'ZZ'], threat_count: 5 }),
  ];
  const comps: ComponentGeo[] = [{
    component_id: 'c1', operation_ids: ['a', 'b'], countries: ['NL', 'MD', 'SC'],
    edges: [{ a: 'a', b: 'b', kind: 'cert_serial', shared_asns: ['AS9'] }],
  }];
  const m = buildOperationsModel(ops, comps);

  it('makes one node per operation country at the centroid, spreading operations that share a country', () => {
    const nl = m.nodes.filter(n => n.country === 'NL');
    expect(nl).toHaveLength(2);
    expect(nl[0].position).toEqual(getCountryCentroid('NL'));
    expect(nl[1].position).not.toEqual(nl[0].position);
    expect(m.nodes.filter(n => n.opId === 'a')).toHaveLength(3);
  });
  it('drops countries without a centroid and counts them', () => {
    expect(m.nodes.some(n => n.country === 'ZZ')).toBe(false);
    expect(m.unplaced).toBe(1);
  });
  it('nodes of one component share a heartbeat phase; others differ', () => {
    const phases = new Map(m.nodes.map(n => [n.opId, n.phase]));
    expect(phases.get('a')).toBe(phases.get('b'));
    expect(phases.get('c')).not.toBe(phases.get('a'));
  });
  it('builds a star within an operation labelled by kind + ASNs, and component edges labelled by shared evidence', () => {
    const intra = m.edges.filter(e => e.opIds.length === 1);
    expect(intra).toHaveLength(2); // NL hub -> MD, SC
    expect(intra[0].label).toBe('same ASN · AS1 AS2 +1');
    const inter = m.edges.find(e => e.opIds.length === 2)!;
    expect(inter.label).toBe('shared cert serial · AS9');
    expect(inter.distances).toHaveLength(inter.path.length);
    expect(inter.distances[0]).toBe(0);
  });
  it('highlights the whole component of a selected operation and dims the rest', () => {
    const g = highlightGroup(m, 'b');
    expect(g).toBe('c1');
    expect(isDimmed('c1', g)).toBe(false);
    expect(isDimmed('c', g)).toBe(true);
    expect(isDimmed('c', null)).toBe(false);
    expect(highlightGroup(m, 'nope')).toBeNull();
  });
  it('is empty-safe', () => {
    const e = buildOperationsModel([], []);
    expect(e.nodes).toEqual([]);
    expect(e.edges).toEqual([]);
  });
});

describe('edges with an unresolved kind', () => {
  it('label falls back to "linked" (+ shared ASNs) and the model still builds', () => {
    expect(edgeLabel(null, [])).toBe('linked');
    expect(edgeLabel(null, ['AS9'])).toBe('linked · AS9');
    const m = buildOperationsModel(
      [op({ id: 'a', component_id: 'c', countries: ['NL'] }), op({ id: 'b', component_id: 'c', countries: ['US'] })],
      [{ component_id: 'c', operation_ids: ['a', 'b'], countries: ['NL', 'US'], edges: [{ a: 'a', b: 'b', kind: null, shared_asns: ['AS9'] }] }],
    );
    expect(m.edges[0]).toMatchObject({ label: 'linked · AS9', kind: 'other' });
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
