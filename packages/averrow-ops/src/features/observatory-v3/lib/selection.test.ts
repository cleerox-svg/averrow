import { describe, it, expect } from 'vitest';
import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import { resolveSelection, clampCardPosition, selectionKey, selectionLngLat } from './selection';
import { arcKey, nodeKey } from './url-state';

const node: ThreatPoint = {
  lat: 40.7128, lng: -74.006, threat_count: 5, top_severity: 'high', critical: 1, high: 2, medium: 1, low: 1,
  country_code: 'US', top_threat_type: 'phishing',
};
const arc: ArcData = {
  sourcePosition: [10, 20], targetPosition: [-100, 40], threat_type: 'c2', severity: 'critical',
  source_region: 'EU', target_brand: 'b1', brand_name: 'Brand', volume: 3,
};

describe('resolveSelection', () => {
  it('resolves a node and an arc from their URL keys', () => {
    expect(resolveSelection(nodeKey(node), null, [node], [arc])).toEqual({ kind: 'node', node });
    expect(resolveSelection(null, arcKey(arc), [node], [arc])).toEqual({ kind: 'arc', arc });
  });
  it('returns null when the selected object is no longer in the data', () => {
    expect(resolveSelection('1.00,2.00', null, [node], [arc])).toBeNull();
    expect(resolveSelection(null, 'gone|x|1.0,1.0|low', [node], [arc])).toBeNull();
    expect(resolveSelection(null, null, [node], [arc])).toBeNull();
  });
  it('keys are distinct per kind', () => {
    expect(selectionKey({ kind: 'node', node })).toMatch(/^node:/);
    expect(selectionKey({ kind: 'arc', arc })).toMatch(/^arc:/);
  });
  it('anchors a node at its position and an arc on its path', () => {
    expect(selectionLngLat({ kind: 'node', node })).toEqual([-74.006, 40.7128]);
    const [lng, lat] = selectionLngLat({ kind: 'arc', arc })!;
    expect(lng).toBeLessThan(10);
    expect(lng).toBeGreaterThan(-100);
    expect(Number.isFinite(lat)).toBe(true);
  });
});

describe('selectionLngLat never yields NaN', () => {
  it('returns null for a node or arc with no placeable position', () => {
    expect(selectionLngLat({ kind: 'node', node: { ...node, lat: NaN } })).toBeNull();
    expect(selectionLngLat({ kind: 'node', node: { ...node, lat: 0, lng: 0 } })).toBeNull();
    expect(selectionLngLat({ kind: 'arc', arc: { ...arc, sourcePosition: [NaN, 1] } })).toBeNull();
    expect(selectionLngLat({ kind: 'arc', arc: { ...arc, targetPosition: [] as unknown as [number, number] } })).toBeNull();
  });
});

describe('clampCardPosition', () => {
  it('is always finite, whatever it is given', () => {
    const p = clampCardPosition({ x: NaN, y: Infinity }, { width: NaN, height: NaN }, { width: NaN, height: 100, rightInset: NaN });
    expect(Number.isFinite(p.left)).toBe(true);
    expect(Number.isFinite(p.top)).toBe(true);
  });
  const card = { width: 300, height: 200 };
  it('keeps the card inside the container, not the window', () => {
    const p = clampCardPosition({ x: 790, y: 590 }, card, { width: 800, height: 600 });
    expect(p.left).toBe(800 - 300 - 8);
    expect(p.top).toBe(600 - 200 - 8);
  });
  it('respects the right inset (open side panel)', () => {
    const p = clampCardPosition({ x: 790, y: 10 }, card, { width: 800, height: 600, rightInset: 320 });
    expect(p.left).toBe(800 - 320 - 300 - 8);
  });
  it('offsets from the anchor when there is room', () => {
    expect(clampCardPosition({ x: 100, y: 100 }, card, { width: 1000, height: 800 })).toEqual({ left: 112, top: 112 });
  });
  it('pins to the margin when the container is smaller than the card', () => {
    expect(clampCardPosition({ x: 50, y: 50 }, card, { width: 200, height: 100 })).toEqual({ left: 8, top: 8 });
  });
});
