import { describe, it, expect } from 'vitest';
import { WebMercatorViewport } from '@deck.gl/core';
import { primaryCopyFilter, PRIMARY_COPY_ONLY } from './world-copies';

const repeating = { flat: true, renderWorldCopies: true };
const ctx = (id: string, viewport: unknown) => ({ layer: { id }, viewport: viewport as { subViewports?: unknown } });

describe('primaryCopyFilter against real deck viewports', () => {
  // A canvas wider than the world: three copies are visible, as on a very wide monitor.
  const parent = new WebMercatorViewport({ width: 4000, height: 800, longitude: 0, latitude: 20, zoom: 2.2, repeat: true });
  const copies = parent.subViewports!;
  const keep = primaryCopyFilter(() => repeating);

  it('the test viewport really repeats (guards the guard)', () => {
    expect(copies.length).toBeGreaterThan(1);
    expect(copies.includes(parent)).toBe(true);
  });
  it('an Operations arc is drawn in exactly ONE of the visible copies, the primary one', () => {
    for (const id of PRIMARY_COPY_ONLY) expect(copies.filter(v => keep(ctx(id, v)))).toEqual([parent]);
  });
  it('every other layer (nodes, areas, labels of other lenses) is drawn in every copy', () => {
    for (const id of ['ops-core', 'ops-bloom', 'ops-node-labels', 'hosting-rings', 'nodes-core']) {
      expect(copies.filter(v => keep(ctx(id, v)))).toHaveLength(copies.length);
    }
  });
});

describe('primaryCopyFilter edge cases', () => {
  const offsetCopy = { subViewports: null };
  const parentLike = { subViewports: [] };
  it('with world copies off the lone viewport (subViewports null) still draws the arcs', () => {
    expect(primaryCopyFilter(() => ({ flat: true, renderWorldCopies: false }))(ctx('ops-edges', offsetCopy))).toBe(true);
  });
  it('the globe has no copies: a viewport without a list still draws them', () => {
    expect(primaryCopyFilter(() => ({ flat: false, renderWorldCopies: true }))(ctx('ops-edges', offsetCopy))).toBe(true);
  });
  it('reads the state at draw time, not at creation', () => {
    let state = { flat: true, renderWorldCopies: true };
    const f = primaryCopyFilter(() => state);
    expect(f(ctx('ops-edge-labels', offsetCopy))).toBe(false);
    state = { flat: false, renderWorldCopies: true };
    expect(f(ctx('ops-edge-labels', offsetCopy))).toBe(true);
    expect(f(ctx('ops-edge-labels', parentLike))).toBe(true);
  });
  it('a missing viewport does not hide anything', () => {
    expect(primaryCopyFilter(() => repeating)(ctx('ops-edges', undefined))).toBe(true);
  });
});
