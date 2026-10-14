import { describe, it, expect } from 'vitest';
import {
  greatCirclePath, greatCirclePath3D, greatCircleAngle, splitAtAntimeridian, normalizeLng,
  arcAltitude, arcPeakAltitude, MAX_GREAT_CIRCLE_SEGMENTS, EARTH_RADIUS_M,
} from './great-circle';
import type { LngLat } from '@/lib/country-centroids';

const NYC: LngLat = [-74, 40.7];
const LON: LngLat = [-0.13, 51.5];
const TOKYO: LngLat = [139.7, 35.7];
const LA: LngLat = [-118.2, 34.05];

function maxLngJump(p: LngLat[]): number {
  let m = 0;
  for (let i = 1; i < p.length; i++) m = Math.max(m, Math.abs(p[i]![0] - p[i - 1]![0]));
  return m;
}

describe('greatCirclePath', () => {
  it('has segments + 1 points and starts/ends on the endpoints', () => {
    const p = greatCirclePath(NYC, LON, 20);
    expect(p).toHaveLength(21);
    expect(p[0]).toEqual(NYC);
    expect(p[20]![0]).toBeCloseTo(LON[0], 10);
    expect(p[20]![1]).toBeCloseTo(LON[1], 10);
  });

  it('clamps segments to 1..64 and tolerates junk', () => {
    expect(greatCirclePath(NYC, LON, 500)).toHaveLength(MAX_GREAT_CIRCLE_SEGMENTS + 1);
    expect(greatCirclePath(NYC, LON, 0)).toHaveLength(2);
    expect(greatCirclePath(NYC, LON, -3)).toHaveLength(2);
    expect(greatCirclePath(NYC, LON, Number.NaN)).toHaveLength(33);
    expect(greatCirclePath(NYC, LON)).toHaveLength(33);
  });

  it('bows poleward for transatlantic routes (true great circle, not a straight line)', () => {
    const p = greatCirclePath(NYC, LON, 32);
    const maxLat = Math.max(...p.map(q => q[1]));
    expect(maxLat).toBeGreaterThan(Math.max(NYC[1], LON[1]) + 1);
  });

  it('midpoint of an equatorial pair stays on the equator', () => {
    const p = greatCirclePath([0, 0], [90, 0], 2);
    expect(p[1]![0]).toBeCloseTo(45, 8);
    expect(p[1]![1]).toBeCloseTo(0, 8);
  });

  it('all points lie on the same great circle (constant distance sum)', () => {
    const p = greatCirclePath(NYC, TOKYO, 16);
    const total = greatCircleAngle(NYC, TOKYO);
    let sum = 0;
    for (let i = 1; i < p.length; i++) sum += greatCircleAngle(p[i - 1]!, p[i]!);
    expect(sum).toBeCloseTo(total, 6);
  });

  it('is continuous across the antimeridian (Tokyo -> Los Angeles): no >180° jumps', () => {
    const p = greatCirclePath(TOKYO, LA, 32);
    expect(maxLngJump(p)).toBeLessThan(180);
    // runs east past +180 rather than wrapping
    expect(Math.max(...p.map(q => q[0]))).toBeGreaterThan(180);
    // end is LA on the unwrapped branch
    expect(p[32]![0]).toBeCloseTo(LA[0] + 360, 8);
    expect(p[32]![1]).toBeCloseTo(LA[1], 8);
  });

  it('is continuous the other way (LA -> Tokyo) heading west past -180', () => {
    const p = greatCirclePath(LA, TOKYO, 32);
    expect(maxLngJump(p)).toBeLessThan(180);
    expect(Math.min(...p.map(q => q[0]))).toBeLessThan(-180);
    expect(p[32]![0]).toBeCloseTo(TOKYO[0] - 360, 8);
  });

  it('handles points straddling ±180 directly', () => {
    const p = greatCirclePath([170, 10], [-170, 20], 16);
    expect(maxLngJump(p)).toBeLessThan(180);
    expect(p[0]![0]).toBe(170);
    expect(p[16]![0]).toBeCloseTo(190, 8);
  });

  it('degenerate: identical points give a finite, constant path', () => {
    const p = greatCirclePath(NYC, NYC, 8);
    expect(p).toHaveLength(9);
    for (const q of p) {
      expect(q[0]).toBeCloseTo(NYC[0], 8);
      expect(q[1]).toBeCloseTo(NYC[1], 8);
    }
  });

  it('degenerate: antipodal points still produce a finite continuous path ending at b', () => {
    const p = greatCirclePath([10, 20], [-170, -20], 16);
    expect(p.every(q => Number.isFinite(q[0]) && Number.isFinite(q[1]))).toBe(true);
    expect(maxLngJump(p)).toBeLessThan(180.0001);
    expect(normalizeLng(p[16]![0])).toBeCloseTo(-170, 6);
    expect(p[16]![1]).toBeCloseTo(-20, 6);
    // the detour goes over a pole
    expect(Math.max(...p.map(q => Math.abs(q[1])))).toBeGreaterThan(80);
  });
});

