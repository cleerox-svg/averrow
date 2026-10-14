import { describe, it, expect } from 'vitest';
import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import type { OperationGeo, ProviderGeo, Movement, CampaignGeo } from '@/hooks/useObservatoryLenses';
import {
  resolveDrill, drillToPatch, drillKey, drillTitle, isPending, countryFacts, selPatch, type DrillData,
} from './drill';
import { nodeKey, arcKey } from './url-state';
import { getCountryCentroid } from '@/lib/country-centroids';

const node: ThreatPoint = { lat: 51.5, lng: 0.1, threat_count: 5, top_severity: 'high', critical: 1, high: 2, medium: 1, low: 1, country_code: 'GB', top_threat_type: 'phishing' };
const node2: ThreatPoint = { ...node, lat: 52, lng: -1, threat_count: 3, critical: 0, high: 0, medium: 0, low: 3, top_threat_type: 'c2' };
const arc: ArcData = { sourcePosition: [10, 20], targetPosition: [-100, 40], threat_type: 'c2', severity: 'high', source_region: 'GB', target_brand: 'b1', brand_name: 'Acme', volume: 7 };
const op: OperationGeo = { id: 'op1', name: 'Op One', component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 9, actor: null, countries: ['GB', 'NL'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null };
const prov: ProviderGeo = { id: 'p1', name: 'Host', asn: 'AS1', country: 'GB', active_threat_count: 50, total_threat_count: 90, trend_7d: 1, trend_30d: 2, is_bulletproof: false, reputation_score: null, takedown: null };
const camp: CampaignGeo = { id: 'c1', name: 'Camp', slug: 'c1', status: 'active', conflict: null, adversary_countries: ['RU'], target_countries: ['UA'], threat_actors: [], start_date: null, curated: true };
const move: Movement = { id: 'm1', kind: 'infra_movement', cluster_id: 'c', cluster_name: 'Cl', at: '2026-10-13T00:00:00Z', from: { asns: [], countries: ['MD'] }, to: { asns: [], countries: ['NL'] }, counts: { new_asns: 1, new_ips: 0, new_serials: 0 }, payload_v: 2 };
const none = { node: null, arc: null, sel: null };

describe('resolveDrill', () => {
  const data: DrillData = { threats: [node], arcs: [arc], operations: [op], providers: [prov], campaigns: [camp], movements: [move] };
  it('resolves node and arc keys', () => {
    expect(resolveDrill({ ...none, node: nodeKey(node) }, data)).toEqual({ kind: 'node', node });
    expect(resolveDrill({ ...none, arc: arcKey(arc) }, data)).toEqual({ kind: 'arc', arc });
    expect(resolveDrill({ ...none, node: '1.00,2.00' }, data)).toBeNull();
  });
  it('resolves every sel kind against loaded data', () => {
    expect(resolveDrill({ ...none, sel: 'country:GB' }, data)).toEqual({ kind: 'country', code: 'GB' });
    expect(resolveDrill({ ...none, sel: 'op:op1' }, data)).toMatchObject({ kind: 'operation', op });
    expect(resolveDrill({ ...none, sel: 'provider:p1' }, data)).toMatchObject({ kind: 'provider', provider: prov });
    expect(resolveDrill({ ...none, sel: 'campaign:c1' }, data)).toMatchObject({ kind: 'campaign', campaign: camp });
    expect(resolveDrill({ ...none, sel: 'move:m1' }, data)).toMatchObject({ kind: 'movement', movement: move });
    expect(resolveDrill({ ...none, sel: 'actor:a1' }, { actors: [{ id: 'a1', name: 'APT', cluster_count: 1, infra_count: 1 }] })).toEqual({ kind: 'actor', id: 'a1', name: 'APT' });
  });
  it('an unloaded query yields a pending target; a loaded query without the object yields null', () => {
    const pending = resolveDrill({ ...none, sel: 'op:op1' }, {});
    expect(pending).toMatchObject({ kind: 'operation', op: null });
    expect(isPending(pending!)).toBe(true);
    expect(resolveDrill({ ...none, sel: 'op:gone' }, { operations: [op] })).toBeNull();
    expect(isPending(resolveDrill({ ...none, sel: 'op:op1' }, data)!)).toBe(false);
  });
  it('garbage or empty selections resolve to null', () => {
    expect(resolveDrill(none, data)).toBeNull();
    expect(resolveDrill({ ...none, sel: 'wat:1' }, data)).toBeNull();
  });
});

describe('drillToPatch / keys / titles', () => {
  it('round-trips through resolveDrill for every kind', () => {
    const data: DrillData = { threats: [node], arcs: [arc], operations: [op], providers: [prov], campaigns: [camp], movements: [move] };
    const targets = [
      { kind: 'node', node }, { kind: 'arc', arc }, { kind: 'country', code: 'GB' },
      { kind: 'operation', id: 'op1', op }, { kind: 'provider', id: 'p1', provider: prov },
      { kind: 'campaign', id: 'c1', campaign: camp }, { kind: 'movement', id: 'm1', movement: move },
    ] as const;
    for (const t of targets) {
      const patch = drillToPatch(t);
      const back = resolveDrill({ node: patch.node ?? null, arc: patch.arc ?? null, sel: patch.sel ?? null }, data)!;
      expect(drillKey(back)).toBe(drillKey(t));
    }
  });
  it('null clears everything; selPatch builds sel', () => {
    expect(drillToPatch(null)).toEqual(none);
    expect(selPatch('op', 'x')).toEqual({ node: null, arc: null, sel: 'op:x' });
  });
  it('titles read well', () => {
    expect(drillTitle({ kind: 'country', code: 'DE' })).toBe('Germany');
    expect(drillTitle({ kind: 'node', node: { ...node, threat_count: 1 } })).toBe('1 threat');
    expect(drillTitle({ kind: 'operation', id: 'zz', op: null })).toBe('Operation zz');
  });
});

describe('countryFacts', () => {
  const facts = countryFacts('gb', {
    threats: [node, node2, { ...node, country_code: 'US', threat_count: 100 }],
    arcs: [arc, { ...arc, brand_name: 'Beta', volume: 20 }, { ...arc, source_region: 'US', brand_name: 'Zed', volume: 99 }],
    operations: [op, { ...op, id: 'op2', countries: ['US'] }],
    providers: [prov, { ...prov, id: 'p2', country: 'US' }],
    overindex: [{ country_code: 'GB', our_count: 8, our_share: 0.1, radar_share: 0.05, ratio: 2 }],
  });
  it('aggregates only this country', () => {
    expect(facts.name).toBe('United Kingdom');
    expect(facts.threats).toBe(8);
    expect(facts.severity).toEqual({ critical: 1, high: 2, medium: 1, low: 4 });
    expect(facts.topTypes[0]).toEqual({ type: 'phishing', count: 5 });
    expect(facts.brands.map(b => b.name)).toEqual(['Beta', 'Acme']);
    expect(facts.operations.map(o => o.id)).toEqual(['op1']);
    expect(facts.providers.map(p => p.id)).toEqual(['p1']);
    expect(facts.overindex?.ratio).toBe(2);
  });
  it('reports unknowns as null / empty rather than zero when data is not loaded', () => {
    const f = countryFacts('GB', {});
    expect(f.threats).toBeNull();
    expect(f.severity).toBeNull();
    expect(f.operations).toEqual([]);
    expect(f.overindex).toBeNull();
  });
});
