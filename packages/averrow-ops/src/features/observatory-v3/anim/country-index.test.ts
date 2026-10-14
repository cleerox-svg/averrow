import { describe, it, expect } from 'vitest';
import {
  COUNTRY_CODES, COUNTRY_COUNT, COUNTRY_POSITIONS, countryIndex, countryCodeAt, countryCentroidAt, countryValueArray,
} from './country-index';
import { COUNTRY_CENTROIDS } from '@/lib/country-centroids';

describe('country index', () => {
  it('covers every centroid exactly once, sorted A–Z', () => {
    expect(COUNTRY_COUNT).toBe(Object.keys(COUNTRY_CENTROIDS).length);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_COUNT);
    expect([...COUNTRY_CODES]).toEqual([...COUNTRY_CODES].sort());
  });

  it('round-trips code <-> index', () => {
    for (const code of ['US', 'GB', 'CA', 'JP', 'AD']) {
      const i = countryIndex(code);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(countryCodeAt(i)).toBe(code);
    }
  });

  it('is case/whitespace tolerant and returns -1 for unknown or empty', () => {
    expect(countryIndex(' us ')).toBe(countryIndex('US'));
    expect(countryIndex('ZZ')).toBe(-1);
    expect(countryIndex('')).toBe(-1);
    expect(countryIndex(null)).toBe(-1);
    expect(countryIndex(undefined)).toBe(-1);
    expect(countryCodeAt(-1)).toBeNull();
    expect(countryCodeAt(COUNTRY_COUNT)).toBeNull();
  });

  it('is stable across calls (same index every time)', () => {
    expect(countryIndex('FR')).toBe(countryIndex('FR'));
  });

  it('reuses the centroid table for positions', () => {
    const i = countryIndex('JP');
    expect(countryCentroidAt(i)).toEqual(COUNTRY_CENTROIDS.JP!.map(Math.fround));
    expect(COUNTRY_POSITIONS).toHaveLength(COUNTRY_COUNT * 2);
    expect(COUNTRY_POSITIONS[i * 2]).toBeCloseTo(COUNTRY_CENTROIDS.JP![0], 4);
    expect(countryCentroidAt(-1)).toBeNull();
    expect(countryCentroidAt(COUNTRY_COUNT)).toBeNull();
  });

  it('countryValueArray fills every slot, keeping index alignment', () => {
    const arr = countryValueArray(new Map([['US', 7], ['GB', 3], ['ZZ', 99]]), 0);
    expect(arr).toHaveLength(COUNTRY_COUNT);
    expect(arr[countryIndex('US')]).toBe(7);
    expect(arr[countryIndex('GB')]).toBe(3);
    expect(arr.reduce((a, b) => a + b, 0)).toBe(10); // ZZ ignored
    expect(countryValueArray({ US: 1 }, -1)[countryIndex('US')]).toBe(1);
    expect(countryValueArray({ US: 1 }, -1)[countryIndex('GB')]).toBe(-1);
  });
});
