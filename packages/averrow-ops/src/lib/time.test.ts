import { describe, it, expect } from 'vitest';
import { relativeTime, formatDuration } from './time';

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
