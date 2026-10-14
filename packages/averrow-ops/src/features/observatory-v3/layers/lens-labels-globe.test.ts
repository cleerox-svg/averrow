import { describe, it, expect } from 'vitest';
import type { OperationGeo } from '@/hooks/useObservatoryLenses';
import { buildOperationsModel, visibleEdges } from '../lib/lens/operations';
import { edgeLabelSources, hostLabelSources, placeLensLabels, stablePlacement, type PlacedLabels, type Project } from './lens-labels';
import { buildHostingModel } from '../lib/lens/hosting';

const op = (id: string, countries: string[]): OperationGeo => ({
  id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10, actor: null,
  countries, asns: ['AS1', 'AS2', 'AS3'], last_seen: null, last_movement_pivot_at: null,
});

// On a globe a long edge usually has an end behind the horizon: the projection answers null for it.
describe('edge labels on a globe (ends past the horizon)', () => {
  const size = { width: 1000, height: 700 };
  const model = buildOperationsModel([op('a', ['US', 'DE'])], []);
  const sources = edgeLabelSources(visibleEdges(model, null), '');
  const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];
  const near: Project = p => ({ x: 500 + p[0] * 3, y: 350 - p[1] * 2 });

  it('an edge with both ends visible still needs to be long enough on screen (unchanged)', () => {
    const squash: Project = p => ({ x: 500 + p[0] * 0.01, y: 350 + p[1] * 0.01 });
    expect(placeLensLabels({ edges: sources, hosts: [], nodes: [] }, squash, size).edges).toEqual([]);
  });

  it('an end past the horizon means a long edge, not a short one: the label is still placed', () => {
    const hideEnds: Project = p => (sources.some(s => same(p, s.from) || same(p, s.to)) ? null : near(p));
    const out = placeLensLabels({ edges: sources, hosts: [], nodes: [] }, hideEnds, size);
    expect(out.edges.length).toBe(1);
  });

  it('but a label whose own anchor (midpoint) is hidden is not placed', () => {
    const hideMid: Project = p => (sources.some(s => same(p, s.position)) ? null : near(p));
    expect(placeLensLabels({ edges: sources, hosts: [], nodes: [] }, hideMid, size).edges).toEqual([]);
  });

  it('nor one whose neighbouring path points (the screen angle) are hidden', () => {
    const hideBefore: Project = p => (sources.some(s => same(p, s.before)) ? null : near(p));
    expect(placeLensLabels({ edges: sources, hosts: [], nodes: [] }, hideBefore, size).edges).toEqual([]);
  });
});

describe('limb fade: the projector\'s fade rides on the placed label', () => {
  const size = { width: 1000, height: 700 };
  const model = buildOperationsModel([op('a', ['US', 'DE'])], []);
  const sources = edgeLabelSources(visibleEdges(model, null), '');
  const near = (fade: number): Project => p => ({ x: 500 + p[0] * 3, y: 350 - p[1] * 2, fade });

  it('edge labels carry the fade of their anchor', () => {
    expect(placeLensLabels({ edges: sources, hosts: [], nodes: [] }, near(0.4), size).edges[0]!.fade).toBe(0.4);
  });
  it('a projector that gives no fade (the flat map) leaves labels fully opaque', () => {
    const flat: Project = p => ({ x: 500 + p[0] * 3, y: 350 - p[1] * 2 });
    expect(placeLensLabels({ edges: sources, hosts: [], nodes: [] }, flat, size).edges[0]!.fade).toBe(1);
  });
  it('host and actor labels carry it too', () => {
    const hosting = buildHostingModel([{
      id: 'p', name: 'Provider', asn: 'AS1', country: 'NL', active_threat_count: 10, total_threat_count: 10, trend_7d: 1, trend_30d: 1,
      is_bulletproof: false, reputation_score: null, takedown: null,
    }]);
    const out = placeLensLabels({ edges: [], hosts: hostLabelSources(hosting, ''), actors: [{ id: 'NL', text: 'NL · high', position: [60, 20], radiusPx: 10, priority: 1 }], nodes: [] }, near(0.25), size);
    expect(out.hosts[0]!.fade).toBe(0.25);
    expect(out.actors[0]!.fade).toBe(0.25);
  });
  it('stablePlacement keeps the previous object across an invisible fade change and replaces it on a visible one', () => {
    const base: PlacedLabels = { edges: [], hosts: [{ id: 'p', text: 'p', position: [1, 2], radiusPx: 5, fade: 0.5 }], actors: [] };
    const jitter: PlacedLabels = { ...base, hosts: [{ ...base.hosts[0]!, fade: 0.51 }] };
    const moved: PlacedLabels = { ...base, hosts: [{ ...base.hosts[0]!, fade: 0.7 }] };
    expect(stablePlacement(base, jitter)).toBe(base);
    expect(stablePlacement(base, moved)).toBe(moved);
    // a label with no fade reads as fully opaque
    const plain: PlacedLabels = { ...base, hosts: [{ id: 'p', text: 'p', position: [1, 2], radiusPx: 5 }] };
    expect(stablePlacement(plain, { ...base, hosts: [{ ...plain.hosts[0]!, fade: 1 }] })).toBe(plain);
  });
});
