import { describe, it, expect } from 'vitest';
import { boundsOf, clampInsets, planCamera, drillPoints, lensFitPoints, wrapLng, phoneMinZoom, desktopMinZoom, DEFAULT_MIN_ZOOM, FIT_MAX_ZOOM, POINT_ZOOM, FLY_MS, FRAME_MARGIN, type FocusModels } from './camera';
import { buildOperationsModel, aggregateEdges } from './lens/operations';
import { buildCampaignsModel } from './lens/campaigns';
import { buildMovementModel } from './lens/movement';
import { buildActorModel } from './lens/actors';
import { buildHostingModel } from './lens/hosting';
import type { CampaignGeo, Movement, OperationGeo, ProviderGeo, ActorDetail } from '@/hooks/useObservatoryLenses';

const EMPTY: FocusModels = { operations: null, hosting: null, campaigns: null, movement: null, actors: null };

describe('desktopMinZoom: low enough that a world-spanning target fits beside the open drawer', () => {
  it('is capped at 0.5 on a wide canvas and drops with the canvas width, never below MapLibre\'s floor', () => {
    expect(desktopMinZoom(3000)).toBe(0.5);
    expect(desktopMinZoom(776)).toBeLessThan(-0.5); // 1024px screen: the world must fit in ~440px of free width
    expect(desktopMinZoom(776)).toBeLessThan(desktopMinZoom(1192));
    expect(desktopMinZoom(10)).toBe(DEFAULT_MIN_ZOOM);
    expect(desktopMinZoom(0)).toBe(0.5);
  });
});

describe('phoneMinZoom: derived from the canvas so a world-spanning target can fit', () => {
  // zoom at which a lng span (deg) exactly fills `free` px: world = 512 * 2^z px wide
  const fitZoom = (spanDeg: number, free: number) => Math.log2((free * 360) / (spanDeg * 512));
  it('is never above the old 0.5 floor, and goes lower on narrow canvases', () => {
    expect(phoneMinZoom(1200)).toBe(0.5);
    expect(phoneMinZoom(400)).toBeLessThan(0);
    expect(phoneMinZoom(320)).toBeLessThan(phoneMinZoom(400));
    expect(phoneMinZoom(0)).toBe(0.5);
  });
  it('Operation Alpha (US, BR, DE, RU, JP: a 214 degree box) fits a 400px canvas, which the fixed 0.5 floor could not', () => {
    const plan = planCamera([[-74, 40.7], [-47.9, -15.8], [13.4, 52.5], [37.6, 55.7], [139.7, 35.7]], { width: 400, height: 800 }, { top: 124, right: 12, bottom: 250, left: 12 })!;
    expect(plan.box.east - plan.box.west).toBeGreaterThan(200);
    const free = 400 - plan.padding.left - plan.padding.right;
    const needed = fitZoom(plan.box.east - plan.box.west, free);
    expect(needed).toBeLessThan(0.5);               // the old floor clamped here and cut both ends off
    expect(phoneMinZoom(400)).toBeLessThanOrEqual(needed);
  });
  it("never goes below MapLibre's -2 floor, however narrow the canvas", () => {
    // free width is pinned at 64px under 168px of canvas: log2(64/512) = -3 would be rejected by setMinZoom
    for (const w of [1, 100, 168, 200, 231]) expect(phoneMinZoom(w)).toBe(DEFAULT_MIN_ZOOM);
    expect(phoneMinZoom(232)).toBe(-2);           // exactly the boundary: 128px free = 2^-2 of the world
    expect(phoneMinZoom(233)).toBeGreaterThan(-2);
  });
  it('a full 360 degree target still fits inside the framing margins', () => {
    const free = 400 - 2 * (12 + FRAME_MARGIN);
    expect(phoneMinZoom(400)).toBeLessThanOrEqual(fitZoom(360, free) + 1e-9);
  });
});

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
    // the overlays' insets plus breathing room, so a node never sits on the edge of the free area
    expect(plan.padding).toEqual({ top: 60 + FRAME_MARGIN, right: 320 + FRAME_MARGIN, bottom: 90 + FRAME_MARGIN, left: 60 + FRAME_MARGIN });
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

