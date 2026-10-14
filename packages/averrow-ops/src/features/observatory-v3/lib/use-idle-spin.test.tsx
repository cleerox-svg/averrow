import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type maplibregl from 'maplibre-gl';
import { useIdleSpin, DRIFT_REFRESH_MS, SPIN_EVENT_KEY, type UseIdleSpinOptions } from './use-idle-spin';
import { SPIN_DEG_PER_S } from './spin';

// A manual frame clock: rAF callbacks queue up and `frame(ts)` runs them at that timestamp.
let queue: Array<(ts: number) => void> = [];
let now = 0;

function frame(ts: number) {
  now = ts;
  const run = queue;
  queue = [];
  act(() => { run.forEach(cb => cb(ts)); });
}

function fakeMap(opts: { moving?: boolean } = {}) {
  let center = { lng: 10, lat: 20 };
  const jumpTo = vi.fn((o: { center: [number, number] }, data?: Record<string, unknown>) => {
    center = { lng: o.center[0], lat: o.center[1] };
    return data;
  });
  const map = {
    getCenter: () => center,
    isMoving: () => opts.moving ?? false,
    jumpTo,
  };
  return { map: map as unknown as maplibregl.Map, jumpTo, lng: () => center.lng };
}

const IDLE = 1000;
function setup(over: Partial<UseIdleSpinOptions> = {}, mapOpts: { moving?: boolean } = {}) {
  const m = fakeMap(mapOpts);
  const mapRef = { current: m.map };
  const targetRef = { current: document.createElement('div') };
  const onDrift = vi.fn();
  const hook = renderHook((p: Partial<UseIdleSpinOptions>) => useIdleSpin({
    mapRef, targetRef, projection: 'globe', ready: true, reducedMotion: false, held: false, idleMs: IDLE, onDrift, ...p,
  }), { initialProps: over });
  return { ...m, onDrift, hook };
}

beforeEach(() => {
  queue = [];
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => { queue.push(cb); return queue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('useIdleSpin', () => {
  it('does not move the globe before the idle time, then drifts west at the drift speed', () => {
    const s = setup();
    frame(100); frame(500); frame(900);
    expect(s.jumpTo).not.toHaveBeenCalled();
    frame(1100); // first frame past the idle time: dt vs the previous frame is 200ms
    expect(s.jumpTo).toHaveBeenCalledTimes(1);
    expect(s.lng()).toBeCloseTo(10 - SPIN_DEG_PER_S * 0.2, 6);
    frame(1200);
    expect(s.lng()).toBeCloseTo(10 - SPIN_DEG_PER_S * 0.3, 6);
  });

  it('tags its own camera moves so the settle handler can ignore them', () => {
    const s = setup();
    frame(100); frame(1100); frame(1200);
    expect(s.jumpTo).toHaveBeenCalled();
    expect(s.jumpTo.mock.calls[0]![1]).toEqual({ [SPIN_EVENT_KEY]: true });
    expect(s.jumpTo.mock.calls[0]![0].center[1]).toBe(20); // latitude is never touched
  });

  it('any input stops it at once and it waits the full idle time again', () => {
    const s = setup();
    frame(100); frame(1100); frame(1200);
    const spun = s.jumpTo.mock.calls.length;
    expect(spun).toBeGreaterThan(0);
    now = 1250;
    act(() => { window.dispatchEvent(new Event('pointermove')); });
    frame(1300);
    expect(s.jumpTo).toHaveBeenCalledTimes(spun); // stopped on the very next frame
    frame(2200);
    expect(s.jumpTo).toHaveBeenCalledTimes(spun); // 950 ms since the input: still waiting
    frame(2300);
    frame(2400);
    expect(s.jumpTo.mock.calls.length).toBeGreaterThan(spun); // resumed
  });

  it.each(['pointerdown', 'wheel', 'keydown', 'touchstart'])('%s counts as an interaction', ev => {
    const s = setup();
    frame(100); frame(900);
    now = 950;
    act(() => { window.dispatchEvent(new Event(ev)); });
    frame(1100); frame(1300); // 150 / 350 ms after the input: still inside the idle time
    expect(s.jumpTo).not.toHaveBeenCalled();
  });

  it('never spins on the flat map (no loop at all)', () => {
    const s = setup({ projection: 'flat' });
    expect(queue).toHaveLength(0);
    frame(5000);
    expect(s.jumpTo).not.toHaveBeenCalled();
  });

  it('never spins under reduced motion', () => {
    const s = setup({ reducedMotion: true });
    frame(100); frame(5000); frame(5100);
    expect(s.jumpTo).not.toHaveBeenCalled();
  });

  it('holds while something is selected, and resumes (after the idle time) when it is cleared', () => {
    const s = setup({ held: true });
    frame(100); frame(5000); frame(5100);
    expect(s.jumpTo).not.toHaveBeenCalled();
    s.hook.rerender({ held: false });
    frame(5200);
    expect(s.jumpTo).toHaveBeenCalled(); // the idle time has long passed
  });

  it('stands down while the camera is moving for another reason, and that counts as an interaction', () => {
    const s = setup({}, { moving: true });
    frame(100); frame(2000); frame(2100);
    expect(s.jumpTo).not.toHaveBeenCalled();
  });

  it('is not ready until the map is: no loop before style.load', () => {
    const s = setup({ ready: false });
    expect(queue).toHaveLength(0);
    s.hook.rerender({ ready: true });
    expect(queue.length).toBeGreaterThan(0);
  });

  it('pauses while the tab is hidden', () => {
    const s = setup();
    frame(100); frame(1100);
    expect(s.jumpTo).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    s.jumpTo.mockClear();
    frame(1200); frame(1300);
    expect(s.jumpTo).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    frame(1400);
    expect(s.jumpTo).toHaveBeenCalled();
  });

  it('lets the caller refresh screen-space labels, throttled (never per frame)', () => {
    const s = setup();
    frame(100); frame(1100);
    expect(s.onDrift).toHaveBeenCalledTimes(1);
    for (let t = 1200; t < 1100 + DRIFT_REFRESH_MS; t += 100) frame(t);
    expect(s.onDrift).toHaveBeenCalledTimes(1);
    frame(1100 + DRIFT_REFRESH_MS);
    expect(s.onDrift).toHaveBeenCalledTimes(2);
  });

  it('stops its loop and its listeners on unmount', () => {
    const s = setup();
    frame(100);
    s.hook.unmount();
    expect(queue).toHaveLength(0);
  });
});
