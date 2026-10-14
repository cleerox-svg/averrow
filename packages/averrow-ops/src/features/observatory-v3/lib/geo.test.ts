import { describe, it, expect } from 'vitest';
import { hasValidPosition, hasValidPoint, hasValidArc, worldPixels, lngShiftForPixels, centerLngForFreeArea } from './geo';

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

describe('free-area camera maths', () => {
  it('world width doubles per zoom level', () => {
    expect(worldPixels(0)).toBe(512);
    expect(worldPixels(3)).toBe(4096);
  });
  it('a pixel shift converts to degrees linearly (360° across the world)', () => {
    expect(lngShiftForPixels(512, 0)).toBeCloseTo(360);
    expect(lngShiftForPixels(256, 1)).toBeCloseTo(90);
    expect(lngShiftForPixels(NaN, 2)).toBe(0);
  });
  it('centres the target in the area left free by a left rail and a right drawer', () => {
    // Rail 340 left, drawer 320 right: the free area's middle is 10px right of the map middle.
    const c = centerLngForFreeArea(10, 340, 320, 3);
    expect(c).toBeCloseTo(10 - lngShiftForPixels(10, 3));
    expect(centerLngForFreeArea(10, 0, 0, 3)).toBe(10);
    expect(centerLngForFreeArea(10, NaN, 0, 3)).toBeCloseTo(10 - lngShiftForPixels(0, 3));
    // Only a left rail: the target sits right of centre, so the camera centre moves WEST of it.
    expect(centerLngForFreeArea(10, 340, 0, 3)).toBeLessThan(10);
  });
});
