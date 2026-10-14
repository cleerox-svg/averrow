import { describe, it, expect } from 'vitest';
import { placeLabels, samePlacement, uprightAngle, type LabelCandidate } from './label-placement';

const W = 800;
const H = 600;
const c = (id: string, x: number, y: number, priority = 1, text = 'cert', extra: Partial<LabelCandidate> = {}): LabelCandidate => ({ id, text, x, y, priority, ...extra });

describe('uprightAngle', () => {
  it('keeps text readable: flips anything steeper than 90 degrees', () => {
    expect(uprightAngle(0)).toBe(0);
    expect(uprightAngle(45)).toBe(45);
    expect(uprightAngle(90)).toBe(90);
    expect(uprightAngle(91)).toBe(-89);
    expect(uprightAngle(180)).toBe(0);
    expect(uprightAngle(-135)).toBe(45);
    expect(uprightAngle(-90)).toBe(90);
    expect(uprightAngle(270)).toBe(90);
    expect(uprightAngle(NaN)).toBe(0);
  });
});

describe('placeLabels', () => {
  it('keeps non-overlapping labels in priority order', () => {
    const r = placeLabels([c('a', 100, 100, 1), c('b', 300, 100, 5), c('c', 500, 100, 3)], { width: W, height: H });
    expect(r.map(p => p.id)).toEqual(['b', 'c', 'a']);
  });
  it('drops the lower-priority one of two overlapping labels', () => {
    const r = placeLabels([c('low', 100, 100, 1, 'ASN x3'), c('high', 110, 104, 9, 'ASN x3')], { width: W, height: H });
    expect(r.map(p => p.id)).toEqual(['high']);
  });
  it('is deterministic for equal priorities (id order)', () => {
    const a = placeLabels([c('z', 100, 100), c('a', 104, 100)], { width: W, height: H });
    const b = placeLabels([c('a', 104, 100), c('z', 100, 100)], { width: W, height: H });
    expect(a).toEqual(b);
    expect(a[0]!.id).toBe('a');
  });
  it('keeps clear of nodes', () => {
    const r = placeLabels([c('a', 100, 100, 1, 'IP', { dy: -12 }), c('b', 400, 300)], { width: W, height: H, obstacles: [{ x: 100, y: 88, r: 12 }] });
    expect(r.map(p => p.id)).toEqual(['b']);
  });
  it('skips labels that would hang off the screen', () => {
    expect(placeLabels([c('a', 4, 100), c('b', W - 4, 100), c('c', 100, 2)], { width: W, height: H })).toEqual([]);
  });
  it('caps the count', () => {
    const many = Array.from({ length: 30 }, (_, i) => c(`l${i}`, 30 + (i % 10) * 70, 40 + Math.floor(i / 10) * 120));
    expect(placeLabels(many, { width: W, height: H, max: 5 })).toHaveLength(5);
  });
  it('returns the upright angle and accounts for rotation in the box', () => {
    const [p] = placeLabels([c('a', 200, 200, 1, 'cert serial', { angle: 120 })], { width: W, height: H });
    expect(p!.angle).toBe(-60);
    // A long label rotated steeply occupies a tall box, so a neighbour directly above collides.
    const r = placeLabels([c('a', 200, 200, 5, 'a long edge label', { angle: 80 }), c('b', 200, 150, 1, 'x')], { width: W, height: H });
    expect(r.map(q => q.id)).toEqual(['a']);
  });
  it('ignores non-finite anchors', () => {
    expect(placeLabels([c('a', NaN, 5)], { width: W, height: H })).toEqual([]);
  });
});

describe('samePlacement', () => {
  it('compares ids, order and whole-degree angles', () => {
    expect(samePlacement([{ id: 'a', angle: 10.2 }], [{ id: 'a', angle: 9.8 }])).toBe(true);
    expect(samePlacement([{ id: 'a', angle: 10 }], [{ id: 'a', angle: 20 }])).toBe(false);
    expect(samePlacement([{ id: 'a', angle: 0 }], [{ id: 'b', angle: 0 }])).toBe(false);
    expect(samePlacement([], [{ id: 'b', angle: 0 }])).toBe(false);
  });
});
