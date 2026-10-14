import { describe, it, expect } from 'vitest';
import { WebMercatorViewport } from '@deck.gl/core';
import { isOffsetCopy, type DrawArgsLike } from './world-copies';

const repeating = { flat: true, renderWorldCopies: true };
const draw = (viewport: unknown): DrawArgsLike => ({ shaderModuleProps: { project: { viewport: viewport as { subViewports?: unknown } } } });

describe('isOffsetCopy against real deck viewports', () => {
  // A canvas wider than the world: three copies are visible, as on a very wide monitor.
  const parent = new WebMercatorViewport({ width: 4000, height: 800, longitude: 0, latitude: 20, zoom: 2.2, repeat: true });
  const copies = parent.subViewports!;

  it('the test viewport really repeats (guards the guard)', () => {
    expect(copies.length).toBeGreaterThan(1);
    expect(copies.includes(parent)).toBe(true);
  });
  it('exactly ONE of the visible copies is the primary one: that is where the arcs draw', () => {
    expect(copies.filter(v => !isOffsetCopy(draw(v), repeating))).toEqual([parent]);
  });
});

describe('isOffsetCopy edge cases', () => {
  const offset = draw({ subViewports: null });
  it('with world copies off the lone viewport (subViewports null) is the primary one', () => {
    expect(isOffsetCopy(offset, { flat: true, renderWorldCopies: false })).toBe(false);
  });
  it('the globe has no copies', () => {
    expect(isOffsetCopy(offset, { flat: false, renderWorldCopies: true })).toBe(false);
  });
  it('a viewport that lists its copies is the primary one', () => {
    expect(isOffsetCopy(draw({ subViewports: [] }), repeating)).toBe(false);
  });
  it('a draw call without a viewport hides nothing', () => {
    expect(isOffsetCopy(undefined, repeating)).toBe(false);
    expect(isOffsetCopy({}, repeating)).toBe(false);
  });
});
