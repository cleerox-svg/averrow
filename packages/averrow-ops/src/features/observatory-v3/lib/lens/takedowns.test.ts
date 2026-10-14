import { describe, it, expect } from 'vitest';
import type { TakedownGeoRow } from '@/hooks/useObservatoryLenses';
import { buildHostingModel } from './hosting';
import {
  TAKEDOWN_MIN_RESOLVED, TAKEDOWN_STOPS, TAKEDOWN_SMALL_COLOR, buildTakedownCountryModel, buildTakedownProviderModel,
  formatHours, hasRate, pct, rankHardest, resolvedOf, takedownColor, takedownFacts, takedownOutline, TAKEDOWN_OUTLINE_ALPHA,
} from './takedowns';
import { SEVERITY_COLORS } from '../map-colors';

const row = (key: string, td: number, refused: number, expired: number, over: Partial<TakedownGeoRow> = {}): TakedownGeoRow => {
  const resolved = td + refused + expired;
  return {
    key, label: key, country: key.length === 2 ? key : 'NL', lat: 1, lng: 2, submitted: resolved + 3, taken_down: td, refused, expired, pending: 3,
    share: resolved > 0 ? td / resolved : null, median_hours: td > 0 ? 20 : null, ...over,
  };
};

describe('the n threshold', () => {
  it('a rate needs TAKEDOWN_MIN_RESOLVED resolved takedowns (taken down + refused + expired), not submitted ones', () => {
    expect(hasRate(row('US', 4, 0, 0))).toBe(false);                                   // 100% of 4: noise
    expect(hasRate(row('US', 2, 2, 0))).toBe(false);                                   // 4 resolved
    expect(hasRate(row('US', 3, 1, 1))).toBe(TAKEDOWN_MIN_RESOLVED <= 5);              // exactly the threshold
    expect(hasRate(row('US', 5, 0, 0))).toBe(true);
    expect(hasRate(row('US', 0, 0, 0, { submitted: 500 }))).toBe(false);               // lots submitted, none resolved: share is null
    expect(resolvedOf(row('US', 3, 1, 1))).toBe(5);
  });
  it('a missing / non-finite share is never a rate', () => {
    expect(hasRate(row('US', 9, 1, 0, { share: null }))).toBe(false);
    expect(hasRate(row('US', 9, 1, 0, { share: Number.NaN }))).toBe(false);
  });
});

describe('colour scale: sequential green, grey when n is small', () => {
  it('goes dark -> bright green as the share rises (monotonic), and every stop is green-led', () => {
    const lo = takedownColor(row('A1', 0, 20, 0));
    const mid = takedownColor(row('A2', 10, 10, 0));
    const hi = takedownColor(row('A3', 20, 0, 0));
    expect(lo[1]).toBeLessThan(mid[1]);
    expect(mid[1]).toBeLessThan(hi[1]);
    for (const s of TAKEDOWN_STOPS) expect(s.color[1]).toBeGreaterThan(s.color[0]);
    expect(lo.slice(0, 3)).toEqual([...TAKEDOWN_STOPS[0]!.color.slice(0, 3)]);
    expect(hi.slice(0, 3)).toEqual([...TAKEDOWN_STOPS.at(-1)!.color.slice(0, 3)]);
  });
  it('is not the red of the severity ramp (a takedown rate is not an alarm)', () => {
    for (const s of TAKEDOWN_STOPS) expect(s.color[0]).toBeLessThan(SEVERITY_COLORS.critical![0]!);
  });
  it('a small sample is grey whatever its share', () => {
    expect(takedownColor(row('US', 3, 0, 0))).toEqual(TAKEDOWN_SMALL_COLOR);
    expect(takedownColor(row('US', 0, 0, 0))).toEqual(TAKEDOWN_SMALL_COLOR);
  });
});

describe('rankHardest', () => {
  it('lowest share first, bigger sample breaking ties, small samples left out entirely', () => {
    const r = rankHardest([
      row('AA', 8, 2, 0),      // 80%
      row('BB', 2, 8, 0),      // 20% of 10
      row('CC', 16, 64, 0),    // 20% of 80: outranks BB (bigger sample)
      row('DD', 0, 3, 0),      // 0% of 3: too small, not ranked
      row('EE', 0, 0, 0),      // nothing resolved
    ]);
    expect(r.map(x => x.key)).toEqual(['CC', 'BB', 'AA']);
  });
  it('does not mutate its input', () => {
    const input = [row('AA', 8, 2, 0), row('BB', 2, 8, 0)];
    rankHardest(input);
    expect(input.map(x => x.key)).toEqual(['AA', 'BB']);
  });
});

