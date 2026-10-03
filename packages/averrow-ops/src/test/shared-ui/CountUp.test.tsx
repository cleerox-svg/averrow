import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { StatTile } from '@averrow/shared/ui';
import { stubMatchMedia } from './helpers';

// useCountUp is exercised through StatTile, its only consumer in the kit.
const shown = () => Number(screen.getByText(/^[\d,]+$/).textContent!.replace(/,/g, ''));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('useCountUp (via StatTile)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  it('first mount animates up from 0', () => {
    stubMatchMedia(false);
    render(<StatTile label="Threats" value={1000} />);
    advance(16);
    expect(shown()).toBeLessThan(1000);
    advance(2000);
    expect(shown()).toBe(1000);
  });

  it('a new target continues from the displayed value and never drops below it', () => {
    stubMatchMedia(false);
    const { rerender } = render(<StatTile label="Threats" value={1000} />);
    advance(2000);
    expect(shown()).toBe(1000);

    rerender(<StatTile label="Threats" value={1500} />);
    let prev = 1000;
    for (let i = 0; i < 100; i++) {
      advance(16);
      const v = shown();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(shown()).toBe(1500);
  });

  it('retargeting mid-animation does not snap back toward 0', () => {
    stubMatchMedia(false);
    const { rerender } = render(<StatTile label="Threats" value={1000} />);
    advance(400);
    const mid = shown();
    expect(mid).toBeGreaterThan(0);
    rerender(<StatTile label="Threats" value={2000} />);
    advance(16);
    expect(shown()).toBeGreaterThanOrEqual(mid);
    advance(2000);
    expect(shown()).toBe(2000);
  });

  it('reduced motion jumps straight to each target', () => {
    stubMatchMedia(true);
    const { rerender } = render(<StatTile label="Threats" value={1000} />);
    expect(shown()).toBe(1000);
    rerender(<StatTile label="Threats" value={1500} />);
    expect(shown()).toBe(1500);
  });
});
