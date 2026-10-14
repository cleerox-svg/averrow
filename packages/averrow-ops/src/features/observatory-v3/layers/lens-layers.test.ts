import { describe, it, expect, vi } from 'vitest';
import type { OperationGeo, ProviderGeo, CampaignGeo, Movement, ActorDetail } from '@/hooks/useObservatoryLenses';
import { lensPreset, noLayers, type LayerToggles } from '../lib/lenses';
import { buildOperationsModel } from '../lib/lens/operations';
import { buildHostingModel } from '../lib/lens/hosting';
import { buildBaselineModel } from '../lib/lens/baseline';
import { buildCampaignsModel } from '../lib/lens/campaigns';
import { buildActorModel } from '../lib/lens/actors';
import { buildMovementModel } from '../lib/lens/movement';
import {
  buildLensLayers, buildLensBaseLayers, lensNeedsFrame, NO_SELECTION, type LensLayerInput, type CountryCollection,
} from './lens-layers';

const op = (o: Partial<OperationGeo> & { id: string }): OperationGeo => ({
  name: o.id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10, actor: null,
  countries: ['NL', 'MD'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null, ...o,
});
const prov = (o: Partial<ProviderGeo> & { id: string }): ProviderGeo => ({
  name: o.id, asn: 'AS1', country: 'NL', active_threat_count: 10, total_threat_count: 10, trend_7d: 1, trend_30d: 1, is_bulletproof: false, reputation_score: null, takedown: null, ...o,
});
const camp: CampaignGeo = { id: 'c', name: 'C', slug: 'c', status: 'active', conflict: null, adversary_countries: ['RU'], target_countries: ['UA'], threat_actors: [], start_date: null, curated: true };
const mv: Movement = { id: 'm', kind: 'infra_movement', cluster_id: null, cluster_name: null, at: '2026-10-13T00:00:00Z', from: { asns: [], countries: ['MD'] }, to: { asns: [], countries: ['NL'] }, counts: { new_asns: 0, new_ips: 0, new_serials: 0 }, payload_v: 2 };
const actor: ActorDetail = { actor: { id: 'a', name: 'A', aliases: [], affiliation: null, country_code: null, capability: null, attribution_confidence: null, status: null, description: null, first_seen: null, last_seen: null }, infrastructure: [{ asn: 'AS1', country_code: 'NL', hosting_provider: null, confidence: 'high', last_observed: 'x' }], clusters: [{ id: 'k', countries: ['NL', 'RU'], asns: [], confidence_score: 50 }], attributions: { by_confidence: {}, by_source: {} } };
const countries: CountryCollection = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'NL', properties: { n: 'Netherlands' }, geometry: { type: 'Polygon', coordinates: [] } }] };

function input(layers: Partial<LayerToggles>, extra: Partial<LensLayerInput> = {}): LensLayerInput {
  return {
    layers: { ...noLayers(), ...layers },
    operations: buildOperationsModel([op({ id: 'a', component_id: 'g1' }), op({ id: 'b', countries: ['US'] })], []),
    hosting: buildHostingModel([prov({ id: 'p', is_bulletproof: true, takedown: { share: 0.5, median_hours: 10, n: 4 } }), prov({ id: 'q', country: 'US' })]),
    baseline: buildBaselineModel([{ country_code: 'NL', our_count: 10, our_share: 0.5, radar_share: 0.1, ratio: 5 }, { country_code: 'DE', our_count: 1, our_share: 0.05, radar_share: 0.1, ratio: 0.5 }]),
    measure: 'index',
    countries,
    campaigns: buildCampaignsModel([camp]),
    actors: buildActorModel(actor),
    movement: buildMovementModel([mv], { nowMs: Date.parse('2026-10-14T00:00:00Z'), periodMs: 7 * 86_400_000 }),
    sel: NO_SELECTION,
    reducedMotion: false,
    isMobile: false,
    pick: { hover: vi.fn(), click: vi.fn(() => true) },
    ...extra,
  };
}
const ids = (i: LensLayerInput, f = { seconds: 1, t: 10 }) => buildLensLayers(i, f).map(l => l.id);
type Props = Record<string, unknown>;
const find = (i: LensLayerInput, id: string, f = { seconds: 1, t: 10 }) => buildLensLayers(i, f).find(l => l.id === id)!;
const props = (l: unknown) => (l as { props: Props }).props;

