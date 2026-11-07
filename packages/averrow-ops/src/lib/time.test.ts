import { describe, it, expect } from 'vitest';
import { relativeTime, relativeTimeSigned, isFuture, formatDuration, formatSpan } from './time';

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

describe('relativeTime — past-only contract', () => {
  it('reads "just now" for a future timestamp (client clock behind server)', () => {
    expect(relativeTime(new Date(Date.now() + 3 * 60 * 1000).toISOString())).toBe('just now');
  });

  it('keeps past output unchanged for months/years', () => {
    expect(relativeTime(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())).toBe('2mo ago');
    expect(relativeTime(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString())).toBe('1y ago');
  });
});

describe('relativeTimeSigned', () => {
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('returns "Never" for null', () => {
    expect(relativeTimeSigned(null)).toBe('Never');
  });

  it('matches relativeTime for past dates', () => {
    expect(relativeTimeSigned(inMs(-5 * MIN))).toBe('5m ago');
    expect(relativeTimeSigned(inMs(-3 * HOUR))).toBe('3h ago');
    expect(relativeTimeSigned(inMs(-2 * DAY))).toBe('2d ago');
  });

  it('reads "just now" within a minute either side', () => {
    expect(relativeTimeSigned(inMs(-30 * 1000))).toBe('just now');
    expect(relativeTimeSigned(inMs(30 * 1000))).toBe('just now');
  });

  it('returns "in Nm" / "in Nh" / "in Nd" ahead', () => {
    expect(relativeTimeSigned(inMs(5 * MIN - 2000))).toBe('in 5m');
    expect(relativeTimeSigned(inMs(3 * HOUR - 2000))).toBe('in 3h');
    expect(relativeTimeSigned(inMs(2 * DAY - 2000))).toBe('in 2d');
  });

  it('rounds future values up so a fresh 7-day expiry reads "in 7d"', () => {
    expect(relativeTimeSigned(inMs(7 * DAY - 2000))).toBe('in 7d');
  });

  it('crosses the minute→hour boundary at 60m', () => {
    expect(relativeTimeSigned(inMs(59 * MIN - 2000))).toBe('in 59m');
    expect(relativeTimeSigned(inMs(HOUR - 2000))).toBe('in 1h');
  });

  it('returns months/years ahead', () => {
    expect(relativeTimeSigned(inMs(60 * DAY - 2000))).toBe('in 2mo');
    expect(relativeTimeSigned(inMs(400 * DAY))).toBe('in 1y');
  });

  it('treats a bare D1 timestamp as UTC', () => {
    // Bare timestamps drop milliseconds; 30s of slack keeps the bucket stable.
    const d = new Date(Date.now() + 2 * HOUR - 30 * 1000);
    const bare = d.toISOString().slice(0, 19).replace('T', ' ');
    expect(relativeTimeSigned(bare)).toBe('in 2h');
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
