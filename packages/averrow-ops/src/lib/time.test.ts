import { describe, it, expect } from 'vitest';
import { relativeTime, isFuture, formatDuration, formatSpan } from './time';

describe('relativeTime', () => {
  it('returns "Never" for null', () => {
    expect(relativeTime(null)).toBe('Never');
  });

  it('returns "just now" for recent times', () => {
    const now = new Date().toISOString();
    expect(relativeTime(now)).toBe('just now');
  });

  it('returns minutes for times within an hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours for times within a day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days for older times', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(twoDaysAgo)).toBe('2d ago');
  });

  it('handles boundary between minutes and hours', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(relativeTime(oneHourAgo)).toBe('1h ago');
  });

  it('handles boundary between seconds and minutes', () => {
    const oneMinAgo = new Date(Date.now() - 61 * 1000).toISOString();
    expect(relativeTime(oneMinAgo)).toBe('1m ago');
  });

  it('handles boundary between hours and days', () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(oneDayAgo)).toBe('1d ago');
  });
});

describe('relativeTime — future dates', () => {
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

  it('returns "just now" for dates less than a minute ahead (clock skew)', () => {
    expect(relativeTime(inMs(30 * 1000))).toBe('just now');
  });

  it('returns "in Nm" for minutes ahead', () => {
    expect(relativeTime(inMs(5 * 60 * 1000 + 5000))).toBe('in 5m');
  });

  it('returns "in Nh" for hours ahead', () => {
    expect(relativeTime(inMs(3 * 60 * 60 * 1000 + 5000))).toBe('in 3h');
  });

  it('returns "in Nd" for days ahead', () => {
    expect(relativeTime(inMs(2 * 24 * 60 * 60 * 1000 + 5000))).toBe('in 2d');
  });

  it('returns months/years ahead', () => {
    expect(relativeTime(inMs(60 * 24 * 60 * 60 * 1000 + 5000))).toBe('in 2mo');
    expect(relativeTime(inMs(400 * 24 * 60 * 60 * 1000))).toBe('in 1y');
  });

  it('treats a bare D1 timestamp as UTC for future dates', () => {
    const d = new Date(Date.now() + 2 * 60 * 60 * 1000 + 5000);
    const bare = d.toISOString().slice(0, 19).replace('T', ' ');
    expect(relativeTime(bare)).toBe('in 2h');
  });

  it('keeps past output unchanged for months/years', () => {
    expect(relativeTime(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())).toBe('2mo ago');
    expect(relativeTime(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString())).toBe('1y ago');
  });
});

describe('isFuture', () => {
  it('is false for null', () => expect(isFuture(null)).toBe(false));
  it('is true for a future date', () => expect(isFuture(new Date(Date.now() + 60_000).toISOString())).toBe(true));
  it('is false for a past date', () => expect(isFuture(new Date(Date.now() - 60_000).toISOString())).toBe(false));
});

describe('formatDuration', () => {
  it('returns "-" for null', () => {
    expect(formatDuration(null)).toBe('-');
  });

  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(2500)).toBe('2.5s');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('-');
  });

  it('formats exactly 1 second', () => {
    expect(formatDuration(1000)).toBe('1.0s');
  });

  it('formats sub-second values', () => {
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(999)).toBe('999ms');
  });
});

describe('formatSpan', () => {
  it('formats minutes, hours and days', () => {
    expect(formatSpan(38 * 60_000)).toBe('38m');
    expect(formatSpan((5 * 60 + 12) * 60_000)).toBe('5h 12m');
    expect(formatSpan((3 * 24 + 4) * 3_600_000)).toBe('3d 4h');
  });
});