describe('which layers are built', () => {
  it('nothing for the threats-only preset', () => {
    expect(ids(input(lensPreset('threats')))).toEqual([]);
    expect(buildLensBaseLayers(input(lensPreset('threats')))).toEqual([]);
  });
  it.each([
    ['operations', ['ops-edges', 'ops-bloom', 'ops-core']],
    ['hosting', ['hosting-rings', 'hosting-bulletproof-halo', 'hosting-takedown-track', 'hosting-takedown-arc', 'hosting-labels']],
    ['campaigns', ['campaign-arcs', 'campaign-adversaries', 'campaign-targets']],
    ['actors', ['actor-edges', 'actor-bloom', 'actor-core', 'actor-labels']],
    ['movement', ['movement-paths', 'movement-ghosts', 'movement-landings', 'movement-trails']],
  ] as const)('%s', (layer, expected) => {
    const got = ids(input({ [layer]: true }));
    for (const id of expected) expect(got).toContain(id);
  });
  it('baseline draws UNDER everything (its own entry point) and only once the geometry is loaded', () => {
    expect(buildLensBaseLayers(input({ baseline: true })).map(l => l.id)).toEqual(['baseline-countries']);
    expect(ids(input({ baseline: true }))).toEqual([]);
    expect(buildLensBaseLayers(input({ baseline: true }, { countries: null }))).toEqual([]);
  });
  it('omits a bulletproof halo / takedown arc when no provider has them', () => {
    const plain = input({ hosting: true }, { hosting: buildHostingModel([prov({ id: 'p' })]) });
    expect(ids(plain)).not.toContain('hosting-bulletproof-halo');
    expect(ids(plain)).not.toContain('hosting-takedown-arc');
  });
  it('lets lenses compose', () => {
    expect(ids(input({ operations: true, hosting: true }))).toEqual(expect.arrayContaining(['ops-core', 'hosting-rings']));
  });
  it('an actor with no infrastructure draws nothing (and reports no frame need)', () => {
    const empty = input({ actors: true }, { actors: buildActorModel({ ...actor, infrastructure: [], clusters: [] }) });
    expect(ids(empty)).toEqual([]);
    expect(lensNeedsFrame(empty)).toBe(false);
  });
});

describe('animation inputs', () => {
  it('passes animTime through (uniform-only per-frame change) and gives nodes a shared phase per component', () => {
    const l = props(find(input({ operations: true }), 'ops-core', { seconds: 7.5, t: 0 }));
    expect(l.animTime).toBe(7.5);
    const model = input({ operations: true }).operations!;
    const phases = new Map(model.nodes.map(n => [n.opId, n.phase]));
    expect(phases.get('a')).not.toBe(phases.get('b'));
  });
  it('reduced motion: amplitude 0, solid edges, no trails, numbered hops', () => {
    const rm = input({ operations: true, movement: true, hosting: true }, { reducedMotion: true });
    const core = props(find(rm, 'ops-core'));
    expect((core.getPulseAmp as () => number)()).toBe(0);
    expect(core.animTime).toBe(0);
    const edges = props(find(rm, 'ops-edges'));
    expect(edges.gap).toBe(0);
    expect(edges.speed).toBe(0);
    const got = ids(rm);
    expect(got).not.toContain('movement-trails');
    expect(got).toContain('movement-hop-numbers');
    expect((props(find(rm, 'hosting-bulletproof-halo')).getMaskSpin as number)).toBe(0);
    expect(lensNeedsFrame(rm)).toBe(true); // callers also gate on reducedMotion (the loop never starts)
  });
  it('animated: movement trails carry the replay playhead, dashes flow, the halo spins', () => {
    const live = input({ movement: true, operations: true, hosting: true });
    expect(props(find(live, 'movement-trails', { seconds: 1, t: 1234 })).currentTime).toBe(1234);
    expect((props(find(live, 'ops-edges')).speed as number)).toBeGreaterThan(0);
    expect((props(find(live, 'hosting-bulletproof-halo')).getMaskSpin as number)).toBeGreaterThan(0);
  });
  it('the loop is needed only while something animates', () => {
    expect(lensNeedsFrame(input(lensPreset('threats')))).toBe(false);
    expect(lensNeedsFrame(input({ operations: true }))).toBe(true);
    expect(lensNeedsFrame(input({ baseline: true }))).toBe(false);
    expect(lensNeedsFrame(input({ hosting: true }, { hosting: buildHostingModel([prov({ id: 'p' })]) }))).toBe(false); // no bulletproof halo to spin
  });
});

