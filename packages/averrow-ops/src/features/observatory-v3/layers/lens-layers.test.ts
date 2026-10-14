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
import { NO_LABELS, type PlacedLabels } from './lens-labels';
import { buildBotShareModel } from '../lib/lens/bot-share';
import { countryCenter } from '../lib/lens/placement';
import { greatCirclePath } from '../anim/great-circle';

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
    bot: null,
    labels: NO_LABELS,
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
    ['hosting', ['hosting-rings', 'hosting-bulletproof-halo', 'hosting-takedown-track', 'hosting-takedown-arc']],
    ['campaigns', ['campaign-arcs', 'campaign-adversaries', 'campaign-targets']],
    ['actors', ['actor-edges', 'actor-bloom', 'actor-core']],
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


// ─── Phase B review fixes ───────────────────────────────────

const everything = (extra: Partial<LensLayerInput> = {}): LensLayerInput => {
  const base = input(
    { operations: true, hosting: true, campaigns: true, actors: true, movement: true },
    { sel: { ...NO_SELECTION, providerId: 'p', opId: 'a', campaignId: 'c', movementId: 'm' }, ...extra },
  );
  const labels: PlacedLabels = {
    edges: [{ id: 'e', text: '◆ cert', position: [5, 52], angle: 10 }],
    hosts: [{ id: 'p', text: 'p', position: [5, 52], radiusPx: 10 }],
    actors: [{ id: 'DE', text: 'DE · high', position: [10, 51], radiusPx: 12 }],
  };
  return { ...base, labels: extra.labels ?? labels };
};

describe('layer data identity is stable across frames (no per-frame rebuilds)', () => {
  const dataById = (layers: ReturnType<typeof buildLensLayers>) =>
    new Map(layers.map(l => [l.id, (l as unknown as { props: { data: unknown } }).props.data]));

  it('every lens layer keeps the SAME data array on every frame', () => {
    const i = everything();
    const a = dataById(buildLensLayers(i, { seconds: 1, t: 10 }));
    const b = dataById(buildLensLayers(i, { seconds: 2.5, t: 987 }));
    expect([...a.keys()].length).toBeGreaterThan(10);
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [id, data] of a) expect(b.get(id), `${id} data identity`).toBe(data);
  });
  it('derived subsets are memoised on the model: separate input objects over the same models share them', () => {
    const i1 = everything();
    const i2 = { ...i1, sel: { ...NO_SELECTION, providerId: 'q' } };
    const a = dataById(buildLensLayers(i1, { seconds: 1, t: 1 }));
    const b = dataById(buildLensLayers(i2, { seconds: 1, t: 1 }));
    for (const id of ['hosting-bulletproof-halo', 'hosting-takedown-arc', 'campaign-adversaries', 'campaign-targets', 'movement-ghosts', 'movement-landings', 'movement-paths']) {
      expect(a.has(id), id).toBe(true);
      expect(b.get(id), `${id} survives a selection change`).toBe(a.get(id));
    }
  });
  it('label layers use the placed arrays as given (their identity only changes when the placement does)', () => {
    const i = everything();
    const layers = buildLensLayers(i, { seconds: 1, t: 1 });
    const get = (id: string) => (layers.find(l => l.id === id) as unknown as { props: { data: unknown } }).props.data;
    expect(get('ops-edge-labels')).toBe(i.labels.edges);
    expect(get('hosting-labels')).toBe(i.labels.hosts);
    expect(get('actor-labels')).toBe(i.labels.actors);
  });
  it('no labels placed => no label layers', () => {
    const got = ids(everything({ labels: NO_LABELS }));
    expect(got).not.toContain('ops-edge-labels');
    expect(got).not.toContain('hosting-labels');
    expect(got).not.toContain('actor-labels');
  });
  it('the baseline outline of a selected country is built once per (shapes, country)', () => {
    const i = input({ baseline: true }, { sel: { ...NO_SELECTION, country: 'NL' } });
    const a = buildLensBaseLayers(i).find(l => l.id === 'baseline-selected') as unknown as { props: { data: unknown } };
    const b = buildLensBaseLayers({ ...i }).find(l => l.id === 'baseline-selected') as unknown as { props: { data: unknown } };
    expect(a.props.data).toBe(b.props.data);
  });
});

describe('campaign markers sit on the country centroid, not on an unwrapped arc vertex', () => {
  it('a campaign that crosses the antimeridian marks the real Fiji position', () => {
    const c: CampaignGeo = { ...camp, id: 'fj', adversary_countries: ['US'], target_countries: ['FJ'] };
    const model = buildCampaignsModel([c]);
    const arc = model.arcs[0]!;
    const unwrapped = greatCirclePath(countryCenter('US')!, countryCenter('FJ')!, 28);
    expect(arc.path[arc.path.length - 1]).toEqual(unwrapped[unwrapped.length - 1]); // sanity: the arc itself may run past 180
    const i = input({ campaigns: true }, { campaigns: model });
    const targets = find(i, 'campaign-targets') as unknown as { props: { data: Array<{ cc: string; position: [number, number] }> } };
    expect(targets.props.data).toEqual([{ cc: 'FJ', position: countryCenter('FJ') }]);
    const advs = find(i, 'campaign-adversaries') as unknown as { props: { data: Array<{ cc: string; position: [number, number] }> } };
    expect(advs.props.data).toEqual([{ cc: 'US', position: countryCenter('US') }]);
  });
});