describe('lensFitPoints: what a lens occupies when it is entered with nothing selected', () => {
  const models = (over: Partial<FocusModels>): FocusModels => ({ operations: null, hosting: null, campaigns: null, movement: null, actors: null, ...over });
  it('is empty until the lens has data, and for lenses that do not frame themselves', () => {
    expect(lensFitPoints('operations', models({}))).toEqual([]);
    expect(lensFitPoints('threats', models({}))).toEqual([]);
    expect(lensFitPoints('baseline', models({}))).toEqual([]);
    expect(lensFitPoints('actors', models({}))).toEqual([]);
  });
  it('operations: every country node', () => {
    const m = buildOperationsModel([
      { id: 'a', name: 'a', component_id: null, kind: 'asn', status: 'active', confidence_score: 1, threat_count: 1, actor: null, countries: ['US', 'JP'], asns: [], last_seen: null, last_movement_pivot_at: null },
    ], []);
    expect(lensFitPoints('operations', models({ operations: m }))).toEqual(m.nodes.map(n => n.position));
    expect(lensFitPoints('operations', models({ operations: m }))).toHaveLength(2);
  });
  it('a fit across the Pacific is a short box over the date line, not a world-wide one', () => {
    const m = buildOperationsModel([
      { id: 'a', name: 'a', component_id: null, kind: 'asn', status: 'active', confidence_score: 1, threat_count: 1, actor: null, countries: ['US', 'JP'], asns: [], last_seen: null, last_movement_pivot_at: null },
    ], []);
    const box = boundsOf(lensFitPoints('operations', models({ operations: m })))!;
    expect(box.east - box.west).toBeLessThan(240);
  });
});

describe('noWrap framing: the flat Operations arcs live in -180..180, so the camera frames the same space', () => {
  const canvas = { width: 1200, height: 700 };
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const mk = (countries: string[]) => buildOperationsModel([
    { id: 'a', name: 'a', component_id: null, kind: 'asn', status: 'active', confidence_score: 1, threat_count: 1, actor: null, countries, asns: [], last_seen: null, last_movement_pivot_at: null },
  ], []);
  for (const countries of [['JP', 'US'], ['JP', 'US', 'DE']]) {
    it(`${countries.join('+')}: every node and every arc point is inside the framed box, in the primary copy`, () => {
      const m = mk(countries);
      const pts = lensFitPoints('operations', { ...EMPTY, operations: m });
      const wrapped = planCamera(pts, canvas, insets)!;
      const plan = planCamera(pts, canvas, insets, { noWrap: true })!;
      expect(plan.box.west).toBeGreaterThanOrEqual(-180);
      expect(plan.box.east).toBeLessThanOrEqual(180);
      for (const [lng, lat] of pts) {
        expect(lng).toBeGreaterThanOrEqual(plan.box.west);
        expect(lng).toBeLessThanOrEqual(plan.box.east);
        expect(lat).toBeGreaterThanOrEqual(plan.box.south);
        expect(lat).toBeLessThanOrEqual(plan.box.north);
      }
      const edges = aggregateEdges(m, ['a']);
      expect(edges.length).toBeGreaterThan(0);
      for (const e of edges) for (const [lng] of e.path) {
        expect(lng).toBeGreaterThanOrEqual(plan.box.west);
        expect(lng).toBeLessThanOrEqual(plan.box.east);
      }
      // the default (circle) framing for JP+US is the short box across the Pacific: the one that disagreed with the arcs
      if (countries.length === 2) expect(wrapped.box.east).toBeGreaterThan(180);
    });
  }
  it('boundsOf noWrap is the plain min/max box; default stays the circle box', () => {
    expect(boundsOf([[138, 36], [-98, 39]], { noWrap: true })).toEqual({ west: -98, south: 36, east: 138, north: 39 });
    expect(boundsOf([[175, 0], [-170, 0]])!.east).toBe(190);
  });
});
