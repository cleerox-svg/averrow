import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadCountryGeometry, resetCountryGeometryCache, isCountryCollection } from './country-geometry';
import { maxLongitudeJump, MAX_LNG_JUMP, type PolygonGeometry } from './antimeridian';

const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'NL', properties: { n: 'Netherlands' }, geometry: { type: 'Polygon', coordinates: [] } }] };
const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);

beforeEach(() => resetCountryGeometryCache());

describe('loadCountryGeometry', () => {
  it('fetches once and shares the result (lazy, cached for the session)', async () => {
    const f = vi.fn(() => json(fc));
    const [a, b] = await Promise.all([loadCountryGeometry(f as unknown as typeof fetch), loadCountryGeometry(f as unknown as typeof fetch)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    await loadCountryGeometry(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('rejects a failed or malformed response, and a retry can succeed', async () => {
    await expect(loadCountryGeometry((() => json({}, false, 500)) as unknown as typeof fetch)).rejects.toThrow(/500/);
    await expect(loadCountryGeometry((() => json({ nope: true })) as unknown as typeof fetch)).rejects.toThrow(/malformed/);
    await expect(loadCountryGeometry((() => json(fc)) as unknown as typeof fetch)).resolves.toBe(fc);
  });
  it('validates the shape', () => {
    expect(isCountryCollection(fc)).toBe(true);
    expect(isCountryCollection({ type: 'FeatureCollection', features: [] })).toBe(false);
    expect(isCountryCollection(null)).toBe(false);
  });
});

describe('the shipped asset', () => {
  it('is a FeatureCollection keyed by ISO-2 ids with names', async () => {
    const data = (await import('../data/countries-110m.json')).default as unknown as { features: Array<{ id: string; properties: { n: string }; geometry: { type: string } }> };
    expect(data.features.length).toBeGreaterThan(170);
    expect(data.features.every(f => /^[A-Z]{2}$/.test(f.id) && f.properties.n.length > 0)).toBe(true);
    expect(data.features.find(f => f.id === 'NL')?.properties.n).toBe('Netherlands');
    expect(data.features.some(f => f.id === 'AQ')).toBe(false); // Antarctica dropped
    expect(data.features.every(f => ['Polygon', 'MultiPolygon'].includes(f.geometry.type))).toBe(true);
  });
  it('has no ring with a longitude jump over 180 degrees (antimeridian smear)', async () => {
    const data = (await import('../data/countries-110m.json')).default as unknown as { features: Array<{ id: string; geometry: PolygonGeometry }> };
    const bad = data.features.filter(f => maxLongitudeJump(f.geometry) > MAX_LNG_JUMP).map(f => f.id);
    expect(bad).toEqual([]);
  });
  it('keeps Russia and Fiji on both sides of the date line', async () => {
    const data = (await import('../data/countries-110m.json')).default as unknown as { features: Array<{ id: string; geometry: { type: string; coordinates: unknown } }> };
    for (const id of ['RU', 'FJ']) {
      const g = data.features.find(f => f.id === id)!.geometry;
      const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates) as number[][][][];
      const xs = polys.flatMap(p => p[0]!.map(c => c[0]!));
      expect(Math.min(...xs)).toBeLessThan(-170);
      expect(Math.max(...xs)).toBeGreaterThan(170);
    }
  });
});