describe('actors are clickable on the map', () => {
  it('clicking the actor footprint re-selects the actor instead of clearing the selection', () => {
    const i = input({ actors: true });
    const click = props(find(i, 'actor-core')).onClick as (info: { object: unknown }) => boolean;
    expect(click({ object: i.actors!.countries[0] })).toBe(true);
    expect(i.pick.click).toHaveBeenCalledWith({ kind: 'actor', id: 'a' });
    expect(click({ object: null })).toBe(false);
  });
});

describe('Baseline bot-share measure', () => {
  const stops: [number[], number[], number[]] = [[96, 165, 250, 230], [229, 168, 50, 230], [248, 113, 113, 240]];
  const bot = buildBotShareModel(
    [
      { code: 'DE', name: 'Germany', bot_pct: 20, traffic_pct: 5, rank: 1, position: [10, 51] } as never,
      { code: 'NL', name: 'Netherlands', bot_pct: 60, traffic_pct: 2, rank: 2, position: [5, 52] } as never,
    ],
    stops as never, 30, '2026-10-13',
  );
  it('colours countries from the bot model and outlines the provably above-average ones', () => {
    const i = input({ baseline: true }, { measure: 'bot', bot });
    const layer = props(buildLensBaseLayers(i)[0]);
    const fill = layer.getFillColor as (f: { id: string }) => number[];
    expect(fill({ id: 'NL' })).toEqual(bot.colors.get('NL'));
    expect(fill({ id: 'ZZ' })).toEqual([0, 0, 0, 0]);
    const width = layer.getLineWidth as (f: { id: string }) => number;
    expect(width({ id: 'NL' })).toBeGreaterThan(width({ id: 'DE' }));
  });
  it('hover reads the bot-share sentence', () => {
    const i = input({ baseline: true }, { measure: 'bot', bot });
    const hover = props(buildLensBaseLayers(i)[0]).onHover as (info: { object: unknown; x: number; y: number }) => void;
    hover({ object: { id: 'NL' }, x: 3, y: 4 });
    expect(i.pick.hover).toHaveBeenLastCalledWith(expect.objectContaining({ x: 3, y: 4, title: 'Netherlands (NL)' }));
    hover({ object: { id: 'ZZ' }, x: 0, y: 0 });
    expect(i.pick.hover).toHaveBeenLastCalledWith(expect.objectContaining({ lines: ['no Radar bot-share data'] }));
  });
  it('the click carries the pointer position (touch pins a tooltip there)', () => {
    const i = input({ baseline: true }, { measure: 'bot', bot });
    const click = props(buildLensBaseLayers(i)[0]).onClick as (info: { object: unknown; x: number; y: number }) => boolean;
    click({ object: { id: 'NL' }, x: 7, y: 8 });
    expect(i.pick.click).toHaveBeenCalledWith({ kind: 'country', id: 'NL' }, { x: 7, y: 8 });
  });
  it('countries without a Radar baseline are outlined, not filled', () => {
    const i = input({ baseline: true }, {
      baseline: buildBaselineModel([{ country_code: 'NL', our_count: 5, our_share: 0.5, radar_share: null, ratio: null }]),
    });
    expect(buildLensBaseLayers(i).map(l => l.id)).toContain('baseline-no-baseline');
    const withBaseline = input({ baseline: true });
    expect(buildLensBaseLayers(withBaseline).map(l => l.id)).not.toContain('baseline-no-baseline');
  });
});

describe('colour transitions', () => {
  it('selection dim / highlight eases over 250ms, and is instant under reduced motion', () => {
    const live = input({ operations: true, hosting: true, campaigns: true });
    expect(props(find(live, 'ops-edges')).transitions).toMatchObject({ getColor: 250 });
    expect(props(find(live, 'ops-core')).transitions).toMatchObject({ getFillColor: 250, getLineColor: 250 });
    expect(props(find(live, 'hosting-rings')).transitions).toMatchObject({ getLineColor: 250 });
    expect(props(find(live, 'campaign-arcs')).transitions).toMatchObject({ getColor: 250 });
    const rm = input({ operations: true, hosting: true, campaigns: true }, { reducedMotion: true });
    for (const id of ['ops-edges', 'ops-core', 'hosting-rings', 'campaign-arcs']) expect(props(find(rm, id)).transitions).toBeUndefined();
  });
});

describe('the loop idles when nothing animates', () => {
  it('a paused replay with only movement trails needs no frames; pulses still do', () => {
    const trailsOnly = input({ movement: true }, { movement: buildMovementModel([{ ...mv, from: { asns: [], countries: ['MD'] }, to: { asns: [], countries: ['NL'] } }], { nowMs: Date.parse('2026-10-14T00:00:00Z'), periodMs: 7 * 86_400_000 }) });
    expect(trailsOnly.movement!.pulses.length).toBe(0);
    expect(lensNeedsFrame(trailsOnly, { clockPlaying: true })).toBe(true);
    expect(lensNeedsFrame(trailsOnly, { clockPlaying: false })).toBe(false);
    const withPulse = input({ movement: true }, { movement: buildMovementModel([{ ...mv, from: { asns: [], countries: [] } }], { nowMs: Date.parse('2026-10-14T00:00:00Z'), periodMs: 7 * 86_400_000 }) });
    expect(lensNeedsFrame(withPulse, { clockPlaying: false })).toBe(true);
  });
});
