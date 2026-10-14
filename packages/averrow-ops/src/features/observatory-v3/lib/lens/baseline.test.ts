import { describe, it, expect } from 'vitest';
import {
  ratioToT, overindexColor, rawColor, buildBaselineModel, formatRatio, NO_BASELINE_COLOR, NO_DATA_COLOR,
  OVERINDEX_STOPS, RATIO_MIN, RATIO_MAX,
} from './baseline';

describe('over-index colour scale', () => {
  it('maps ratio 1 to the neutral midpoint and clamps the extremes', () => {
    expect(ratioToT(1)).toBeCloseTo(0.5);
    expect(ratioToT(RATIO_MIN)).toBeCloseTo(0);
    expect(ratioToT(RATIO_MAX)).toBeCloseTo(1);
    expect(ratioToT(0.001)).toBeCloseTo(0);
    expect(ratioToT(1000)).toBeCloseTo(1);
  });
  it('is symmetric on a log scale (2× and ½× are equidistant from neutral)', () => {
    expect(ratioToT(2) - 0.5).toBeCloseTo(0.5 - ratioToT(0.5));
  });
  it('under-index is blue, neutral is the dark midpoint, strong over-index is red', () => {
    const under = overindexColor(0.25);
    const neutral = overindexColor(1);
    const over = overindexColor(4);
    expect(under.slice(0, 3)).toEqual(OVERINDEX_STOPS[0].color.slice(0, 3));
    expect(neutral.slice(0, 3)).toEqual(OVERINDEX_STOPS[1].color.slice(0, 3));
    expect(over.slice(0, 3)).toEqual(OVERINDEX_STOPS[3].color.slice(0, 3));
    expect(under[2]).toBeGreaterThan(under[0]);
    expect(over[0]).toBeGreaterThan(over[2]);
  });
  it('a missing baseline is grey, not "zero"', () => {
    expect(overindexColor(null)).toEqual(NO_BASELINE_COLOR);
    expect(overindexColor(NaN)).toEqual(NO_BASELINE_COLOR);
  });
  it('interpolates monotonically towards red above neutral', () => {
    const reds = [1, 1.5, 2, 3, 4].map(r => overindexColor(r)[0]);
    for (let i = 1; i < reds.length; i++) expect(reds[i]).toBeGreaterThanOrEqual(reds[i - 1]);
  });
  it('raw volume is transparent for zero and brighter for bigger counts', () => {
    expect(rawColor(0, 100)).toEqual(NO_DATA_COLOR);
    expect(rawColor(100, 100)[0]).toBeGreaterThan(rawColor(1, 100)[0]);
  });
});

describe('buildBaselineModel', () => {
  const m = buildBaselineModel([
    { country_code: 'US', our_count: 900, our_share: 0.5, radar_share: 0.4, ratio: 1.25 },
    { country_code: 'MD', our_count: 100, our_share: 0.05, radar_share: null, ratio: null },
    { country_code: 'CN', our_count: 0, our_share: 0, radar_share: 0.1, ratio: 0 },
  ]);
  it('counts countries with and without a baseline and finds the max volume', () => {
    expect(m.withBaseline).toBe(2);
    expect(m.withoutBaseline).toBe(1);
    expect(m.maxCount).toBe(900);
  });
  it('precomputes both measures per country', () => {
    expect(m.indexColors.get('MD')).toEqual(NO_BASELINE_COLOR);
    expect(m.indexColors.get('CN')![2]).toBeGreaterThan(m.indexColors.get('CN')![0]); // 0× = under-index blue
    expect(m.rawColors.get('CN')).toEqual(NO_DATA_COLOR);
    expect(m.rawColors.get('US')![3]).toBeGreaterThan(0);
  });
  it('formats ratios', () => {
    expect(formatRatio(2.43)).toBe('2.4× Radar');
    expect(formatRatio(0.5)).toBe('0.50× Radar');
    expect(formatRatio(12.2)).toBe('12× Radar');
    expect(formatRatio(null)).toBe('no Radar baseline');
  });
});
