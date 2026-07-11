import { describe, it, expect } from 'vitest';
import { isAgentOnline, countAgentsOnline } from './agent-status';

// Regression coverage for the ModuleHub/StatGrid "agents online" divergence
// (design-review finding, 2026-07-11): ModuleHub previously filtered on a
// stricter healthy|running|active allowlist while StatGrid used
// status !== 'error'. This file locks in status !== 'error' as the one
// true definition for both isAgentOnline and countAgentsOnline.

describe('isAgentOnline', () => {
  it('is false for status "error"', () => {
    expect(isAgentOnline({ status: 'error' })).toBe(false);
  });

  it.each([
    'healthy',
    'running',
    'active',
    'idle',
    'degraded',
  ])('is true for status %j (anything but error)', (status) => {
    expect(isAgentOnline({ status })).toBe(true);
  });

  it('is true for an unrecognized/future status string (fail open, not closed)', () => {
    expect(isAgentOnline({ status: 'some_future_status' })).toBe(true);
  });
});

describe('countAgentsOnline', () => {
  it('returns 0 for an empty array', () => {
    expect(countAgentsOnline([])).toBe(0);
  });

  it('returns 0 when every agent is in error', () => {
    expect(countAgentsOnline([
      { status: 'error' },
      { status: 'error' },
    ])).toBe(0);
  });

  it('counts a mixed array correctly', () => {
    const agents = [
      { status: 'active' },
      { status: 'error' },
      { status: 'idle' },
      { status: 'running' },
      { status: 'error' },
    ];
    expect(countAgentsOnline(agents)).toBe(3);
  });

  it('treats healthy/running/active/idle as an identical online set — the regression this fix targets', () => {
    // Before the fix, ModuleHub's stricter healthy|running|active-only
    // filter would have excluded 'idle' agents, disagreeing with
    // StatGrid's status !== 'error' count over the same array. Both
    // surfaces now go through this one function, so 'idle' must count
    // as online exactly like the others.
    const healthyRunningActive = [
      { status: 'healthy' },
      { status: 'running' },
      { status: 'active' },
    ];
    const withIdleSwappedIn = [
      { status: 'idle' },
      { status: 'running' },
      { status: 'active' },
    ];
    expect(countAgentsOnline(healthyRunningActive)).toBe(3);
    expect(countAgentsOnline(withIdleSwappedIn)).toBe(3);
    expect(countAgentsOnline(healthyRunningActive)).toBe(countAgentsOnline(withIdleSwappedIn));
  });

  it('does not count "degraded" as offline', () => {
    expect(countAgentsOnline([{ status: 'degraded' }, { status: 'error' }])).toBe(1);
  });
});
