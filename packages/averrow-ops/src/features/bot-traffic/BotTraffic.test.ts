import { describe, it, expect } from 'vitest';
import { humanizeCategory, staleAsOf } from './BotTraffic';
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
