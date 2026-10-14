import { describe, it, expect, vi } from 'vitest';
import type { OperationGeo, ProviderGeo, CampaignGeo, Movement, ActorDetail } from '@/hooks/useObservatoryLenses';
import { lensPreset, noLayers, type LayerToggles } from '../lib/lenses';
import { buildOperationsModel } from '../lib/lens/operations';
import { buildHostingModel } from '../lib/lens/hosting';
import { buildBaselineModel } from '../lib/lens/baseline';
import { buildCampaignsModel } from '../lib/lens/campaigns';
import { buildActorModel } from '../lib/lens/actors';
import { buildMovementModel } from '../lib/lens/movement';
import { buildVelocityModel, VELOCITY_COLOR } from '../lib/lens/velocity';
import { buildTakedownCountryModel, buildTakedownProviderModel, TAKEDOWN_SMALL_COLOR } from '../lib/lens/takedowns';
import type { TakedownGeoRow } from '@/hooks/useObservatoryLenses';
import { getSeverityColor } from '../lib/map-colors';
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
    velocity: null,
    takedownCountries: null,
    takedownProviders: null,
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
  it('passes animTime through (uniform-only per-frame change) and gives each country node its own phase', () => {
    const l = props(find(input({ operations: true }), 'ops-core', { seconds: 7.5, t: 0 }));
    expect(l.animTime).toBe(7.5);
    const model = input({ operations: true }).operations!;
    expect(new Set(model.nodes.map(n => n.phase)).size).toBeGreaterThan(1); // each country beats on its own phase
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
  it('dims every country outside the selected operation\'s footprint', () => {
    const i = input({ operations: true }, { sel: { ...NO_SELECTION, opId: 'a' } });
    const core = props(find(i, 'ops-core'));
    const nodes = i.operations!.nodes;
    const inGroup = nodes.find(n => n.country === 'NL')!;
    const outGroup = nodes.find(n => n.country === 'US')!;
    const fill = core.getFillColor as (n: unknown) => number[];
    expect(fill(inGroup)[3]).toBeGreaterThan(fill(outGroup)[3]);
    expect((core.updateTriggers as Props).getFillColor).toBe('a');
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
  it('clicking a country node opens that country (its drawer lists the operations); a ring reports the provider', () => {
    const i = input({ operations: true, hosting: true });
    const opClick = props(find(i, 'ops-core')).onClick as (info: { object: unknown }) => boolean;
    expect(opClick({ object: i.operations!.nodes[0] })).toBe(true);
    expect(i.pick.click).toHaveBeenCalledWith({ kind: 'country', id: i.operations!.nodes[0]!.country });
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

describe('Fast weaponization (velocity) layers', () => {
  const vnode = (cc: string, veryFast: number, fast: number) => {
    const c = countryCenter(cc)!;
    return { lat: c[1], lng: c[0], threat_count: veryFast + fast, country_code: cc, very_fast: veryFast, fast, precision: 'country' as const };
  };
  const model = () => buildVelocityModel([vnode('NL', 6, 4), vnode('US', 0, 3)]);
  const fastInput = (extra: Partial<LensLayerInput> = {}) => input({}, { velocity: model(), ...extra });

  it('draws bloom + core (+ the very-fast ring) only while the Fast view hands the map a model; nothing without one', () => {
    expect(ids(fastInput())).toEqual(['velocity-bloom', 'velocity-core', 'velocity-hot-ring']);
    expect(ids(input({}))).toEqual([]);
    expect(ids(fastInput({ velocity: buildVelocityModel([]) }))).toEqual([]);
  });
  it('node size follows very_fast + fast and the colour is not a severity colour', () => {
    const i = fastInput();
    const core = props(find(i, 'velocity-core'));
    const pts = i.velocity!.points;
    const radius = core.getRadius as (p: unknown) => number;
    expect(radius(pts[0]!)).toBeGreaterThan(radius(pts[1]!));
    const fill = core.getFillColor as (p: unknown) => number[];
    expect(fill(pts[0]!).slice(0, 3)).toEqual([...VELOCITY_COLOR.slice(0, 3)]);
    for (const sev of ['critical', 'high', 'medium', 'low']) expect(fill(pts[0]!).slice(0, 3)).not.toEqual([...getSeverityColor(sev).slice(0, 3)]);
  });
  it('pulses through PulseExtension: only very-fast nodes breathe, none under reduced motion', () => {
    const i = fastInput();
    const core = props(find(i, 'velocity-core'));
    expect(core.extensions).toBeTruthy();
    const amp = core.getPulseAmp as (p: unknown) => number;
    const [hot, still] = i.velocity!.points;
    expect(amp(hot!)).toBeGreaterThan(0);
    expect(amp(still!)).toBe(0);
    const rm = fastInput({ reducedMotion: true });
    expect((props(find(rm, 'velocity-core')).getPulseAmp as (p: unknown) => number)(hot!)).toBe(0);
    expect(props(find(rm, 'velocity-core')).animTime).toBe(0);
    expect(props(find(rm, 'velocity-core')).transitions).toBeUndefined();
  });
  it('very-fast nodes carry a STATIC ring, so they differ from fast-only ones without motion', () => {
    const i = fastInput();
    const ring = props(find(i, 'velocity-hot-ring'));
    const hot = i.velocity!.points.filter(p => p.hot);
    expect(hot.length).toBe(1);
    expect(ring.data).toEqual(hot);
    expect(ring.filled).toBe(false);
    expect(ring.stroked).toBe(true);
    expect(ring.pickable).toBe(false);
    expect(ring.extensions).toEqual([]);                           // not part of the pulse
    expect(ring.animTime).toBeUndefined();
    const radius = ring.getRadius as (p: { radiusPx: number }) => number;
    expect(radius(hot[0]!)).toBeGreaterThan(hot[0]!.radiusPx * 1.26); // clear of the breathing core's peak
    // the same under reduced motion (the ring is the whole difference there)
    expect(ids(fastInput({ reducedMotion: true }))).toContain('velocity-hot-ring');
    // and absent when nothing is very fast
    expect(ids(fastInput({ velocity: buildVelocityModel([vnode('US', 0, 3)]) }))).toEqual(['velocity-bloom', 'velocity-core']);
    // stable data identity across frames
    expect(props(find(i, 'velocity-hot-ring', { seconds: 1, t: 1 })).data).toBe(props(find(i, 'velocity-hot-ring', { seconds: 9, t: 9 })).data);
  });
  it('the loop is needed only while a very-fast node pulses', () => {
    expect(lensNeedsFrame(fastInput())).toBe(true);
    expect(lensNeedsFrame(fastInput({ velocity: buildVelocityModel([vnode('US', 0, 3)]) }))).toBe(false);
    expect(lensNeedsFrame(input({}))).toBe(false);
  });
  it('data identity is the model\'s own array on every frame (uniform-only per-frame change)', () => {
    const i = fastInput();
    const a = props(find(i, 'velocity-core', { seconds: 1, t: 1 })).data;
    const b = props(find(i, 'velocity-core', { seconds: 9, t: 99 })).data;
    expect(a).toBe(b);
    expect(a).toBe(i.velocity!.points);
  });
  it('a click picks the country (opens the country drawer); hover names the counts', () => {
    const i = fastInput();
    const core = props(find(i, 'velocity-core'));
    const object = i.velocity!.points[0]!;
    (core.onClick as (info: unknown) => boolean)({ object });
    expect(i.pick.click).toHaveBeenCalledWith({ kind: 'country', id: 'NL' });
    (core.onHover as (info: unknown) => void)({ object, x: 1, y: 2 });
    expect(i.pick.hover).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Netherlands', lines: expect.arrayContaining(['10 fast-weaponized']) }));
    (core.onHover as (info: unknown) => void)({ object: null });
    expect(i.pick.hover).toHaveBeenLastCalledWith(null);
  });
  it('the selected country is outlined in amber', () => {
    const i = fastInput({ sel: { ...NO_SELECTION, country: 'NL' } });
    const line = props(find(i, 'velocity-core')).getLineColor as (p: unknown) => number[];
    const [nl, us] = [i.velocity!.byCc.get('NL')!, i.velocity!.byCc.get('US')!];
    expect(line(nl)).toEqual([229, 168, 50, 255]);
    expect(line(us).slice(0, 3)).toEqual([...VELOCITY_COLOR.slice(0, 3)]);
  });
});

describe('takedown outcomes on the map', () => {
  const trow = (key: string, td: number, refused: number, expired = 0): TakedownGeoRow => {
    const resolved = td + refused + expired;
    return { key, label: key, country: 'NL', lat: 1, lng: 2, submitted: resolved + 1, taken_down: td, refused, expired, pending: 1, share: resolved ? td / resolved : null, median_hours: 12 };
  };
  const cmodel = () => buildTakedownCountryModel([trow('NL', 18, 2), trow('DE', 1, 1), trow('FR', 0, 30)]);

  describe('Baseline > Takedowns (a choropleth by country)', () => {
    const tdInput = (extra: Partial<LensLayerInput> = {}) => input({ baseline: true }, {
      measure: 'takedowns', takedownCountries: cmodel(),
      countries: { type: 'FeatureCollection', features: ['NL', 'DE', 'FR', 'GB'].map(id => ({ type: 'Feature' as const, id, properties: { n: id }, geometry: { type: 'Polygon' as const, coordinates: [] } })) },
      ...extra,
    });
    it('fills each country with its takedown colour: green scale, grey for a small sample, unfilled when no takedowns', () => {
      const i = tdInput();
      const base = props(buildLensBaseLayers(i)[0]);
      const fill = base.getFillColor as (f: { id: string }) => number[];
      expect(fill({ id: 'NL' })).toEqual([...i.takedownCountries!.colors.get('NL')!]);
      expect(fill({ id: 'NL' })[1]).toBeGreaterThan(fill({ id: 'FR' })[1]!);          // 90% brighter than 0%
      expect(fill({ id: 'DE' })).toEqual([...TAKEDOWN_SMALL_COLOR]);                   // 2 resolved
      expect(fill({ id: 'GB' })).toEqual([0, 0, 0, 0]);                                // nothing submitted
    });
    it('outlines the small-sample countries (grey), and only those', () => {
      const layers = buildLensBaseLayers(tdInput());
      const outline = layers.find(l => l.id === 'takedown-small-sample');
      expect(outline).toBeTruthy();
      const features = (props(outline).data as { features: Array<{ id: string }> }).features;
      expect(features.map(f => f.id)).toEqual(['DE']);
      expect(layers.map(l => l.id)).not.toContain('baseline-no-baseline');            // the Radar outline belongs to over-index
    });
    it('outlines every RATED country in its own fill hue at 60% alpha, and nothing else', () => {
      const i = tdInput();
      const layer = buildLensBaseLayers(i).find(l => l.id === 'takedown-rated-outline');
      expect(layer).toBeTruthy();
      const p = props(layer);
      expect((p.data as { features: Array<{ id: string }> }).features.map(f => f.id).sort()).toEqual(['FR', 'NL']); // DE is small, GB has no row
      const line = p.getLineColor as (f: { id: string }) => number[];
      const fill = i.takedownCountries!.colors.get('NL')!;
      expect(line({ id: 'NL' })).toEqual([fill[0], fill[1], fill[2], 153]);
      expect(p.filled).toBe(false);
      expect(p.pickable).toBe(false);
      expect((p.updateTriggers as { getLineColor: unknown[] }).getLineColor).toEqual([i.takedownCountries]);
    });
    it('no rated outline outside the takedowns measure', () => {
      expect(buildLensBaseLayers(input({ baseline: true }, { measure: 'index' })).map(l => l.id)).not.toContain('takedown-rated-outline');
    });
    it('repaints when the model changes (updateTriggers), and the outline data is memoised on the model', () => {
      const a = tdInput();
      const b = tdInput({ takedownCountries: cmodel() });
      expect((props(buildLensBaseLayers(a)[0]).updateTriggers as { getFillColor: unknown[] }).getFillColor).toEqual(['takedowns', a.takedownCountries]);
      expect((props(buildLensBaseLayers(b)[0]).updateTriggers as { getFillColor: unknown[] }).getFillColor[1]).not.toBe(a.takedownCountries);
      const d1 = props(buildLensBaseLayers(a).find(l => l.id === 'takedown-small-sample')).data;
      const d2 = props(buildLensBaseLayers(a).find(l => l.id === 'takedown-small-sample')).data;
      expect(d1).toBe(d2);
    });
    it('hover states the rate, the volume and the median; or why there is no rate; or that nothing was submitted', () => {
      const i = tdInput();
      const hover = props(buildLensBaseLayers(i)[0]).onHover as (info: unknown) => void;
      hover({ object: { id: 'NL' }, x: 1, y: 2 });
      expect(i.pick.hover).toHaveBeenLastCalledWith(expect.objectContaining({ lines: ['90% taken down', '21 submitted · 20 resolved', 'median 12h to take down'] }));
      hover({ object: { id: 'DE' }, x: 1, y: 2 });
      expect((i.pick.hover as unknown as { mock: { lastCall: Array<{ lines: string[] }> } }).mock.lastCall[0]!.lines[0]).toMatch(/too few resolved/);
      hover({ object: { id: 'GB' }, x: 1, y: 2 });
      expect((i.pick.hover as unknown as { mock: { lastCall: Array<{ lines: string[] }> } }).mock.lastCall[0]!.lines).toEqual(['no takedowns submitted in this window']);
    });
    it('a click opens the country drawer', () => {
      const i = tdInput();
      (props(buildLensBaseLayers(i)[0]).onClick as (info: unknown) => boolean)({ object: { id: 'NL' }, x: 3, y: 4 });
      expect(i.pick.click).toHaveBeenCalledWith({ kind: 'country', id: 'NL' }, { x: 3, y: 4 });
    });
    it('without a model (not permitted / still loading) it draws nothing filled and does not throw', () => {
      const i = tdInput({ takedownCountries: null });
      const fill = props(buildLensBaseLayers(i)[0]).getFillColor as (f: { id: string }) => number[];
      expect(fill({ id: 'NL' })).toEqual([0, 0, 0, 0]);
    });
    it('reduced motion: the fill does not crossfade', () => {
      expect(props(buildLensBaseLayers(tdInput({ reducedMotion: true }))[0]).transitions).toBeUndefined();
      expect(props(buildLensBaseLayers(tdInput())[0]).transitions).toBeDefined();
    });
  });

  describe('Hosting > Takedowns (rings coloured by success share)', () => {
    const hosting = buildHostingModel([prov({ id: 'p', is_bulletproof: true }), prov({ id: 'q', country: 'US' }), prov({ id: 'r', country: 'DE' })]);
    const tp = () => buildTakedownProviderModel(hosting, [trow('p', 16, 4), trow('q', 1, 1)]);
    const tdInput = (extra: Partial<LensLayerInput> = {}) => input({ hosting: true }, { hosting, measure: 'takedowns', takedownProviders: tp(), ...extra });
    it('colours each ring with its takedown colour (grey for a small sample or none) instead of its trend colour', () => {
      const i = tdInput();
      const rings = i.takedownProviders!.hosting.rings;
      const line = props(find(i, 'hosting-rings')).getLineColor as (r: unknown) => number[];
      const [p, q, r] = ['p', 'q', 'r'].map(id => rings.find(x => x.id === id)!);
      expect(line(p!).slice(0, 3)).toEqual([...i.takedownProviders!.colors.get('p')!.slice(0, 3)]);
      expect(line(q!).slice(0, 3)).toEqual([...TAKEDOWN_SMALL_COLOR.slice(0, 3)]);
      expect(line(r!).slice(0, 3)).toEqual([...TAKEDOWN_SMALL_COLOR.slice(0, 3)]);
    });
    it('draws the rings from the takedown model, and the arc only for hosts with a rate', () => {
      const i = tdInput();
      expect(props(find(i, 'hosting-rings')).data).toBe(i.takedownProviders!.hosting.rings);
      const arc = props(find(i, 'hosting-takedown-arc')).data as Array<{ id: string; takedownShare: number }>;
      expect(arc.map(r => r.id)).toEqual(['p']);
      expect(arc[0]!.takedownShare).toBeCloseTo(0.8, 9);
    });
    it('without the model the lens falls back to the trend view (providers-geo), even with measure=takedowns', () => {
      const i = tdInput({ takedownProviders: null });
      expect(props(find(i, 'hosting-rings')).data).toBe(hosting.rings);
    });
    it('the default measure is unchanged: trend colours and the providers-geo arc', () => {
      const i = input({ hosting: true }, { hosting, measure: 'index', takedownProviders: tp() });
      expect(props(find(i, 'hosting-rings')).data).toBe(hosting.rings);
    });
    it('hover states the takedown facts', () => {
      const i = tdInput();
      const ring = i.takedownProviders!.hosting.rings.find(r => r.id === 'p')!;
      (props(find(i, 'hosting-rings')).onHover as (info: unknown) => void)({ object: ring, x: 1, y: 2 });
      expect(i.pick.hover).toHaveBeenLastCalledWith(expect.objectContaining({ lines: expect.arrayContaining(['80% taken down', '21 submitted · 20 resolved']) }));
    });
    it('layer data identity is stable across frames and the arc subset is memoised on the takedown model', () => {
      const i = tdInput();
      const a = find(i, 'hosting-takedown-arc', { seconds: 1, t: 1 });
      const b = find(i, 'hosting-takedown-arc', { seconds: 7, t: 9 });
      expect(props(a).data).toBe(props(b).data);
      expect(props(find(i, 'hosting-rings', { seconds: 1, t: 1 })).data).toBe(props(find(i, 'hosting-rings', { seconds: 9, t: 9 })).data);
    });
  });
});

describe('Operations lens on a realistic day (50 operations x 15 countries)', () => {
  const HOT = ['US', 'DE', 'NL', 'GB', 'FR', 'SG', 'JP', 'AU', 'CA', 'BR', 'IN', 'RU', 'CN', 'HK', 'IE', 'SE', 'PL', 'IT', 'ES', 'ZA'];
  const real = Array.from({ length: 50 }, (_, i) => op({
    id: `op${i}`, threat_count: 1000 - i, countries: Array.from({ length: 15 }, (_, k) => HOT[(i * 3 + k * 2 + (k % 3)) % HOT.length]!),
  }));
  const model = buildOperationsModel(real, []);
  const realInput = (extra: Partial<LensLayerInput> = {}) => input({ operations: true }, { operations: model, ...extra });
  const dataOf = (i: LensLayerInput, id: string, f = { seconds: 1, t: 1 }) => props(find(i, id, f)).data as unknown[];

  it('draws one node per country and a capped, small arc set', () => {
    const i = realInput();
    expect(dataOf(i, 'ops-core').length).toBe(model.nodes.length);
    expect(dataOf(i, 'ops-core').length).toBeLessThanOrEqual(HOT.length);
    expect(dataOf(i, 'ops-edges').length).toBeLessThanOrEqual(150);
    expect(dataOf(i, 'ops-edges').length).toBeLessThan(80);
  });
  it('data identity is stable across frames (uniform-only per-frame change)', () => {
    const i = realInput();
    expect(dataOf(i, 'ops-edges', { seconds: 1, t: 1 })).toBe(dataOf(i, 'ops-edges', { seconds: 9, t: 99 }));
    expect(dataOf(i, 'ops-core', { seconds: 1, t: 1 })).toBe(dataOf(i, 'ops-core', { seconds: 9, t: 99 }));
  });
  it('a selection draws only that operation\'s footprint', () => {
    const i = realInput({ sel: { ...NO_SELECTION, opId: 'op20' } });
    const edges = dataOf(i, 'ops-edges') as Array<{ opIds: string[] }>;
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every(e => e.opIds.includes('op20'))).toBe(true);
  });
  it('a previewed row adds its links as a STATIC thin layer (the dash animation stays on the main ones)', () => {
    const i = realInput({ sel: { ...NO_SELECTION, previewOpId: 'op49' } });
    const prev = props(find(i, 'ops-edges-preview'));
    expect((prev.data as Array<{ opIds: string[] }>).some(e => e.opIds.includes('op49'))).toBe(true);
    expect(prev.extensions).toEqual([]);
    expect(prev.pickable).toBe(false);
    expect((props(find(i, 'ops-edges')).extensions as unknown[]).length).toBe(1);
    expect(ids(realInput())).not.toContain('ops-edges-preview');
  });
  it('hovering a row whose pairs are ALREADY drawn still highlights it: boosted arcs, hub ring, others dimmed', () => {
    const hov = 'op3'; // a top operation: all of its pairs are already in the default set
    const base = realInput();
    const i = realInput({ sel: { ...NO_SELECTION, previewOpId: hov } });
    const hi = props(find(i, 'ops-edges-hi'));
    const hiData = hi.data as Array<{ opIds: string[]; opCount: number }>;
    expect(hiData.length).toBeGreaterThan(0);
    expect(hiData.every(e => e.opIds.includes(hov))).toBe(true);
    expect(ids(base)).not.toContain('ops-edges-hi');
    expect((hi.getWidth as (e: unknown) => number)(hiData[0])).toBeGreaterThan((props(find(i, 'ops-edges')).getWidth as (e: unknown) => number)(hiData[0]));
    // Other arcs fade, this operation's do not.
    const colorOf = (layer: string, e: unknown) => (props(find(i, layer)).getColor as (e: unknown) => number[])(e)[3]!;
    const own = hiData[0]!;
    const other = { opIds: ['op40'], opCount: own.opCount };
    expect(colorOf('ops-edges', other)).toBeLessThan(colorOf('ops-edges', own));
    // Nodes outside the footprint dim, the lead country is ringed.
    const core = props(find(i, 'ops-core'));
    const nodes = core.data as Array<{ country: string; opIds: string[] }>;
    const inside = nodes.find(n => n.opIds.includes(hov))!;
    const outside = nodes.find(n => !n.opIds.includes(hov));
    const fill = core.getFillColor as (n: unknown) => number[];
    if (outside) expect(fill(outside)[3]).toBeLessThan(fill(inside)[3]!);
    const hub = model.countriesOf.get(hov)![0]!;
    expect((core.getLineWidth as (n: unknown) => number)(nodes.find(n => n.country === hub))).toBe(3);
    // No data rebuild per hover: the same arrays as the un-hovered default.
    expect(props(find(i, 'ops-core')).data).toBe(props(find(base, 'ops-core')).data);
    expect(props(find(i, 'ops-edges')).data).toBe(props(find(base, 'ops-edges')).data);
  });
  it('arc width and opacity grow with the operations sharing the pair', () => {
    const e = props(find(realInput(), 'ops-edges'));
    const [light, heavy] = [{ opCount: 1 }, { opCount: 9 }];
    expect((e.getWidth as (x: unknown) => number)(heavy)).toBeGreaterThan((e.getWidth as (x: unknown) => number)(light));
    expect((e.getColor as (x: unknown) => number[])(heavy)[3]).toBeGreaterThan((e.getColor as (x: unknown) => number[])(light)[3]!);
  });
  it('on the globe the arcs are lifted great circles; flat arcs stay in one world copy', () => {
    const flat = (props(find(realInput(), 'ops-edges')).getPath as (e: unknown) => number[][])((dataOf(realInput(), 'ops-edges') as unknown[])[0]);
    expect(flat.every(p => p.length === 2 && Math.abs(p[0]!) <= 180)).toBe(true);
    const g = realInput({ projection: 'globe' });
    const path = (props(find(g, 'ops-edges')).getPath as (e: unknown) => number[][])((dataOf(g, 'ops-edges') as unknown[])[0]);
    expect(path.every(p => p.length === 3)).toBe(true);
    expect(Math.max(...path.map(p => p[2]!))).toBeGreaterThan(0);
  });
  it('a country node opens the country drawer; hover names the operations there', () => {
    const i = realInput();
    const core = props(find(i, 'ops-core'));
    const object = model.nodes[0]!;
    (core.onClick as (x: unknown) => boolean)({ object });
    expect(i.pick.click).toHaveBeenCalledWith({ kind: 'country', id: object.country });
    (core.onHover as (x: unknown) => void)({ object, x: 1, y: 2 });
    const tip = (i.pick.hover as unknown as { mock: { lastCall: Array<{ lines: string[] }> } }).mock.lastCall[0]!;
    expect(tip.lines[0]).toMatch(/\d+ operations?/);
  });
});
