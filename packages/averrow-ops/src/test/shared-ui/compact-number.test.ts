import { describe, it, expect } from 'vitest';
import { formatCompact, formatFull, COMPACT_FROM } from '@averrow/shared/ui';

describe('compact number formatting', () => {
  it('keeps numbers below the threshold exact and grouped', () => {
    expect(COMPACT_FROM).toBe(10_000);
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(9876)).toBe('9,876');
    expect(formatCompact(9999)).toBe('9,999');
  });

  it('compacts from 10,000 up, one decimal at most', () => {
    expect(formatCompact(10_000)).toBe('10K');
    expect(formatCompact(76_712)).toBe('76.7K');
    expect(formatCompact(113_258)).toBe('113.3K');
    expect(formatCompact(1_234_567)).toBe('1.2M');
    expect(formatCompact(2_000_000_000)).toBe('2B');
  });

  it('handles negatives and non-finite input', () => {
    expect(formatCompact(-76_712)).toBe('-76.7K');
    expect(formatCompact(Number.NaN)).toBe('—');
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatFull(Number.NaN)).toBe('—');
  });

  it('formatFull is the whole grouped number (the title / screen-reader text)', () => {
    expect(formatFull(76_712)).toBe('76,712');
    expect(formatFull(1_234_567)).toBe('1,234,567');
  });
});
