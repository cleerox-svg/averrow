import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { StatTile } from '@averrow/shared/ui';
import { useCountUp } from '../../../../shared/src/ui/lib/useCountUp';
import { stubMatchMedia } from './helpers';

// BRAND_BRIEF §4: "Data reads first: values render immediately." StatTile no
// longer counts up, with or without reduced motion.
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('StatTile value (no count-up)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  it('renders the final value on first paint when motion is allowed', () => {
    stubMatchMedia(false);
    render(<StatTile label="Threats" value={1000} />);
    expect(screen.getByText('1,000')).toBeInTheDocument();
  });

  it('schedules no animation frames', () => {
    stubMatchMedia(false);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<StatTile label="Threats" value={1000} />);
    advance(2000);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it('a new value replaces the old one immediately', () => {
    stubMatchMedia(false);
    const { rerender } = render(<StatTile label="Threats" value={1000} />);
    rerender(<StatTile label="Threats" value={1500} />);
    expect(screen.getByText('1,500')).toBeInTheDocument();
    rerender(<StatTile label="Threats" value={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('is the same under reduced motion', () => {
    stubMatchMedia(true);
    const { rerender } = render(<StatTile label="Threats" value={1000} />);
    expect(screen.getByText('1,000')).toBeInTheDocument();
    rerender(<StatTile label="Threats" value={1500} />);
    expect(screen.getByText('1,500')).toBeInTheDocument();
  });

  it('compact values render their final form immediately', () => {
    stubMatchMedia(false);
    render(<StatTile label="Threats" value={76700} compact />);
    expect(screen.getByText('76.7K')).toBeInTheDocument();
  });
});

// The hook stays available for an explicit opt-in; nothing in the kit calls it.
describe('useCountUp (retained, opt-in)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  it('animates up from 0 when motion is allowed', () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useCountUp(1000));
    advance(16);
    expect(result.current).toBeLessThan(1000);
    advance(2000);
    expect(result.current).toBe(1000);
  });

  it('returns the target at once under reduced motion', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useCountUp(1000));
    expect(result.current).toBe(1000);
  });
});
