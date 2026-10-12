import { describe, it, expect } from 'vitest';
import {
  botColor, botRadius, botDensityTooltip, buildBotDensityPoints, botDensityDomain,
  parseCssColor, isAboveAverage, formatPct,
} from './bot-density';

describe('botColor', () => {
  it('hits the low / mid / high stops', () => {
    expect(botColor(10, 10, 50)).toEqual([96, 165, 250, 230]);
    expect(botColor(30, 10, 50)).toEqual([229, 168, 50, 230]);
    expect(botColor(50, 10, 50)).toEqual([200, 60, 60, 240]);
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
