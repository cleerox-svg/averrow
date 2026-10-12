import { describe, it, expect } from 'vitest';
import { COUNTRY_CENTROIDS, getCountryCentroid } from './country-centroids';

describe('country centroids', () => {
  it('keys are 2-letter uppercase and coordinates are in range', () => {
    for (const [code, [lng, lat]] of Object.entries(COUNTRY_CENTROIDS)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
    }
    expect(Object.keys(COUNTRY_CENTROIDS).length).toBeGreaterThanOrEqual(240);
  });

  it('returns plausible centroids for known countries', () => {
    const near = (code: string, lng: number, lat: number, tol = 12) => {
      const c = getCountryCentroid(code);
      expect(c).not.toBeNull();
      expect(Math.abs(c![0] - lng)).toBeLessThan(tol);
      expect(Math.abs(c![1] - lat)).toBeLessThan(tol);
    };
    near('US', -98, 39);
    near('RU', 100, 61);
    near('DE', 10.4, 51, 3);
    near('BR', -53, -10, 8);
    near('AU', 134, -25, 8);
    near('JP', 138, 37, 5);
  });

  it('is case-insensitive and null for unknown / empty', () => {
    expect(getCountryCentroid('de')).toEqual(COUNTRY_CENTROIDS.DE);
    expect(getCountryCentroid('ZZ')).toBeNull();
    expect(getCountryCentroid('')).toBeNull();
    expect(getCountryCentroid(null)).toBeNull();
  });
});