describe('splitAtAntimeridian', () => {
  it('returns one piece when nothing crosses', () => {
    const parts = splitAtAntimeridian(greatCirclePath(NYC, LON, 16));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(17);
  });

  it('splits a Tokyo -> LA path into pieces with every longitude in [-180, 180]', () => {
    const parts = splitAtAntimeridian(greatCirclePath(TOKYO, LA, 32));
    expect(parts).toHaveLength(2);
    for (const part of parts) for (const q of part) {
      expect(q[0]).toBeGreaterThanOrEqual(-180);
      expect(q[0]).toBeLessThanOrEqual(180);
    }
    const [first, second] = parts as [LngLat[], LngLat[]];
    expect(first[first.length - 1]![0]).toBe(180);
    expect(second[0]![0]).toBe(-180);
    // crossing latitude is shared and the pieces join up
    expect(first[first.length - 1]![1]).toBeCloseTo(second[0]![1], 10);
    expect(second[second.length - 1]![0]).toBeCloseTo(LA[0], 6);
  });

  it('splits westward crossings too', () => {
    const parts = splitAtAntimeridian(greatCirclePath(LA, TOKYO, 32));
    expect(parts).toHaveLength(2);
    expect(parts[0]![parts[0]!.length - 1]![0]).toBe(-180);
    expect(parts[1]![0]![0]).toBe(180);
  });

  it('keeps total point count = original + 2 per crossing', () => {
    const path = greatCirclePath(TOKYO, LA, 32);
    const parts = splitAtAntimeridian(path);
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(path.length + 2);
  });

  it('handles empty input', () => {
    expect(splitAtAntimeridian([])).toEqual([]);
  });
});

describe('normalizeLng', () => {
  it('wraps into [-180, 180)', () => {
    expect(normalizeLng(190)).toBe(-170);
    expect(normalizeLng(-190)).toBe(170);
    expect(normalizeLng(180)).toBe(-180);
    expect(normalizeLng(0)).toBe(0);
    expect(normalizeLng(725)).toBe(5);
  });
});

describe('altitude helpers', () => {
  it('arcAltitude is 0 at the ends and peaks mid-arc', () => {
    expect(arcAltitude(0, 100)).toBe(0);
    expect(arcAltitude(1, 100)).toBe(0);
    expect(arcAltitude(0.5, 100)).toBe(100);
    expect(arcAltitude(0.25, 100)).toBe(75);
    expect(arcAltitude(-1, 100)).toBe(0);
  });

  it('peak scales with span, capped at maxAltitude', () => {
    expect(arcPeakAltitude(0, 1000)).toBe(0);
    expect(arcPeakAltitude(Math.PI, 1000)).toBe(1000);
    expect(arcPeakAltitude(Math.PI / 2, 1000)).toBe(500);
    expect(arcPeakAltitude(10, 1000)).toBe(1000);
  });

  it('greatCirclePath3D adds a symmetric parabolic altitude', () => {
    const p = greatCirclePath3D(NYC, TOKYO, 16, 1_000_000);
    expect(p).toHaveLength(17);
    expect(p[0]![2]).toBe(0);
    expect(p[16]![2]).toBe(0);
    expect(p[8]![2]).toBeGreaterThan(0);
    expect(p[8]![2]).toBeLessThanOrEqual(1_000_000);
    expect(p[4]![2]).toBeCloseTo(p[12]![2], 6);
  });

  it('exposes the earth radius used for default altitudes', () => {
    expect(EARTH_RADIUS_M).toBeGreaterThan(6_000_000);
  });
});
