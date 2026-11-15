import { describe, it, expect } from 'vitest';
import { getEmailStatus } from './HeroCards';

// The email posture card's SPF pill. `spf_exists` is NULL when the scan
// could not look the record up (worker migration 0332): that is unknown,
// not a missing record.
describe('EmailPostureCard SPF status', () => {
  it('spf_exists null → UNKNOWN (not checked), never MISSING', () => {
    expect(getEmailStatus('SPF', { spf_exists: null })).toEqual({ status: 'UNKNOWN', hint: 'not checked' });
  });

  it('spf_exists 0 → MISSING', () => {
    expect(getEmailStatus('SPF', { spf_exists: 0 }).status).toBe('MISSING');
  });

  it('spf_exists 1 → PASS with the all qualifier as hint', () => {
    expect(getEmailStatus('SPF', { spf_exists: 1, spf_raw: 'v=spf1 -all' })).toEqual({ status: 'PASS', hint: '-all' });
  });
});
