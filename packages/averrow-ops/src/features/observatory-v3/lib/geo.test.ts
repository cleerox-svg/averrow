import { describe, it, expect } from 'vitest';
import { hasValidPosition, hasValidPoint, hasValidArc } from './geo';

describe('hasValidPosition', () => {
  it('keeps cells on the equator or prime meridian (0 is a real coordinate)', () => {
    expect(hasValidPosition(0, 25)).toBe(true);
    expect(hasValidPosition(5.6, 0)).toBe(true);
  });
  it('excludes only null island (0,0) and non-finite / out-of-range values', () => {
    expect(hasValidPosition(0, 0)).toBe(false);
    expect(hasValidPosition(NaN, 10)).toBe(false);
    expect(hasValidPosition(10, Infinity)).toBe(false);
    expect(hasValidPosition(95, 10)).toBe(false);
    expect(hasValidPosition(10, 181)).toBe(false);
    expect(hasValidPosition(null, 10)).toBe(false);
    expect(hasValidPosition('1', 10)).toBe(false);
  });
  it('point helper mirrors it', () => {
    expect(hasValidPoint({ lat: 0, lng: 12 })).toBe(true);
    expect(hasValidPoint({ lat: 0, lng: 0 })).toBe(false);
  });
});

describe('hasValidArc', () => {
  it('accepts arcs whose endpoints are placeable (including lng=0)', () => {
    expect(hasValidArc({ sourcePosition: [0, 51.5], targetPosition: [-74, 40.7] })).toBe(true);
  });
  it('rejects NaN / null-island endpoints', () => {
    expect(hasValidArc({ sourcePosition: [NaN, 51.5], targetPosition: [-74, 40.7] })).toBe(false);
    expect(hasValidArc({ sourcePosition: [10, 20], targetPosition: [0, 0] })).toBe(false);
  });
});
