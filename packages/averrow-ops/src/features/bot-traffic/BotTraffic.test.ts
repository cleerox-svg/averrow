import { describe, it, expect } from 'vitest';
import { humanizeCategory } from './BotTraffic';
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
