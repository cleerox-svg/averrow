import { describe, it, expect } from 'vitest';
import { humanizeCategory, staleAsOf, absoluteBarWidth, isAboveAverage } from './BotTraffic';
import { tabUrl } from '@/lib/workspaceRoutes';

describe('humanizeCategory', () => {
  it('humanizes verified-bot categories', () => {
    expect(humanizeCategory('AI_CRAWLER')).toBe('AI crawler');
    expect(humanizeCategory('SEARCH_ENGINE_CRAWLER')).toBe('Search engine crawler');
    expect(humanizeCategory('SEO_TOOL')).toBe('SEO tool');
    expect(humanizeCategory('CDN_RSS_API')).toBe('CDN RSS API');
    expect(humanizeCategory('')).toBe('');
  });
});

describe('bot-traffic deep link', () => {
  it('resolves to the coverage workspace tab', () => {
    expect(tabUrl('bot-traffic')).toBe('/coverage?tab=bot-traffic');
  });
});

describe('staleAsOf', () => {
  const base = { bot_share: '2026-10-12', top_locations: '2026-10-12', top_asns: '2026-10-09', categories: null };
  it('returns the section date only when it differs from bot_share', () => {
    expect(staleAsOf(base, 'top_asns')).toBe('2026-10-09');
    expect(staleAsOf(base, 'top_locations')).toBeNull();
  });
  it('is null when the section date is missing', () => {
    expect(staleAsOf(base, 'categories')).toBeNull();
  });
  it('tolerates an absent or partial as_of (old cached payload)', () => {
    expect(staleAsOf(undefined, 'top_asns')).toBeNull();
    expect(staleAsOf(null, 'top_asns')).toBeNull();
    expect(staleAsOf({ top_asns: '2026-10-09' }, 'top_asns')).toBeNull();
  });
});

describe('staleAsOf for new sections', () => {
  const asOf = { bot_share: '2026-10-12', bot_density: '2026-10-11', attack_origins: '2026-10-12', attack_targets: null };
  it('flags only differing, present dates', () => {
    expect(staleAsOf(asOf, 'bot_density')).toBe('2026-10-11');
    expect(staleAsOf(asOf, 'attack_origins')).toBeNull();
    expect(staleAsOf(asOf, 'attack_targets')).toBeNull();
    expect(staleAsOf({ bot_share: '2026-10-12' }, 'bot_density')).toBeNull();
  });
});

describe('isAboveAverage', () => {
  it('is strictly above the global average', () => {
    expect(isAboveAverage(40, 31.2)).toBe(true);
    expect(isAboveAverage(31.2, 31.2)).toBe(false);
    expect(isAboveAverage(10, 31.2)).toBe(false);
  });
  it('is false for non-finite input', () => {
    expect(isAboveAverage(Number.NaN, 31.2)).toBe(false);
    expect(isAboveAverage(40, Number.NaN)).toBe(false);
  });
});

describe('absoluteBarWidth', () => {
  it('scales on 0-100 and clamps', () => {
    expect(absoluteBarWidth(50)).toBe(50);
    expect(absoluteBarWidth(150)).toBe(100);
    expect(absoluteBarWidth(-5)).toBe(0);
    expect(absoluteBarWidth(0)).toBe(0);
    expect(absoluteBarWidth(Number.NaN)).toBe(0);
  });
  it('gives non-zero values a visible minimum', () => {
    expect(absoluteBarWidth(0.5)).toBe(2);
  });
});
