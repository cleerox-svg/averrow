import { describe, it, expect, vi } from 'vitest';
import type { OperationGeo, ProviderGeo, Movement, ActorDetail } from '@/hooks/useObservatoryLenses';
import { noLayers } from '../lib/lenses';
import { buildOperationsModel } from '../lib/lens/operations';
import { buildHostingModel } from '../lib/lens/hosting';
import { buildActorModel } from '../lib/lens/actors';
import { buildMovementModel } from '../lib/lens/movement';
import { buildLensLayers, NO_SELECTION, type LensLayerInput } from './lens-layers';
import { NO_LABELS, type PlacedLabels } from './lens-labels';
import { GLOBE_SCREEN_SPACE_PARAMETERS } from '../lib/projection';

const op = (id: string): OperationGeo => ({
  id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10, actor: null,
  countries: ['NL', 'MD'], asns: ['AS1'], last_seen: null, last_movement_pivot_at: null,
});
const prov = (id: string): ProviderGeo => ({
  id, name: id, asn: 'AS1', country: 'NL', active_threat_count: 10, total_threat_count: 10, trend_7d: 1, trend_30d: 1,
  is_bulletproof: false, reputation_score: null, takedown: null,
});
const mv: Movement = { id: 'm', kind: 'infra_movement', cluster_id: null, cluster_name: null, at: '2026-10-13T00:00:00Z', from: { asns: [], countries: ['MD'] }, to: { asns: [], countries: ['NL'] }, counts: { new_asns: 0, new_ips: 0, new_serials: 0 }, payload_v: 2 };
const actor: ActorDetail = { actor: { id: 'a', name: 'A', aliases: [], affiliation: null, country_code: null, capability: null, attribution_confidence: null, status: null, description: null, first_seen: null, last_seen: null }, infrastructure: [{ asn: 'AS1', country_code: 'NL', hosting_provider: null, confidence: 'high', last_observed: 'x' }], clusters: [{ id: 'k', countries: ['NL', 'RU'], asns: [], confidence_score: 50 }], attributions: { by_confidence: {}, by_source: {} } };

const labels: PlacedLabels = {
  edges: [{ id: 'e', text: '◆ cert', position: [5, 52], angle: 10 }],
  hosts: [{ id: 'p', text: 'p', position: [5, 52], radiusPx: 10 }],
  actors: [{ id: 'NL', text: 'NL · high', position: [5, 52], radiusPx: 12 }],
};

function input(extra: Partial<LensLayerInput> = {}): LensLayerInput {
  return {
    layers: { ...noLayers(), operations: true, hosting: true, actors: true, movement: true },
    operations: buildOperationsModel([op('a'), op('b')], []),
    hosting: buildHostingModel([prov('p')]),
    baseline: null, measure: 'index', bot: null, countries: null, campaigns: null,
    velocity: null, takedownCountries: null, takedownProviders: null,
    actors: buildActorModel(actor),
    movement: buildMovementModel([mv], { nowMs: Date.parse('2026-10-14T00:00:00Z'), periodMs: 7 * 86_400_000 }),
    sel: NO_SELECTION, labels, reducedMotion: false, isMobile: false,
    pick: { hover: vi.fn(), click: vi.fn(() => true) },
    ...extra,
  };
}
const params = (l: unknown) => (l as { props: { parameters?: unknown } }).props.parameters;
const labelLayers = (i: LensLayerInput) => buildLensLayers(i, { seconds: 1, t: 1 }).filter(l => /-labels$/.test(l.id));

describe('text labels on the globe draw without the depth test', () => {
  it('every label layer gets the screen-space parameters on the globe (same object each frame, so deck diffs it as unchanged)', () => {
    const layers = labelLayers(input({ projection: 'globe' }));
    expect(layers.map(l => l.id).sort()).toEqual(['actor-labels', 'hosting-labels', 'ops-edge-labels']);
    for (const l of layers) expect(params(l)).toBe(GLOBE_SCREEN_SPACE_PARAMETERS);
    expect(params(labelLayers(input({ projection: 'globe' }))[0])).toBe(params(layers[0]));
  });

  it('the reduced-motion hop numbers (text too) are covered', () => {
    const l = buildLensLayers(input({ projection: 'globe', reducedMotion: true, layers: { ...noLayers(), movement: true } }), { seconds: 1, t: 1 })
      .find(x => x.id === 'movement-hop-numbers');
    expect(l).toBeDefined();
    expect(params(l)).toBe(GLOBE_SCREEN_SPACE_PARAMETERS);
  });

  it('the flat map is untouched: no layer parameters beyond deck\'s empty default', () => {
    for (const projection of [undefined, 'flat' as const]) {
      for (const l of labelLayers(input({ projection }))) expect(params(l)).toEqual({});
    }
    const l = buildLensLayers(input({ reducedMotion: true, layers: { ...noLayers(), movement: true } }), { seconds: 1, t: 1 }).find(x => x.id === 'movement-hop-numbers');
    expect(params(l)).toEqual({});
  });

  it('non-text lens layers never get it (they keep the depth test against the planet)', () => {
    const layers = buildLensLayers(input({ projection: 'globe', labels: NO_LABELS }), { seconds: 1, t: 1 });
    expect(layers.length).toBeGreaterThan(5);
    for (const l of layers) expect(params(l), l.id).not.toBe(GLOBE_SCREEN_SPACE_PARAMETERS);
  });

  it('the parameters switch off the depth test and the face culling the globe turns on', () => {
    expect(GLOBE_SCREEN_SPACE_PARAMETERS).toEqual({ depthCompare: 'always', depthWriteEnabled: false, cullMode: 'none' });
  });
});

describe('label fade near the globe\'s limb', () => {
  const colorOf = (l: unknown, d: object) => (l as { props: { getColor: (d: object) => number[] } }).props.getColor(d);

  it('a label with a fade below 1 draws at that fraction of its opacity; an opaque one keeps the shared constant', () => {
    const l = labelLayers(input({ projection: 'globe' }))[0]!;
    const opaque = colorOf(l, { fade: 1 });
    const half = colorOf(l, { fade: 0.5 });
    expect(half.slice(0, 3)).toEqual(opaque.slice(0, 3));
    expect(half[3]).toBe(Math.round(opaque[3]! * 0.5));
    expect(colorOf(l, { fade: 0 })[3]).toBe(0);
    expect(colorOf(l, {})).toBe(opaque); // no fade at all (the flat map, other lenses): the same array every time
    expect(colorOf(l, { fade: 1 })).toBe(opaque);
  });
});
