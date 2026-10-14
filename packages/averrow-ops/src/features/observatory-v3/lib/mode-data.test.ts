import { describe, it, expect } from 'vitest';
import { dataNeeds, relevantFailures } from './mode-data';
import { DEFAULT_LAYERS } from './url-state';

describe('dataNeeds', () => {
  it('global mode fetches nodes, arcs and stats but not heatmap/bot', () => {
    expect(dataNeeds('global', DEFAULT_LAYERS)).toEqual({ nodes: true, arcs: true, heatmap: false, stats: true, bot: false });
  });
  it('global with every layer off needs no arcs', () => {
    expect(dataNeeds('global', { nodes: false, particles: false, beams: false }).arcs).toBe(false);
  });
  it('beams alone still need arcs', () => {
    expect(dataNeeds('global', { nodes: false, particles: false, beams: true }).arcs).toBe(true);
  });
  it('heatmap mode fetches heatmap + stats only', () => {
    expect(dataNeeds('heatmap', DEFAULT_LAYERS)).toEqual({ nodes: false, arcs: false, heatmap: true, stats: true, bot: false });
  });
  it('bot mode fetches only bot data', () => {
    expect(dataNeeds('bot_density', DEFAULT_LAYERS)).toEqual({ nodes: false, arcs: false, heatmap: false, stats: false, bot: true });
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
