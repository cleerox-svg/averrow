import { describe, it, expect } from 'vitest';
import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import type { OperationGeo, ProviderGeo, CampaignGeo } from '@/hooks/useObservatoryLenses';
import { buildSearchIndex, runSearch, searchPatch, normAsn } from './search';
import { lensPreset, noLayers } from './lenses';

const node: ThreatPoint = { lat: 52, lng: 5, threat_count: 40, top_severity: 'high', critical: 0, high: 40, medium: 0, low: 0, country_code: 'NL', top_threat_type: 'phishing' };
const arc = (brand: string, volume: number): ArcData => ({ sourcePosition: [5, 52], targetPosition: [-100, 40], threat_type: 'phishing', severity: 'high', source_region: 'NL', target_brand: brand.toLowerCase(), brand_name: brand, volume });
const op: OperationGeo = { id: 'op-7f3a', name: 'Op 7F3A', component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 9, actor: { id: 'a1', name: 'Lazarus Group' }, countries: ['NL', 'MD'], asns: ['AS64512', 'AS64999'], last_seen: null, last_movement_pivot_at: null };
const prov: ProviderGeo = { id: 'p1', name: 'Example Hosting', asn: 'AS64512', country: 'NL', active_threat_count: 5, total_threat_count: 9, trend_7d: 1, trend_30d: 3, is_bulletproof: false, reputation_score: null, takedown: null };
const camp: CampaignGeo = { id: 'c1', name: 'Operation Blue Sky', slug: 'c1', status: 'active', conflict: 'Ukraine', adversary_countries: [], target_countries: [], threat_actors: [], start_date: null, curated: true };

const index = buildSearchIndex({
  threats: [node], arcs: [arc('PayPal', 10), arc('PayPal', 30), arc('Paylocity', 3)], operations: [op], providers: [prov],
  actors: [{ id: 'a1', name: 'Lazarus Group', cluster_count: 3, infra_count: 12 }], campaigns: [camp],
});
const top = (q: string) => runSearch(index, q)[0];

describe('runSearch', () => {
  it('needs at least two characters', () => {
    expect(runSearch(index, 'n')).toEqual([]);
    expect(runSearch(index, '  ')).toEqual([]);
  });
  it('finds countries by name or code, with the loaded count', () => {
    expect(top('netherlands')).toMatchObject({ kind: 'country', label: 'Netherlands' });
    expect(top('netherlands').sublabel).toBe('NL · 40 threats');
    expect(top('nl').target).toEqual({ kind: 'country', code: 'NL' });
  });
  it('finds a brand and targets its biggest corridor', () => {
    const r = top('paypal');
    expect(r.kind).toBe('brand');
    expect(r.sublabel).toBe('40 threats targeted');
    expect(r.target).toMatchObject({ kind: 'arc', arc: { volume: 30 } });
  });
  it('finds an ASN with or without the AS prefix; a provider ASN lands on the provider, an operation-only ASN on the operation', () => {
    expect(top('as64512')).toMatchObject({ kind: 'asn', target: { kind: 'provider' } });
    expect(top('64512')).toMatchObject({ kind: 'asn' });
    expect(top('AS64999').target).toMatchObject({ kind: 'operation', id: 'op-7f3a' });
  });
  it('finds operations by name, id or actor, and actors / campaigns / providers by name', () => {
    expect(top('7f3a')).toMatchObject({ kind: 'operation' });
    expect(top('lazarus').kind).toBe('actor'); // actor outranks the operation that merely mentions it
    expect(top('blue sky')).toMatchObject({ kind: 'campaign' });
    expect(top('example host')).toMatchObject({ kind: 'provider' });
    expect(top('ukraine').kind).toBe('country'); // name match outranks a campaign's secondary field
  });
  it('ranks exact > prefix > word-prefix > substring and caps the list', () => {
    const idx = buildSearchIndex({ actors: [
      { id: '1', name: 'Fancy Bear', cluster_count: 0, infra_count: 0 },
      { id: '2', name: 'Bear', cluster_count: 0, infra_count: 0 },
      { id: '3', name: 'Bearing', cluster_count: 0, infra_count: 0 },
      { id: '4', name: 'Unbearable', cluster_count: 0, infra_count: 0 },
    ] });
    expect(runSearch(idx, 'bear').filter(r => r.kind === 'actor').map(r => r.label)).toEqual(['Bear', 'Bearing', 'Fancy Bear', 'Unbearable']);
    expect(runSearch(index, 'an', 3).length).toBeLessThanOrEqual(3);
  });
  it('is case-insensitive and empty-data safe', () => {
    expect(top('PAYPAL').kind).toBe('brand');
    expect(runSearch(buildSearchIndex({}), 'zz').every(r => r.kind === 'country')).toBe(true);
  });
});

describe('normAsn', () => {
  it('normalises', () => {
    expect(normAsn('as 15169')).toBe('AS15169');
    expect(normAsn('15169')).toBe('AS15169');
    expect(normAsn('nope')).toBeNull();
    expect(normAsn(null)).toBeNull();
  });
});

describe('searchPatch', () => {
  const threats = lensPreset('threats');
  it('switches to the lens a result lives on, selecting it', () => {
    expect(searchPatch(top('7f3a'), threats)).toMatchObject({ lens: 'operations', sel: 'op:op-7f3a', mode: 'global' });
    expect(searchPatch(top('example host'), threats)).toMatchObject({ lens: 'hosting', sel: 'provider:p1' });
    expect(searchPatch(top('lazarus'), threats)).toMatchObject({ lens: 'actors', sel: 'actor:a1' });
    expect(searchPatch(top('blue sky'), threats)).toMatchObject({ lens: 'campaigns', sel: 'campaign:c1' });
  });
  it('stays on the current lens when the layer is already on', () => {
    const withOps = { ...threats, operations: true };
    expect(searchPatch(top('7f3a'), withOps).lens).toBeUndefined();
  });
  it('an operation-resolved ASN uses the Operations layer, not Hosting', () => {
    expect(searchPatch(top('AS64999'), threats).lens).toBe('operations');
  });
  it('countries select on any lens; brands need an arc-bearing lens', () => {
    expect(searchPatch(top('netherlands'), lensPreset('hosting'))).toMatchObject({ sel: 'country:NL' });
    expect(searchPatch(top('netherlands'), lensPreset('hosting')).lens).toBeUndefined();
    expect(searchPatch(top('paypal'), lensPreset('hosting'))).toMatchObject({ lens: 'threats' });
    expect(searchPatch(top('paypal'), threats).lens).toBeUndefined();
    expect(searchPatch(top('paypal'), noLayers()).lens).toBe('threats');
  });
});
