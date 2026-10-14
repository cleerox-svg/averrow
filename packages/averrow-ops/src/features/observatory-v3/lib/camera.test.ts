import { describe, it, expect } from 'vitest';
import { boundsOf, clampInsets, planCamera, drillPoints, wrapLng, FIT_MAX_ZOOM, POINT_ZOOM, FLY_MS, type FocusModels } from './camera';
import { buildOperationsModel } from './lens/operations';
import { buildCampaignsModel } from './lens/campaigns';
import { buildMovementModel } from './lens/movement';
import { buildActorModel } from './lens/actors';
import { buildHostingModel } from './lens/hosting';
import type { CampaignGeo, Movement, OperationGeo, ProviderGeo, ActorDetail } from '@/hooks/useObservatoryLenses';

const EMPTY: FocusModels = { operations: null, hosting: null, campaigns: null, movement: null, actors: null };

describe('wrapLng', () => {
  it('maps into [-180, 180)', () => {
    expect(wrapLng(190)).toBe(-170);
    expect(wrapLng(-190)).toBe(170);
    expect(wrapLng(180)).toBe(-180);
    expect(wrapLng(0)).toBe(0);
  });
});

describe('boundsOf', () => {
  it('is null for nothing placeable', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([[NaN, 1]])).toBeNull();
  });
  it('boxes ordinary points', () => {
    expect(boundsOf([[10, 20], [30, 50], [20, 30]])).toEqual({ west: 10, east: 30, south: 20, north: 50 });
  });
  it('takes the short way across the antimeridian (Fiji + Alaska)', () => {
    const b = boundsOf([[178, -17.7], [-150, 64]])!;
    expect(b.west).toBe(178);
    expect(b.east).toBe(210); // -150 + 360
    expect(b.east - b.west).toBeCloseTo(32);
    expect(b.south).toBe(-17.7);
    expect(b.north).toBe(64);
  });
  it('does not wrap when the points are closer without crossing', () => {
    const b = boundsOf([[-170, 0], [170, 0], [175, 0]])!;
    // -170 -> 170 the long way is 340; the box 170..190 (via the date line) is 20.
    expect(b.west).toBe(170);
    expect(b.east).toBe(190);
  });
  it('a single point is a zero-size box', () => {
    expect(boundsOf([[5, 6]])).toEqual({ west: 5, east: 5, south: 6, north: 6 });
  });
  it('accepts positions already unwrapped past 180', () => {
    const b = boundsOf([[185, 10], [-175, 12]])!;
    expect(b.east - b.west).toBe(0);
  });
});

describe('clampInsets', () => {
  it('leaves roomy insets alone', () => {
    expect(clampInsets({ top: 60, right: 320, bottom: 80, left: 60 }, 1200, 700)).toEqual({ top: 60, right: 320, bottom: 80, left: 60 });
  });
  it('scales insets down so the free area never collapses', () => {
    const c = clampInsets({ top: 0, right: 320, bottom: 0, left: 100 }, 400, 700, 140);
    expect(c.left + c.right).toBeCloseTo(260);
    expect(c.right / c.left).toBeCloseTo(3.2);
  });
  it('clamps negatives', () => {
    expect(clampInsets({ top: -5, right: 0, bottom: 0, left: 0 }, 100, 100).top).toBe(0);
  });
});

describe('planCamera', () => {
  const canvas = { width: 1200, height: 700 };
  const insets = { top: 60, right: 320, bottom: 90, left: 60 };
  it('frames a group with a zoom ceiling and the insets as padding', () => {
    const plan = planCamera([[0, 0], [40, 30]], canvas, insets)!;
    expect(plan.maxZoom).toBe(FIT_MAX_ZOOM);
    expect(plan.padding).toEqual(insets);
    expect(plan.point).toBe(false);
  });
  it('a single point lands on the point zoom with a tiny box', () => {
    const plan = planCamera([[10, 20]], canvas, insets)!;
    expect(plan.point).toBe(true);
    expect(plan.maxZoom).toBe(POINT_ZOOM);
    expect(plan.box.east - plan.box.west).toBeLessThan(0.1);
  });
  it('is null with no positions', () => {
    expect(planCamera([], canvas, insets)).toBeNull();
  });
  it('the fly-to stays within the 800ms budget', () => {
    expect(FLY_MS).toBeLessThanOrEqual(800);
  });
});

const op = (id: string, countries: string[]): OperationGeo => ({
  id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 70, threat_count: 5, actor: null, countries, asns: [], last_seen: null, last_movement_pivot_at: null,
});

