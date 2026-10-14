import { describe, it, expect } from 'vitest';
import type { OperationGeo } from '@/hooks/useObservatoryLenses';
import { buildOperationsModel } from '../lib/lens/operations';
import { edgeLabelSources, placeLensLabels, type Project } from './lens-labels';

const op = (id: string, countries: string[]): OperationGeo => ({
  id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10, actor: null,
  countries, asns: ['AS1', 'AS2', 'AS3'], last_seen: null, last_movement_pivot_at: null,
});

// On a globe a long edge usually has an end behind the horizon: the projection answers null for it.
describe('edge labels on a globe (ends past the horizon)', () => {
  const size = { width: 1000, height: 700 };
  const model = buildOperationsModel([op('a', ['US', 'DE'])], []);
  const sources = edgeLabelSources(model, '');
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
