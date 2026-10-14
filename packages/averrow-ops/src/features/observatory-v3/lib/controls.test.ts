import { describe, it, expect } from 'vitest';
import { trafficModeOf, trafficPatch, announceTraffic, TRAFFIC_LABEL } from './controls';
import { noLayers } from './lenses';

describe('traffic context control', () => {
  it('maps the nodes / particles flags to a mode', () => {
    expect(trafficModeOf({ nodes: false, particles: false })).toBe('off');
    expect(trafficModeOf({ nodes: true, particles: false })).toBe('nodes');
    expect(trafficModeOf({ nodes: true, particles: true })).toBe('flow');
    expect(trafficModeOf({ nodes: false, particles: true })).toBe('flow'); // a power-user URL: still flow
  });
  it('a mode sets the flags and never touches beams or the lens layers', () => {
    const base = { ...noLayers(), beams: true, hosting: true };
    for (const mode of ['off', 'nodes', 'flow'] as const) {
      const next = { ...base, ...trafficPatch(mode) };
      expect(trafficModeOf(next)).toBe(mode);
      expect(next.beams).toBe(true);
      expect(next.hosting).toBe(true);
    }
  });
  it('round-trips', () => {
    for (const mode of ['off', 'nodes', 'flow'] as const) expect(trafficModeOf(trafficPatch(mode))).toBe(mode);
  });
  it('announces each state, and says so when reduced motion swaps flow for static beams', () => {
    expect(announceTraffic('off', false)).toMatch(/off/);
    expect(announceTraffic('nodes', false)).toMatch(/nodes/);
    expect(announceTraffic('flow', false)).toMatch(/flow/);
    expect(announceTraffic('flow', true)).toMatch(/static beams/);
    expect(TRAFFIC_LABEL.flow).toBe('Nodes + Flow');
  });
});
