import { describe, it, expect } from 'vitest';
import type { Movement } from '@/hooks/useObservatoryLenses';
import { buildMovementModel, moveLabelMinZoom } from '../lib/lens/movement';
import { globeStartCamera, globeFitZoom } from '../lib/projection';
import { moveLabelSources, placeLensLabels, type Project } from './lens-labels';

const mv: Movement = {
  id: 'm1', kind: 'infra_movement', cluster_id: 'c1', cluster_name: 'Op', at: new Date(Date.now() - 20 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
  from: { asns: ['AS1234'], countries: ['DE'] }, to: { asns: ['AS4837'], countries: ['US'] },
  counts: { new_asns: 1, new_ips: 3, new_serials: 0 }, payload_v: 2,
};
const size = { width: 780, height: 755 };

describe('movement hop labels on the globe', () => {
  it('are on at the globe\'s default framing (the zoom it opens at)', () => {
    const start = globeStartCamera(size.width, size.height, false);
    expect(start.zoom).toBeGreaterThanOrEqual(moveLabelMinZoom('globe', size));
    expect(moveLabelMinZoom('globe', size)).toBeLessThan(globeFitZoom(size.width, size.height));
  });

  const model = buildMovementModel([mv], { nowMs: Date.now(), periodMs: 7 * 864e5 });
  const moves = moveLabelSources(model, '');
  const mid = moves[0]!.position;
  const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];
  const spread: Project = p => ({ x: 390 + (p[0] + 50) * 6, y: 400 - (p[1] - 50) * 6 });

  it('slide along the trail when the midpoint is off the viewport', () => {
    const offTop: Project = p => (same(p, mid) ? { x: 390, y: -40 } : spread(p));
    const out = placeLensLabels({ edges: [], hosts: [], nodes: [], moves }, offTop, size);
    expect(out.moves?.length).toBe(1);
    expect(same(out.moves![0]!.position, mid)).toBe(false);
  });

  it('are not placed when the whole hop is on the far side', () => {
    expect(placeLensLabels({ edges: [], hosts: [], nodes: [], moves }, () => null, size).moves).toBeUndefined();
  });

  it('never anchor on a point behind the globe', () => {
    const hidden = (p: readonly number[]) => p[0] > -45;
    const proj: Project = p => (hidden(p) ? null : spread(p));
    const out = placeLensLabels({ edges: [], hosts: [], nodes: [], moves }, proj, size);
    for (const l of out.moves ?? []) expect(hidden(l.position)).toBe(false);
  });
});
