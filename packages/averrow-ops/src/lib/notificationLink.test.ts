import { describe, it, expect } from 'vitest';
import { resolveNotificationLink } from './notificationLink';

// Stored links may carry a legacy /v2 prefix (before the 2026-11-15 move to /ops);
// both are stripped so old stored notifications still open the right page.
const FB = '/notifications';
const r = (l: string | null | undefined) => resolveNotificationLink(l, FB);

describe('resolveNotificationLink', () => {
  it.each([
    ['/admin/operations?tab=feeds', '/admin/operations?tab=feeds'],
    ['/v2/feeds', '/feeds'],
    ['/v2', '/'],
    ['/v2/', '/'],
    ['/v2?x=1', '/?x=1'],
    ['/v2#a', '/#a'],
    ['/providers/p1', '/providers/p1'],
    ['  /v2/feeds  ', '/feeds'],
    ['/v2x/feeds', '/v2x/feeds'],
    // current mount prefix
    ['/ops/feeds', '/feeds'],
    ['/ops', '/'],
    ['/ops/', '/'],
    ['/ops?x=1', '/?x=1'],
    ['/opsx/feeds', '/opsx/feeds'],
  ])('keeps safe link %j -> %j', (input, out) => {
    expect(r(input)).toBe(out);
  });

  it.each([
    '//h', '/ops//h', '/ops/\\h', '/v2//h', ' /v2//h', '/\\h', '/v2/\\h', 'javascript:alert(1)', 'https://x', '%2F%2Fh',
    '/a\tb', '/a\nb', '/v2/\t/h', 'feeds', '',
  ])('falls back for unsafe link %j', (input) => {
    expect(r(input)).toBe(FB);
  });

  it('falls back for null / undefined', () => {
    expect(r(null)).toBe(FB);
    expect(r(undefined)).toBe(FB);
  });
});
