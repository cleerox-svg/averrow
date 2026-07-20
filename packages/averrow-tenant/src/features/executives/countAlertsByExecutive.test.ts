import { describe, it, expect } from 'vitest';
import { countAlertsByExecutive } from './Executives';

// design-review FIX J: countAlertsByExecutive parses `details` JSON out of
// an already-fetched alert list (client-side, since the alerts API has no
// executive_id filter — see Executives.tsx module header). Covers the
// malformed/missing-details cases that would otherwise silently corrupt
// the per-executive alert-count badges.

describe('countAlertsByExecutive', () => {
  it('counts one alert per executive_id', () => {
    const alerts = [
      { details: JSON.stringify({ executive_id: 'e1' }) },
      { details: JSON.stringify({ executive_id: 'e1' }) },
      { details: JSON.stringify({ executive_id: 'e2' }) },
    ];
    expect(countAlertsByExecutive(alerts)).toEqual({ e1: 2, e2: 1 });
  });

  it('returns an empty map for an empty list', () => {
    expect(countAlertsByExecutive([])).toEqual({});
  });

  it('skips a row with details: null', () => {
    const alerts = [
      { details: null },
      { details: JSON.stringify({ executive_id: 'e1' }) },
    ];
    expect(countAlertsByExecutive(alerts)).toEqual({ e1: 1 });
  });

  it('skips a row whose details is not valid JSON', () => {
    const alerts = [
      { details: 'not json {' },
      { details: JSON.stringify({ executive_id: 'e1' }) },
    ];
    expect(countAlertsByExecutive(alerts)).toEqual({ e1: 1 });
  });

  it('skips a row whose details JSON has no executive_id', () => {
    const alerts = [
      { details: JSON.stringify({ score: 0.9 }) },
      { details: JSON.stringify({ executive_id: 'e1' }) },
    ];
    expect(countAlertsByExecutive(alerts)).toEqual({ e1: 1 });
  });

  it('skips a row whose executive_id is not a string', () => {
    const alerts = [
      { details: JSON.stringify({ executive_id: 42 }) },
      { details: JSON.stringify({ executive_id: null }) },
      { details: JSON.stringify({ executive_id: 'e1' }) },
    ];
    expect(countAlertsByExecutive(alerts)).toEqual({ e1: 1 });
  });

  it('skips a row whose executive_id is an empty string', () => {
    const alerts = [
      { details: JSON.stringify({ executive_id: '' }) },
      { details: JSON.stringify({ executive_id: 'e1' }) },
    ];
    expect(countAlertsByExecutive(alerts)).toEqual({ e1: 1 });
  });

  it('one malformed row does not break counting of the rest', () => {
    const alerts = [
      { details: JSON.stringify({ executive_id: 'e1' }) },
      { details: '{{{not json' },
      { details: null },
      { details: JSON.stringify({ executive_id: 'e1' }) },
      { details: JSON.stringify({ executive_id: 'e2' }) },
    ];
    expect(countAlertsByExecutive(alerts)).toEqual({ e1: 2, e2: 1 });
  });
});