describe('formatting', () => {
  it('pct rounds, hours switch to days at 48h', () => {
    expect(pct(0.625)).toBe('63%');
    expect(formatHours(null)).toBeNull();
    expect(formatHours(Number.NaN)).toBeNull();
    expect(formatHours(31.4)).toBe('31h');
    expect(formatHours(72)).toBe('3.0d');
    expect(formatHours(480)).toBe('20d');
  });
  it('takedownFacts states the rate, the volume and the median, or why there is no rate', () => {
    expect(takedownFacts(row('US', 30, 10, 0))).toEqual(['75% taken down', '43 submitted · 40 resolved', 'median 20h to take down']);
    const small = takedownFacts(row('US', 1, 1, 0, { median_hours: null }));
    expect(small[0]).toBe(`too few resolved (2 of ${TAKEDOWN_MIN_RESOLVED} needed)`);
    expect(small).toHaveLength(2);
  });
});

describe('buildTakedownCountryModel', () => {
  const m = buildTakedownCountryModel([
    row('us', 30, 10, 0), row('DE', 1, 1, 0), row('RU', 2, 18, 0), row('unknown', 3, 3, 0), row('XYZ', 1, 1, 0),
  ]);
  it('keys by ISO-2, counts the unmappable (unknown / malformed) separately', () => {
    expect([...m.rows.keys()].sort()).toEqual(['DE', 'RU', 'US']);
    expect(m.unknownSubmitted).toBe(9 + 5);
    expect(m.submitted).toBeGreaterThan(m.unknownSubmitted);
  });
  it('splits countries with a rate from the too-small ones, and colours each accordingly', () => {
    expect(m.withRate).toBe(2);
    expect(m.tooSmall).toBe(1);
    expect([...m.small]).toEqual(['DE']);
    expect(m.colors.get('DE')).toEqual(TAKEDOWN_SMALL_COLOR);
    expect(m.colors.get('US')).not.toEqual(TAKEDOWN_SMALL_COLOR);
    expect(m.colors.has('FR')).toBe(false); // no takedowns at all: unfilled
  });
  it('hardest jurisdictions: lowest share with enough volume', () => {
    expect(m.hardest.map(r => r.key)).toEqual(['RU', 'US']);
  });
  it('empty input is an empty model', () => {
    const e = buildTakedownCountryModel([]);
    expect(e.rows.size).toBe(0);
    expect(e.hardest).toEqual([]);
  });
});

describe('buildTakedownProviderModel', () => {
  const prov = (id: string, active: number, country = 'NL') => ({
    id, name: `Host ${id}`, asn: 'AS1', country, active_threat_count: active, total_threat_count: active, trend_7d: 1, trend_30d: 3,
    is_bulletproof: false, reputation_score: null, takedown: { share: 0.1, median_hours: 1, n: 99 },
  });
  const hosting = buildHostingModel([prov('p1', 10), prov('p2', 5, 'US'), prov('p3', 3, 'DE')]);
  const t = buildTakedownProviderModel(hosting, [
    row('p1', 12, 8, 0), row('p2', 1, 1, 0), row('ghost', 1, 30, 0), row('unknown', 5, 5, 0),
  ]);
  it('takes each ring\'s takedown fields from takedowns-geo (the window the colours show), not providers-geo', () => {
    const p1 = t.hosting.byId.get('p1')!;
    expect(p1.takedownShare).toBeCloseTo(0.6, 9);
    expect(p1.takedownN).toBe(23);
    expect(p1.medianHours).toBe(20);
  });
  it('a ring with too few resolved takedowns has no arc and is grey; one with none at all too', () => {
    expect(t.hosting.byId.get('p2')!.takedownShare).toBeNull();
    expect(t.colors.get('p2')).toEqual(TAKEDOWN_SMALL_COLOR);
    expect(t.hosting.byId.get('p3')!.takedownShare).toBeNull();
    expect(t.hosting.byId.get('p3')!.takedownN).toBe(0);
    expect(t.colors.get('p3')).toEqual(TAKEDOWN_SMALL_COLOR);
  });
  it('lists hosts with a history but no ring (no active threats) as undrawn; unknown is never a host', () => {
    expect(t.undrawn).toBe(1);
    expect(t.hardest.map(r => r.key)).toEqual(['ghost', 'p1']);
    expect(t.withRate).toBe(2);
    expect(t.tooSmall).toBe(1);
  });
  it('leaves the source hosting model untouched (providers-geo view keeps its own numbers)', () => {
    expect(hosting.byId.get('p1')!.takedownShare).toBe(0.1);
    expect(t.hosting).not.toBe(hosting);
    expect(t.hosting.rings.map(r => r.position)).toEqual(hosting.rings.map(r => r.position));
  });
});

