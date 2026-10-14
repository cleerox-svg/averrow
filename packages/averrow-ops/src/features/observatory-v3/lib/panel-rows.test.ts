import { describe, it, expect } from 'vitest';
import type { OperationGeo, ProviderGeo, CampaignGeo, Movement, ActorListItem, OverindexRow } from '@/hooks/useObservatoryLenses';
import {
  hostingRows, operationRows, baselineRows, campaignRows, movementRows, actorRows, velocityRows, takedownCountryRows, takedownProviderRows, PANEL_ROWS, MIN_RANKED_COUNT,
} from './panel-rows';
import { buildTakedownCountryModel, buildTakedownProviderModel, TAKEDOWN_MIN_RESOLVED } from './lens/takedowns';
import { buildHostingModel } from './lens/hosting';
import type { TakedownGeoRow } from '@/hooks/useObservatoryLenses';
import { buildVelocityModel } from './lens/velocity';

const prov = (id: string, active: number, over: Partial<ProviderGeo> = {}): ProviderGeo => ({
  id, name: `Host ${id}`, asn: 'AS1', country: 'NL', active_threat_count: active, total_threat_count: active, trend_7d: 0, trend_30d: 0,
  is_bulletproof: false, reputation_score: null, takedown: null, ...over,
});

describe('lens-aware panel rows', () => {
  it('Hosting: top providers by active threats, capped, with a rising/falling mark', () => {
    const s = hostingRows([prov('a', 5), prov('b', 50, { trend_7d: 30, trend_30d: 30 }), prov('z', 0), ...Array.from({ length: 20 }, (_, i) => prov(`x${i}`, 1 + i))]);
    expect(s.rows[0]).toMatchObject({ key: 'b', tone: 'rising' });
    expect(s.rows[0]!.trailing).toBe('50 ↑');
    expect(s.rows).toHaveLength(PANEL_ROWS);
    expect(s.rows.some(r => r.key === 'z')).toBe(false); // nothing active
    expect(s.rows[0]!.target).toMatchObject({ kind: 'provider', id: 'b' });
  });
  it('Operations: biggest first, with country count and confidence', () => {
    const op = (id: string, n: number): OperationGeo => ({ id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: n, actor: { id: 'a', name: 'APT' }, countries: ['NL', 'DE'], asns: [], last_seen: null, last_movement_pivot_at: null });
    const s = operationRows([op('small', 1), op('big', 99)]);
    expect(s.rows.map(r => r.key)).toEqual(['big', 'small']);
    expect(s.rows[0]!.secondary).toBe('2 countries · 80% conf · APT');
    expect(operationRows(undefined).rows).toEqual([]);
  });
  it('Baseline over-index: most over-indexed first, ignoring tiny samples and countries without a baseline', () => {
    const rows: OverindexRow[] = [
      { country_code: 'US', our_count: 100, our_share: 0.3, radar_share: 0.2, ratio: 1.5 },
      { country_code: 'RU', our_count: 80, our_share: 0.2, radar_share: 0.04, ratio: 5 },
      { country_code: 'FJ', our_count: MIN_RANKED_COUNT - 1, our_share: 0.01, radar_share: 0.0001, ratio: 100 },
      { country_code: 'MD', our_count: 50, our_share: 0.1, radar_share: null, ratio: null },
    ];
    const s = baselineRows('index', rows, undefined);
    expect(s.rows.map(r => r.key)).toEqual(['RU', 'US']);
    expect(s.rows[0]).toMatchObject({ trailing: '5.0×', tone: 'rising', target: { kind: 'country', code: 'RU' } });
    expect(s.rows[1]).toMatchObject({ tone: 'rising' });
  });
  it('Baseline raw ranks by volume; bot share ranks by share and is informational', () => {
    const rows: OverindexRow[] = [
      { country_code: 'US', our_count: 100, our_share: 0.3, radar_share: 0.2, ratio: 1.5 },
      { country_code: 'FJ', our_count: 400, our_share: 0.7, radar_share: null, ratio: null },
    ];
    expect(baselineRows('raw', rows, undefined).rows.map(r => r.key)).toEqual(['FJ', 'US']);
    const bot = baselineRows('bot', undefined, [
      { code: 'DE', name: 'Germany', bot_pct: 20, traffic_pct: 5, rank: 1, position: [0, 0] } as never,
      { code: 'NL', name: 'Netherlands', bot_pct: 60, traffic_pct: 2, rank: 2, position: [0, 0] } as never,
    ]);
    expect(bot.rows.map(r => r.key)).toEqual(['NL', 'DE']);
    expect(bot.rows[0]!.target).toBeUndefined();
  });
  it('Campaigns: active first; Movement: newest first; Actors: most clusters first', () => {
    const camp = (id: string, status: string): CampaignGeo => ({ id, name: id, slug: id, status, conflict: null, adversary_countries: ['RU'], target_countries: ['US', 'GB'], threat_actors: [], start_date: null, curated: true });
    expect(campaignRows([camp('b', 'ended'), camp('a', 'active')]).rows.map(r => r.key)).toEqual(['a', 'b']);
    const mv = (id: string, at: string): Movement => ({ id, kind: 'infra_movement', cluster_id: null, cluster_name: null, at, from: { asns: [], countries: [] }, to: { asns: [], countries: [] }, counts: { new_asns: 1, new_ips: 2, new_serials: 0 }, payload_v: 2 });
    expect(movementRows([mv('old', '2026-10-01T00:00:00Z'), mv('new', '2026-10-13T00:00:00Z')]).rows.map(r => r.key)).toEqual(['new', 'old']);
    const act = (id: string, n: number): ActorListItem => ({ id, name: id, cluster_count: n, infra_count: 1 });
    expect(actorRows([act('few', 1), act('many', 9)]).rows.map(r => r.key)).toEqual(['many', 'few']);
  });
  it('every section says why it is empty', () => {
    for (const s of [hostingRows([]), operationRows([]), baselineRows('index', [], undefined), campaignRows([]), movementRows([]), actorRows([])]) {
      expect(s.rows).toEqual([]);
      expect(s.empty.length).toBeGreaterThan(5);
    }
  });
});

