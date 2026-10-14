import { describe, it, expect } from 'vitest';
import { dataNeeds, relevantFailures } from './mode-data';
import { DEFAULT_LAYERS } from './url-state';
import { noLayers, lensPreset, type LayerToggles } from './lenses';

const layers = (o: Partial<LayerToggles>): LayerToggles => ({ ...noLayers(), ...o });

describe('dataNeeds', () => {
  it('global mode fetches nodes, arcs and stats but not heatmap/bot', () => {
    expect(dataNeeds('global', DEFAULT_LAYERS)).toMatchObject({ nodes: true, arcs: true, heatmap: false, stats: true, bot: false });
  });
  it('global with every layer off needs no arcs', () => {
    expect(dataNeeds('global', layers({})).arcs).toBe(false);
  });
  it('beams alone still need arcs', () => {
    expect(dataNeeds('global', layers({ beams: true })).arcs).toBe(true);
  });
  it('heatmap mode fetches heatmap + stats only', () => {
    expect(dataNeeds('heatmap', DEFAULT_LAYERS)).toMatchObject({ nodes: false, arcs: false, heatmap: true, stats: true, bot: false, operations: false, timeline: false });
  });
  it('bot mode fetches only bot data (and the shapes it is painted on)', () => {
    expect(dataNeeds('bot_density', DEFAULT_LAYERS)).toMatchObject({ nodes: false, arcs: false, heatmap: false, stats: false, bot: true, live: false, geometry: true });
  });
  it('country shapes load only while a choropleth is visible', () => {
    expect(dataNeeds('global', DEFAULT_LAYERS).geometry).toBe(false);
    expect(dataNeeds('global', lensPreset('baseline')).geometry).toBe(true);
    // a country selection on another lens reads the Radar baseline but draws no shapes
    expect(dataNeeds('global', lensPreset('hosting'), { selection: 'country' })).toMatchObject({ overindex: true, geometry: false });
    expect(dataNeeds('heatmap', lensPreset('baseline')).geometry).toBe(false);
  });
});

describe('lens layers fetch only while on', () => {
  it('the threats lens fetches no lens endpoints', () => {
    expect(dataNeeds('global', lensPreset('threats'))).toMatchObject({
      operations: false, movements: false, providers: false, overindex: false, campaigns: false, actors: false, timeline: true, live: true,
    });
  });
  it.each([
    ['operations', 'operations'], ['movement', 'movements'], ['hosting', 'providers'],
    ['baseline', 'overindex'], ['campaigns', 'campaigns'], ['actors', 'actors'],
  ] as const)('the %s lens enables only %s (and not the threat queries)', (lens, key) => {
    const needs = dataNeeds('global', lensPreset(lens));
    expect(needs[key]).toBe(true);
    expect(needs.nodes).toBe(false);
    expect(needs.arcs).toBe(false);
    expect(needs.live).toBe(false);
  });
  it('the replay histogram follows particles or movement', () => {
    expect(dataNeeds('global', layers({ movement: true })).timeline).toBe(true);
    expect(dataNeeds('global', layers({ hosting: true })).timeline).toBe(false);
  });
  it('a node / arc selection keeps its data loaded even with the Nodes layer off', () => {
    expect(dataNeeds('global', layers({ hosting: true }), { selection: 'node' }).nodes).toBe(true);
    expect(dataNeeds('global', layers({ hosting: true }), { selection: 'arc' }).arcs).toBe(true);
  });
  it('a selection keeps exactly the data it resolves against loaded', () => {
    const only = (sel: Parameters<typeof dataNeeds>[2] extends infer O ? O extends { selection?: infer S } ? S : never : never) =>
      dataNeeds('global', layers({ baseline: true }), { selection: sel });
    expect(only('op').operations).toBe(true);
    expect(only('provider').providers).toBe(true);
    expect(only('campaign').campaigns).toBe(true);
    expect(only('move').movements).toBe(true);
    expect(only('actor').actors).toBe(true);
    expect(only(null).operations).toBe(false);
  });
  it('a country drawer reads threats, brands, operations, hosts and the baseline', () => {
    expect(dataNeeds('global', layers({ hosting: true }), { selection: 'country' })).toMatchObject({
      nodes: true, arcs: true, operations: true, providers: true, overindex: true,
    });
  });
  it('focusing the search box loads the lists it searches, and nothing else', () => {
    expect(dataNeeds('global', layers({ hosting: true }), { searching: true })).toMatchObject({
      operations: true, providers: true, actors: true, campaigns: true, movements: false, overindex: false,
    });
  });
  it('lens queries never run outside the global map', () => {
    const needs = dataNeeds('heatmap', layers({ operations: true, hosting: true }));
    expect(needs.operations || needs.providers).toBe(false);
  });
  it('reports only failures of enabled lens queries', () => {
    const err = new Error('x');
    expect(relevantFailures(dataNeeds('global', lensPreset('hosting')), { providers: err, operations: err })).toEqual(['providers']);
  });
});

describe('relevantFailures', () => {
  const err = new Error('x');
  it('ignores errors from queries the mode does not use', () => {
    expect(relevantFailures(dataNeeds('global', DEFAULT_LAYERS), { heatmap: err })).toEqual([]);
    expect(relevantFailures(dataNeeds('heatmap', DEFAULT_LAYERS), { arcs: err, nodes: err })).toEqual([]);
    expect(relevantFailures(dataNeeds('bot_density', DEFAULT_LAYERS), { nodes: err, stats: err })).toEqual([]);
  });
  it('reports errors from queries the mode uses', () => {
    expect(relevantFailures(dataNeeds('global', DEFAULT_LAYERS), { nodes: err, heatmap: err, stats: err })).toEqual(['nodes', 'stats']);
    expect(relevantFailures(dataNeeds('heatmap', DEFAULT_LAYERS), { heatmap: err })).toEqual(['heatmap']);
  });
});
