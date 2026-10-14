import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AnimationClock } from '../lib/animation-clock';
import { useDeckFrame, type DeckFrame } from './use-deck-frame';

// ─── Fake rAF ───────────────────────────────────────────────
let callbacks = new Map<number, FrameRequestCallback>();
let nextId = 1;
let now = 0;

function pumpFrame(dtMs = 16) {
  now += dtMs;
  const pending = [...callbacks.entries()];
  callbacks = new Map();
  act(() => { for (const [, cb] of pending) cb(now); });
}
const pending = () => callbacks.size;

// ─── Environment stubs ──────────────────────────────────────
function stubMotion(reduced: boolean) {
  let listener: ((e: MediaQueryListEvent) => void) | null = null;
  const mql = {
    matches: reduced,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { listener = cb; },
    removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return (matches: boolean) => { mql.matches = matches; act(() => listener?.({ matches } as MediaQueryListEvent)); };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

let ioCallback: IntersectionObserverCallback | null = null;
function stubIntersectionObserver() {
  ioCallback = null;
  class FakeIO {
    constructor(cb: IntersectionObserverCallback) { ioCallback = cb; }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);
}
function setIntersecting(isIntersecting: boolean) {
  act(() => ioCallback?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
}

beforeEach(() => {
  callbacks = new Map();
  nextId = 1;
  now = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextId++; callbacks.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id); });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  stubMotion(false);
  setHidden(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setHidden(false);
});

const newClock = () => new AnimationClock({ cycleLength: 3600, unitsPerSecond: 60 });

describe('useDeckFrame', () => {
  it('drives onFrame once per animation frame with the clock playhead', () => {
    const clock = newClock();
    const onFrame = vi.fn();
    const { result } = renderHook(() => useDeckFrame(clock, true, onFrame));
    expect(result.current.running).toBe(true);
    expect(onFrame).not.toHaveBeenCalled();

    pumpFrame(); // baseline tick
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toBe(0);

    pumpFrame(100); // 0.1s at 60 u/s = 6 units
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[1]![0]).toBeCloseTo(6, 6);
    expect(pending()).toBe(1); // exactly one loop alive
  });

  it('reports monotonic seconds + dt in the frame info, independent of clock speed', () => {
    const clock = newClock();
    clock.setSpeed(4);
    const frames: Array<{ t: number; seconds: number; dt: number }> = [];
    renderHook(() => useDeckFrame(clock, true, (t, f: DeckFrame) => frames.push({ t, seconds: f.seconds, dt: f.dt })));
    pumpFrame(); pumpFrame(50); pumpFrame(50);
    expect(frames.map(f => f.dt)).toEqual([0, 0.05, 0.05]);
    expect(frames[2]!.seconds).toBeCloseTo(0.1, 10);
    expect(frames[2]!.t).toBeCloseTo(24, 6); // 0.1s * 60 * speed 4
  });

  it('clamps huge frame gaps (GC pause / throttled tab)', () => {
    const clock = newClock();
    const seconds: number[] = [];
    renderHook(() => useDeckFrame(clock, true, (_t, f) => seconds.push(f.seconds)));
    pumpFrame(); pumpFrame(5000);
    expect(seconds[1]).toBeCloseTo(0.1, 10);
  });

  it('does not start when disabled, and stops when disabled later', () => {
    const clock = newClock();
    const onFrame = vi.fn();
    const { rerender, result } = renderHook(({ on }) => useDeckFrame(clock, on, onFrame), { initialProps: { on: false } });
    expect(result.current.running).toBe(false);
    expect(pending()).toBe(0);

    rerender({ on: true });
    expect(pending()).toBe(1);
    pumpFrame();
    expect(onFrame).toHaveBeenCalledTimes(1);

    rerender({ on: false });
    expect(pending()).toBe(0);
    pumpFrame();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden and resumes (without replaying the gap) when visible', () => {
    const clock = newClock();
    const onFrame = vi.fn();
    const { result } = renderHook(() => useDeckFrame(clock, true, onFrame));
    pumpFrame(); pumpFrame(16);
    const before = clock.currentTime;

    setHidden(true);
    expect(result.current.running).toBe(false);
    expect(pending()).toBe(0);

    now += 60_000; // a minute passes in the background
    setHidden(false);
    expect(result.current.running).toBe(true);
    expect(pending()).toBe(1);
    pumpFrame(); // baseline after resync
    pumpFrame(16);
    expect(clock.currentTime - before).toBeLessThan(2); // ~1 frame of movement, not 60s
  });

  it('pauses while the target is scrolled out of view', () => {
    stubIntersectionObserver();
    const clock = newClock();
    const el = document.createElement('div');
    const ref = { current: el };
    const onFrame = vi.fn();
    const { result } = renderHook(() => useDeckFrame(clock, true, onFrame, { targetRef: ref }));
    expect(result.current.running).toBe(true);

    setIntersecting(false);
    expect(result.current.running).toBe(false);
    expect(pending()).toBe(0);

    setIntersecting(true);
    expect(result.current.running).toBe(true);
    expect(pending()).toBe(1);
  });

  it('never runs under prefers-reduced-motion, and reports it', () => {
    stubMotion(true);
    const clock = newClock();
    const onFrame = vi.fn();
    const { result } = renderHook(() => useDeckFrame(clock, true, onFrame));
    expect(result.current).toEqual({ running: false, reducedMotion: true });
    expect(pending()).toBe(0);
    pumpFrame();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('reacts live when the OS reduced-motion setting flips', () => {
    const flip = stubMotion(false);
    const clock = newClock();
    const { result } = renderHook(() => useDeckFrame(clock, true, vi.fn()));
    expect(result.current.running).toBe(true);
    flip(true);
    expect(result.current.running).toBe(false);
    expect(pending()).toBe(0);
    flip(false);
    expect(result.current.running).toBe(true);
    expect(pending()).toBe(1);
  });

  it('a new onFrame identity on re-render does NOT restart the loop and the latest one is called', () => {
    const clock = newClock();
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = renderHook(({ cb }) => useDeckFrame(clock, true, cb), { initialProps: { cb: a } });
    const id = [...callbacks.keys()][0];
    rerender({ cb: b });
    expect([...callbacks.keys()][0]).toBe(id); // same pending rAF
    pumpFrame();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('seconds persist across a pause/resume so ring timestamps stay in one domain', () => {
    const clock = newClock();
    const seconds: number[] = [];
    const { rerender } = renderHook(({ on }) => useDeckFrame(clock, on, (_t, f) => seconds.push(f.seconds)), { initialProps: { on: true } });
    pumpFrame(); pumpFrame(100);
    rerender({ on: false });
    rerender({ on: true });
    pumpFrame(); pumpFrame(100);
    expect(seconds[2]).toBeCloseTo(seconds[1]!, 10); // first frame after resume: dt 0
    expect(seconds[3]).toBeCloseTo(0.2, 10);
  });

  it('keeps the clock paused when the clock itself is paused, but still calls onFrame (pulses keep breathing)', () => {
    const clock = newClock();
    clock.pause();
    const frames: number[] = [];
    renderHook(() => useDeckFrame(clock, true, (t) => frames.push(t)));
    pumpFrame(); pumpFrame(100);
    expect(frames).toEqual([0, 0]);
  });

  it('cancels the pending frame on unmount', () => {
    const clock = newClock();
    const { unmount } = renderHook(() => useDeckFrame(clock, true, vi.fn()));
    expect(pending()).toBe(1);
    unmount();
    expect(pending()).toBe(0);
  });
});
