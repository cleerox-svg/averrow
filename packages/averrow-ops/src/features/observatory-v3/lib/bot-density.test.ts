import { describe, it, expect } from 'vitest';
import {
  botColor, botRadius, botDensityTooltip, buildBotDensityPoints, botDensityDomain,
  parseCssColor, isAboveAverage, formatPct, RING_COLOR, OUTLINE_COLOR, resolveScaleStops, formatBotShare, resolveGlobalAvg,
} from './bot-density';

describe('botColor', () => {
  it('hits the low / mid / high stops', () => {
    expect(botColor(10, 10, 50)).toEqual([96, 165, 250, 230]);
    expect(botColor(30, 10, 50)).toEqual([229, 168, 50, 230]);
    expect(botColor(50, 10, 50)).toEqual([248, 113, 113, 240]);
  });
  it('clamps and handles a degenerate domain', () => {
    expect(botColor(-5, 10, 50)).toEqual(botColor(10, 10, 50));
    expect(botColor(99, 10, 50)).toEqual(botColor(50, 10, 50));
    expect(botColor(20, 20, 20)).toEqual([229, 168, 50, 230]);
  });
});

describe('botRadius', () => {
  it('scales with sqrt and clamps to [min, max]', () => {
    expect(botRadius(0, 10)).toBe(5);
    expect(botRadius(10, 10)).toBe(30);
    expect(botRadius(2.5, 10)).toBeCloseTo(5 + 25 * 0.5);
    expect(botRadius(50, 10)).toBe(30);
    expect(botRadius(5, 0)).toBe(5);
  });
});

describe('tooltip + helpers', () => {
  const d = { code: 'DE', name: 'Germany', bot_pct: 31.24, traffic_pct: 4.8, rank: 3 };
  it('formats the tooltip', () => {
    expect(botDensityTooltip(d, 29.5)).toBe(
      'Germany (DE) — Bot share 31.2% of its traffic · 4.8% of global traffic · global avg 29.5%',
    );
    expect(botDensityTooltip(d, null)).not.toContain('global avg');
    expect(formatPct(0.04)).toBe('<0.1%');
  });
  it('flags above-average countries', () => {
    expect(isAboveAverage(31, 29.5)).toBe(true);
    expect(isAboveAverage(29, 29.5)).toBe(false);
    expect(isAboveAverage(99, null)).toBe(false);
    expect(isAboveAverage(35, 29.5, 'lower')).toBe(true);
    expect(isAboveAverage(20, 29.5, 'lower')).toBe(false);
    expect(isAboveAverage(20, 29.5, 'upper')).toBe(false);
    // A ceiling above the average proves nothing.
    expect(isAboveAverage(35, 29.5, 'upper')).toBe(false);
    expect(isAboveAverage(Number.NaN, 29.5)).toBe(false);
    expect(isAboveAverage(40, Number.NaN)).toBe(false);
  });
  it('parses css colours', () => {
    expect(parseCssColor('#E5A832')).toEqual([229, 168, 50]);
    expect(parseCssColor(' #fff ')).toEqual([255, 255, 255]);
    expect(parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30]);
    expect(parseCssColor('nope')).toBeNull();
  });
});

describe('buildBotDensityPoints', () => {
  it('skips countries without a centroid and computes the domain', () => {
    const pts = buildBotDensityPoints([
      { code: 'US', name: 'United States', bot_pct: 40, traffic_pct: 20, rank: 1 },
      { code: 'ZZ', name: 'Nowhere', bot_pct: 90, traffic_pct: 1, rank: 2 },
      { code: 'DE', name: 'Germany', bot_pct: 20, traffic_pct: 5, rank: 3 },
    ]);
    expect(pts.map(p => p.code)).toEqual(['US', 'DE']);
    expect(botDensityDomain(pts)).toEqual({ minBot: 20, maxBot: 40, maxTraffic: 20 });
    expect(buildBotDensityPoints(null)).toEqual([]);
  });
});

describe('fixed map colours', () => {
  it('uses a light ring and a faint outline independent of theme', () => {
    expect(RING_COLOR).toEqual([255, 255, 255, 235]);
    expect(OUTLINE_COLOR[3]).toBeLessThan(RING_COLOR[3]);
  });
  it('falls back to the lighter critical high stop without a DOM', () => {
    const stops = resolveScaleStops();
    expect(stops[2]).toEqual([248, 113, 113, 240]);
  });
});

describe('bounds and global average', () => {
  it('prefixes estimate bounds', () => {
    expect(formatBotShare(12, 'lower')).toBe('≥ 12.0%');
    expect(formatBotShare(12, 'upper')).toBe('≤ 12.0%');
    expect(formatBotShare(12, null)).toBe('12.0%');
    expect(formatBotShare(12)).toBe('12.0%');
  });
  it('tooltip carries the bound', () => {
    const d = { code: 'DE', name: 'Germany', bot_pct: 31.24, traffic_pct: 4.8, rank: 3, bound: 'lower' as const };
    expect(botDensityTooltip(d, null)).toContain('Bot share ≥ 31.2%');
  });
  it('prefers bot_density_global_pct, falls back to latest', () => {
    expect(resolveGlobalAvg({ bot_density_global_pct: 30, latest: { bot_pct: 31 } })).toBe(30);
    expect(resolveGlobalAvg({ latest: { bot_pct: 31 } })).toBe(31);
    expect(resolveGlobalAvg({ bot_density_global_pct: null, latest: { bot_pct: 31 } })).toBe(31);
    expect(resolveGlobalAvg({ latest: null })).toBeNull();
    expect(resolveGlobalAvg(undefined)).toBeNull();
  });
});