describe('velocityRows (Threats lens, Fast view)', () => {
  const n = (cc: string, vf: number, f: number) => ({ lat: 1, lng: 2, threat_count: vf + f, country_code: cc, very_fast: vf, fast: f, precision: 'country' as const });
  it('ranks countries by fast-weaponized threats and opens the country drawer', () => {
    const s = velocityRows(buildVelocityModel([n('DE', 1, 1), n('NL', 5, 5), n('US', 0, 4)]));
    expect(s.rows.map(r => r.key)).toEqual(['NL', 'US', 'DE']);
    expect(s.rows[0]).toMatchObject({ primary: 'Netherlands', secondary: '5 very fast · 5 fast', trailing: '10', target: { kind: 'country', code: 'NL' } });
  });
  it('caps the list and, when empty, says coverage is still filling (not "none")', () => {
    const many = velocityRows(buildVelocityModel(Array.from({ length: 30 }, (_, i) => n(`${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`, 1, i))));
    expect(many.rows.length).toBeLessThanOrEqual(PANEL_ROWS);
    for (const empty of [velocityRows(null), velocityRows(buildVelocityModel([]))]) {
      expect(empty.rows).toEqual([]);
      expect(empty.empty).toMatch(/still filling/i);
    }
  });
});

describe('takedown panel lists', () => {
  const trow = (key: string, td: number, refused: number, expired = 0, over: Partial<TakedownGeoRow> = {}): TakedownGeoRow => {
    const resolved = td + refused + expired;
    return { key, label: `Label ${key}`, country: 'NL', lat: 1, lng: 2, submitted: resolved + 2, taken_down: td, refused, expired, pending: 2, share: resolved ? td / resolved : null, median_hours: 30, ...over };
  };
  it('hardest jurisdictions: lowest share with enough volume, with n resolved and the median hours', () => {
    const s = takedownCountryRows(buildTakedownCountryModel([trow('US', 40, 10), trow('RU', 2, 38), trow('DE', 0, 2), trow('FR', 6, 6)]), '30d');
    expect(s.title).toBe('Hardest jurisdictions');
    expect(s.rows.map(r => r.key)).toEqual(['RU', 'FR', 'US']);   // DE: 2 resolved, left out
    expect(s.rows[0]).toMatchObject({ primary: 'Russia', secondary: '40 resolved · median 30h', trailing: '5%', tone: 'rising', target: { kind: 'country', code: 'RU' } });
    expect(s.rows[2]).toMatchObject({ trailing: '80%', tone: 'neutral' });
  });
  it('says why it is empty, and names the window and the threshold', () => {
    for (const s of [takedownCountryRows(null, '90d'), takedownCountryRows(buildTakedownCountryModel([trow('DE', 0, 2)]), '90d')]) {
      expect(s.rows).toEqual([]);
      expect(s.empty).toContain(`${TAKEDOWN_MIN_RESOLVED}+`);
      expect(s.empty).toContain('90d');
    }
  });
  it('hardest hosts: only a host the map knows can be opened', () => {
    const prov = (id: string) => ({ id, name: `Host ${id}`, asn: 'AS1', country: 'NL', active_threat_count: 5, total_threat_count: 5, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null });
    const providers = [prov('a'), prov('b')];
    const model = buildTakedownProviderModel(buildHostingModel(providers), [trow('a', 3, 17), trow('ghost', 1, 29), trow('b', 18, 2)]);
    const s = takedownProviderRows(model, providers, '30d');
    expect(s.title).toBe('Hardest hosts');
    expect(s.rows.map(r => r.key)).toEqual(['ghost', 'a', 'b']);
    expect(s.rows[0]!.target).toBeUndefined();                       // no ring, no active threats: informational
    expect(s.rows[1]!.target).toMatchObject({ kind: 'provider', id: 'a' });
    expect(s.rows[1]!.secondary).toBe('20 resolved · median 30h · Netherlands');
  });
  it('caps the list', () => {
    const rows = Array.from({ length: 30 }, (_, i) => trow(`${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 3) % 26))}`, i, 20));
    expect(takedownCountryRows(buildTakedownCountryModel(rows), '30d').rows.length).toBeLessThanOrEqual(PANEL_ROWS);
  });
});
