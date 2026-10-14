import { describe, it, expect } from 'vitest';
import {
  HALO_CELL_PX, HALO_FULL, HALO_FULL_ZOOM, HALO_MIN_SCALE, HALO_MIN_ZOOM, haloCellPx, haloScaleForZoom, haloViewForZoom, thinForHalos, haloWeight, worldPx,
} from './halo';

describe('haloScaleForZoom', () => {
  it('is the smallest at the world view and full size from the full-size zoom in', () => {
    expect(haloScaleForZoom(HALO_MIN_ZOOM)).toBeCloseTo(HALO_MIN_SCALE, 5);
    expect(haloScaleForZoom(-2)).toBeCloseTo(HALO_MIN_SCALE, 5);
    expect(haloScaleForZoom(HALO_FULL_ZOOM)).toBe(1);
    expect(haloScaleForZoom(9)).toBe(1);
  });

  it('grows monotonically with zoom and stays within the bounds', () => {
    let prev = 0;
    for (let z = -1; z <= 6; z += 0.1) {
      const s = haloScaleForZoom(z);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(HALO_MIN_SCALE);
      expect(s).toBeLessThanOrEqual(1);
      prev = s;
    }
  });

  it('is quantised, so a smooth zoom changes it in a handful of steps', () => {
    const seen = new Set<number>();
    for (let z = 0; z <= 5; z += 0.01) seen.add(haloScaleForZoom(z));
    expect(seen.size).toBeLessThanOrEqual(15);
  });

  it('a phone world view (zoom 0.6) and the desktop overview (2.2) both read smaller than full size', () => {
    expect(haloScaleForZoom(0.6)).toBeCloseTo(0.4, 5);
    expect(haloScaleForZoom(2.2)).toBeLessThan(0.7);
    expect(haloScaleForZoom(2.2)).toBeGreaterThan(0.4);
  });

  it('treats a non-finite zoom as full size', () => {
    expect(haloScaleForZoom(Number.NaN)).toBe(1);
  });
});

describe('haloViewForZoom', () => {
  it('pins to one shared object once halos are full size, so state does not change while zooming in', () => {
    expect(haloViewForZoom(4)).toBe(HALO_FULL);
    expect(haloViewForZoom(7.3)).toBe(HALO_FULL);
  });

  it('coarsens the zoom to quarter steps while smaller', () => {
    expect(haloViewForZoom(1.3).zoom).toBe(1.25);
    expect(haloViewForZoom(2.2).zoom).toBe(2.25);
    expect(haloViewForZoom(2.2).scale).toBe(haloScaleForZoom(2.2));
  });
});

describe('haloCellPx', () => {
  it('is zero at full size and the full cell at the smallest scale', () => {
    expect(haloCellPx(1)).toBe(0);
    expect(haloCellPx(HALO_MIN_SCALE)).toBeCloseTo(HALO_CELL_PX, 5);
    expect(haloCellPx(0.1)).toBeCloseTo(HALO_CELL_PX, 5); // below the floor still the largest cell
  });

  it('shrinks as the scale grows', () => {
    expect(haloCellPx(0.7)).toBeLessThan(haloCellPx(0.5));
  });
});

describe('worldPx', () => {
  it('puts the origin at the middle of a 512 * 2^z world, and lng -180 / 180 at its edges', () => {
    expect(worldPx(0, 0, 0)).toEqual([256, 256]);
    expect(worldPx(-180, 0, 1)[0]).toBe(0);
    expect(worldPx(180, 0, 1)[0]).toBe(1024);
  });

  it('survives the poles (latitude is clamped, never Infinity)', () => {
    expect(Number.isFinite(worldPx(0, 90, 2)[1])).toBe(true);
    expect(Number.isFinite(worldPx(0, -90, 2)[1])).toBe(true);
  });
});

describe('thinForHalos', () => {
  interface N { id: string; lng: number; lat: number; w: number }
  const pos = (n: N): [number, number] => [n.lng, n.lat];
  const weight = (n: N) => n.w;
  // Western Europe at the world view (zoom 1, a 1024px world): Paris, Brussels, Amsterdam, Frankfurt are a few px apart.
  const europe: N[] = [
    { id: 'paris', lng: 2.35, lat: 48.85, w: 10 },
    { id: 'brussels', lng: 4.35, lat: 50.85, w: 4 },
    { id: 'amsterdam', lng: 4.9, lat: 52.37, w: 30 },
    { id: 'frankfurt', lng: 8.68, lat: 50.11, w: 20 },
    { id: 'newyork', lng: -74, lat: 40.7, w: 5 },
  ];

  it('keeps everything when the cell is 0 (full size)', () => {
    expect(thinForHalos(europe, pos, weight, 1, 0)).toBe(europe);
  });

  it('keeps the heaviest node per cell and every isolated node', () => {
    const kept = thinForHalos(europe, pos, weight, 1, 40).map(n => n.id);
    expect(kept).toContain('amsterdam');
    expect(kept).toContain('newyork');
    expect(kept).not.toContain('brussels');
    expect(kept.length).toBeLessThan(europe.length);
  });

  it('keeps the input order and is stable on a tie (the earlier item wins)', () => {
    const tie: N[] = [{ id: 'a', lng: 10, lat: 50, w: 5 }, { id: 'b', lng: 10.01, lat: 50.01, w: 5 }];
    expect(thinForHalos(tie, pos, weight, 1, 40).map(n => n.id)).toEqual(['a']);
    const order = thinForHalos(europe, pos, weight, 1, 40).map(n => europe.findIndex(e => e.id === n.id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('drops nothing that is far apart, and ignores non-finite positions without throwing', () => {
    const far: N[] = [{ id: 'a', lng: -100, lat: 40, w: 1 }, { id: 'b', lng: 100, lat: -30, w: 1 }, { id: 'c', lng: Number.NaN, lat: 0, w: 1 }];
    expect(thinForHalos(far, pos, weight, 1, 16).map(n => n.id)).toEqual(['a', 'b']);
  });
});

describe('haloWeight (severity first, then count)', () => {
  it('a critical 3-threat node outranks a low 40-threat one; count breaks ties within a severity', () => {
    expect(haloWeight('critical', 3)).toBeGreaterThan(haloWeight('low', 40));
    expect(haloWeight('high', 1)).toBeGreaterThan(haloWeight('medium', 5000));
    expect(haloWeight('high', 9)).toBeGreaterThan(haloWeight('high', 2));
    expect(haloWeight(null, 5)).toBeLessThan(haloWeight('low', 1));
    expect(haloWeight('low', 1e12)).toBeLessThan(haloWeight('medium', 0));
  });

  it('thinning keeps the critical node in a cell it shares with a heavier low one', () => {
    const nodes = [{ id: 'low40', lng: 10, lat: 50, s: 'low', n: 40 }, { id: 'crit3', lng: 10.01, lat: 50.01, s: 'critical', n: 3 }];
    const kept = thinForHalos(nodes, n => [n.lng, n.lat], n => haloWeight(n.s, n.n), 1, 40).map(n => n.id);
    expect(kept).toEqual(['crit3']);
  });
});