describe('selection', () => {
  it('dims everything outside the selected operation\'s component and brightens its edges', () => {
    const i = input({ operations: true }, { sel: { ...NO_SELECTION, opId: 'a' } });
    const core = props(find(i, 'ops-core'));
    const nodes = i.operations!.nodes;
    const inGroup = nodes.find(n => n.opId === 'a')!;
    const outGroup = nodes.find(n => n.opId === 'b')!;
    const fill = core.getFillColor as (n: unknown) => number[];
    expect(fill(inGroup)[3]).toBeGreaterThan(fill(outGroup)[3]);
    expect((core.updateTriggers as Props).getFillColor).toBe('g1');
  });
  it('highlights the selected provider and dims the others', () => {
    const i = input({ hosting: true }, { sel: { ...NO_SELECTION, providerId: 'p' } });
    const rings = props(find(i, 'hosting-rings'));
    const [p, q] = i.hosting!.rings;
    const line = rings.getLineColor as (r: unknown) => number[];
    expect(line(p)[0]).toBe(229); // amber selection
    expect(line(q)[3]).toBeLessThan(100); // dimmed
  });
});

describe('picking', () => {
  it('clicking a node / ring reports the object kind and id', () => {
    const i = input({ operations: true, hosting: true });
    const opClick = props(find(i, 'ops-core')).onClick as (info: { object: unknown }) => boolean;
    expect(opClick({ object: i.operations!.nodes[0] })).toBe(true);
    expect(i.pick.click).toHaveBeenCalledWith({ kind: 'operation', id: i.operations!.nodes[0]!.opId });
    const hostClick = props(find(i, 'hosting-rings')).onClick as (info: { object: unknown }) => boolean;
    hostClick({ object: i.hosting!.rings[0] });
    expect(i.pick.click).toHaveBeenCalledWith({ kind: 'provider', id: i.hosting!.rings[0]!.id });
    expect(opClick({ object: null })).toBe(false);
  });
  it('hover reports a tooltip with position, and clears on leave', () => {
    const i = input({ hosting: true });
    const hover = props(find(i, 'hosting-rings')).onHover as (info: { object: unknown; x: number; y: number }) => void;
    hover({ object: i.hosting!.rings[0], x: 5, y: 6 });
    expect(i.pick.hover).toHaveBeenLastCalledWith(expect.objectContaining({ x: 5, y: 6, title: i.hosting!.rings[0]!.name }));
    hover({ object: null, x: 0, y: 0 });
    expect(i.pick.hover).toHaveBeenLastCalledWith(null);
  });
  it('the choropleth fill follows the measure and country ids', () => {
    const idx = input({ baseline: true }, { measure: 'index' });
    const raw = input({ baseline: true }, { measure: 'raw' });
    const fi = props(buildLensBaseLayers(idx)[0]).getFillColor as (f: { id: string }) => number[];
    const fr = props(buildLensBaseLayers(raw)[0]).getFillColor as (f: { id: string }) => number[];
    expect(fi({ id: 'DE' })).not.toEqual(fr({ id: 'DE' }));
    expect(fi({ id: 'ZZ' })).toEqual([0, 0, 0, 0]);
    expect((props(buildLensBaseLayers(raw)[0]).updateTriggers as Props).getFillColor).toEqual(['raw', raw.baseline]);
  });
  it('the crossfade is a deck transition, switched off under reduced motion', () => {
    expect(props(buildLensBaseLayers(input({ baseline: true }))[0]).transitions).toEqual({ getFillColor: 600 });
    expect(props(buildLensBaseLayers(input({ baseline: true }, { reducedMotion: true }))[0]).transitions).toBeUndefined();
  });
});