describe('drillPoints: every placeable position of the target', () => {
  it('node and arc', () => {
    const node = { lat: 10, lng: 20, threat_count: 1, top_severity: 'high', critical: 0, high: 1, medium: 0, low: 0, country_code: 'NG', top_threat_type: 'phishing' };
    expect(drillPoints({ kind: 'node', node }, EMPTY)).toEqual([[20, 10]]);
    const arc = { sourcePosition: [10, 20] as [number, number], targetPosition: [-70, 40] as [number, number], threat_type: 'x', severity: 'low', source_region: 'NG', target_brand: 'b', brand_name: null, volume: 1 };
    expect(drillPoints({ kind: 'arc', arc }, EMPTY)).toEqual([[10, 20], [-70, 40]]);
    expect(drillPoints({ kind: 'node', node: { ...node, lat: NaN } }, EMPTY)).toEqual([]);
  });
  it('an operation: all its country nodes, not just the first', () => {
    const o = op('a', ['NL', 'DE', 'US', 'JP']);
    const m = { ...EMPTY, operations: buildOperationsModel([o], []) };
    expect(drillPoints({ kind: 'operation', id: 'a', op: o }, m)).toHaveLength(4);
  });
  it('an operation falls back to its countries before the model exists, and is empty while pending', () => {
    expect(drillPoints({ kind: 'operation', id: 'a', op: op('a', ['NL', 'DE']) }, EMPTY)).toHaveLength(2);
    expect(drillPoints({ kind: 'operation', id: 'a', op: null }, EMPTY)).toEqual([]);
  });
  it('a campaign: adversaries AND targets', () => {
    const c: CampaignGeo = { id: 'c', name: 'C', slug: 'c', status: 'active', conflict: null, adversary_countries: ['RU', 'CN'], target_countries: ['US', 'GB', 'UA'], threat_actors: [], start_date: null, curated: true };
    const m = { ...EMPTY, campaigns: buildCampaignsModel([c]) };
    const pts = drillPoints({ kind: 'campaign', id: 'c', campaign: c }, m);
    expect(pts.length).toBeGreaterThanOrEqual(5);
  });
  it('a movement: every hop endpoint', () => {
    const mv: Movement = { id: 'm', kind: 'infra_movement', cluster_id: null, cluster_name: null, at: '2026-10-13T00:00:00Z', from: { asns: [], countries: ['MD', 'RO'] }, to: { asns: [], countries: ['NL', 'DE'] }, counts: { new_asns: 0, new_ips: 0, new_serials: 0 }, payload_v: 2 };
    const model = buildMovementModel([mv], { nowMs: Date.parse('2026-10-14T00:00:00Z'), periodMs: 7 * 86_400_000 });
    const pts = drillPoints({ kind: 'movement', id: 'm', movement: mv }, { ...EMPTY, movement: model });
    expect(pts.length).toBeGreaterThanOrEqual(4);
  });
  it('an actor: all attributed countries; a provider: its ring', () => {
    const detail: ActorDetail = {
      actor: { id: 'a', name: 'A', aliases: [], affiliation: null, country_code: null, capability: null, attribution_confidence: null, status: null, description: null, first_seen: null, last_seen: null },
      infrastructure: [{ asn: 'AS1', country_code: 'NL', hosting_provider: null, confidence: 'high', last_observed: 'x' }, { asn: 'AS2', country_code: 'US', hosting_provider: null, confidence: 'low', last_observed: 'x' }],
      clusters: [], attributions: { by_confidence: {}, by_source: {} },
    };
    expect(drillPoints({ kind: 'actor', id: 'a', name: 'A' }, { ...EMPTY, actors: buildActorModel(detail) })).toHaveLength(2);
    expect(drillPoints({ kind: 'actor', id: 'other', name: null }, { ...EMPTY, actors: buildActorModel(detail) })).toEqual([]);
    const prov: ProviderGeo = { id: 'p', name: 'P', asn: 'AS1', country: 'NL', active_threat_count: 4, total_threat_count: 4, trend_7d: 0, trend_30d: 0, is_bulletproof: false, reputation_score: null, takedown: null };
    expect(drillPoints({ kind: 'provider', id: 'p', provider: prov }, { ...EMPTY, hosting: buildHostingModel([prov]) })).toHaveLength(1);
  });
  it('a country is its centroid', () => {
    expect(drillPoints({ kind: 'country', code: 'NL' }, EMPTY)).toHaveLength(1);
    expect(drillPoints({ kind: 'country', code: 'ZZ' }, EMPTY)).toEqual([]);
  });
});