// ─── contrast against the dark basemap (WCAG 1.4.11 graphical objects: 3:1) ──
const lin = (c: number): number => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (c: readonly number[]): number => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
const over = (c: readonly number[], bg: readonly number[]): number[] => [0, 1, 2].map(i => c[i]! * (c[3]! / 255) + bg[i]! * (1 - c[3]! / 255));
const contrast = (a: readonly number[], b: readonly number[]): number => {
  const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
};
// The darkest to the lightest basemap the console draws on (Carto dark matter water / land, the deep-blue land of the
// style the QA harness stands in, and the lightest panel-adjacent tone).
const BASEMAPS: ReadonlyArray<readonly [number, number, number]> = [[10, 10, 10], [14, 14, 14], [28, 28, 28], [11, 18, 32], [26, 36, 54]];

describe('takedown scale is visible on the dark basemap', () => {
  it.each(TAKEDOWN_STOPS.map(s => [s.t, s.color] as const))('stop %s is at least 3:1 against every basemap tone once composited', (_t, color) => {
    for (const bg of BASEMAPS) expect(contrast(over(color, bg), bg)).toBeGreaterThanOrEqual(3);
  });
  it('still reads dark -> bright: luminance rises with every stop', () => {
    const bg = BASEMAPS[0]!;
    const ls = TAKEDOWN_STOPS.map(s => lum(over(s.color, bg)));
    for (let i = 1; i < ls.length; i++) expect(ls[i]!).toBeGreaterThan(ls[i - 1]!);
  });
  it('a rated country\'s outline is its fill hue at 60% alpha', () => {
    const fill = takedownColor(row('US', 20, 0, 0));
    expect(takedownOutline(fill)).toEqual([fill[0], fill[1], fill[2], TAKEDOWN_OUTLINE_ALPHA]);
    expect(TAKEDOWN_OUTLINE_ALPHA / 255).toBeCloseTo(0.6, 2);
  });
});

describe('country model: duplicate keys are one country', () => {
  it('sums counts, recomputes the share from the sums and keeps the larger sample\'s median', () => {
    const m = buildTakedownCountryModel([
      row('nl', 10, 0, 0, { median_hours: 12 }),     // 10 resolved
      row('NL', 10, 20, 0, { median_hours: 40 }),    // 30 resolved: the larger sample
    ]);
    expect(m.rows.size).toBe(1);
    const nl = m.rows.get('NL')!;
    expect(nl.key).toBe('NL');
    expect(nl.taken_down).toBe(20);
    expect(nl.refused).toBe(20);
    expect(resolvedOf(nl)).toBe(40);
    expect(nl.share).toBeCloseTo(0.5, 9);
    expect(nl.submitted).toBe(13 + 33);
    expect(nl.pending).toBe(6);
    expect(nl.median_hours).toBe(40);
    expect(m.withRate).toBe(1);
  });
  it('two small samples that together reach the threshold become a rate', () => {
    const m = buildTakedownCountryModel([row('de', 2, 1, 0), row('DE', 2, 0, 0)]);
    expect(m.small.has('DE')).toBe(false);
    expect(m.rows.get('DE')!.share).toBeCloseTo(0.8, 9);
  });
  it('counts every submitted takedown once in the total', () => {
    const rows = [row('nl', 10, 0, 0), row('NL', 10, 20, 0), row('unknown', 1, 1, 1)];
    expect(buildTakedownCountryModel(rows).submitted).toBe(rows.reduce((n, r) => n + r.submitted, 0));
  });
});
