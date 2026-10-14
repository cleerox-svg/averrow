import { describe, it, expect } from 'vitest';
import { placeAround, stepFor, spreadOffset, groupSizes, groupIndexes } from './placement';

describe('placement caps', () => {
  it('stepFor tightens the spiral so a group fits in maxRadius', () => {
    expect(stepFor(1, 2.6, 4)).toBe(2.6);
    expect(stepFor(2, 2.6, 4)).toBe(2.6);
    const s = stepFor(41, 2.6, 4);
    expect(s).toBeLessThan(2.6);
    expect(s * Math.sqrt(40)).toBeCloseTo(4);
  });
  it('placeAround clamps the radius', () => {
    const [dx, dy] = spreadOffset(50, 2.6);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(4);
    const p = placeAround([0, 0], 50, 2.6, 4);
    expect(Math.hypot(p[0], p[1])).toBeLessThanOrEqual(4 + 1e-9);
  });
  it('group helpers agree', () => {
    const items = ['a', 'b', 'a', 'a'];
    expect(groupSizes(items, x => x)).toEqual([3, 1, 3, 3]);
    expect(groupIndexes(items, x => x)).toEqual([0, 0, 1, 2]);
  });
});
