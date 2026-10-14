import { describe, it, expect } from 'vitest';
import { settleSnap, nextSnap, snapFraction, SNAPS } from './sheet';

describe('peek sheet snaps', () => {
  it('rests at ~30 / 60 / 90 percent', () => {
    expect([...SNAPS]).toEqual([0.3, 0.6, 0.9]);
    expect(snapFraction(1)).toBe(0.6);
    expect(snapFraction(99)).toBe(0.9);
    expect(snapFraction(-3)).toBe(0.3);
  });
  it('a slow drag settles on the nearest snap', () => {
    // 800px area, start at 30%, drag up 200px => 55% => nearest 60%
    expect(settleSnap(0.3, -200, 800)).toEqual({ snap: 1, dismiss: false });
    // drag up another 250 from 60% => 91% => 90%
    expect(settleSnap(0.6, -250, 800)).toEqual({ snap: 2, dismiss: false });
    // small wiggle returns to the same snap
    expect(settleSnap(0.6, 20, 800)).toEqual({ snap: 1, dismiss: false });
  });
  it('a flick moves one snap in its direction', () => {
    expect(settleSnap(0.3, -30, 800, -1.2)).toEqual({ snap: 1, dismiss: false });
    expect(settleSnap(0.9, 30, 800, 1.2)).toEqual({ snap: 1, dismiss: false });
    expect(settleSnap(0.9, -30, 800, -2)).toEqual({ snap: 2, dismiss: false });
  });
  it('dragging well below the peek, or a hard flick down from it, dismisses', () => {
    expect(settleSnap(0.3, 200, 800)).toEqual({ snap: 0, dismiss: true });
    expect(settleSnap(0.3, 30, 800, 1.5)).toEqual({ snap: 0, dismiss: true });
    expect(settleSnap(0.3, 40, 800)).toEqual({ snap: 0, dismiss: false });
  });
  it('tolerates a zero-height area', () => {
    expect(settleSnap(0.3, 10, 0).snap).toBeDefined();
  });
  it('the handle cycles peek -> half -> full -> peek', () => {
    expect([nextSnap(0), nextSnap(1), nextSnap(2)]).toEqual([1, 2, 0]);
  });
});
