import { describe, it, expect } from 'vitest';
import { SNOOZE_OPTIONS, snoozeUntilIso } from './snooze';

describe('snooze options', () => {
  it('offers 1 hour, 4 hours, 1 day and 1 week', () => {
    expect(SNOOZE_OPTIONS.map((o) => o.label)).toEqual(['1 hour', '4 hours', '1 day', '1 week']);
    expect(SNOOZE_OPTIONS.map((o) => o.hours)).toEqual([1, 4, 24, 168]);
  });

  it('computes the wake-up time from the given clock', () => {
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    expect(snoozeUntilIso(4, now)).toBe('2026-10-05T16:00:00.000Z');
  });
});
