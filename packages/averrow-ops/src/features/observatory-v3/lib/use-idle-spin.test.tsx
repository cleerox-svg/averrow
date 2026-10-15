import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type * as maplibregl from 'maplibre-gl';
import { useIdleSpin, isMapGesture, SPIN_EVENT_KEY, type UseIdleSpinOptions } from './use-idle-spin';
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
  const onSpinChange = vi.fn();
  const hook = renderHook((p: Partial<UseIdleSpinOptions>) => useIdleSpin({
    mapRef, targetRef, projection: 'globe', ready: true, reducedMotion: false, held: false, idleMs: IDLE, onSpinChange, ...p,
  }), { initialProps: over });
  return { ...m, onSpinChange, targetRef, hook };
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

  it('plain pointer movement stops it at once and it waits the full idle time again (it does not end the wall-screen behaviour)', () => {
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

  it.each(['pointerdown', 'wheel', 'keydown', 'touchstart'])('%s pauses the drift at once and it RESUMES after the idle time (no session-long stop)', ev => {
    const s = setup();
    frame(100); frame(1100); frame(1200);
    const spun = s.jumpTo.mock.calls.length;
    expect(spun).toBeGreaterThan(0);
    now = 1250;
    act(() => { window.dispatchEvent(new Event(ev)); });
    frame(1300);
    expect(s.jumpTo).toHaveBeenCalledTimes(spun); // paused on the very next frame
    frame(2200);
    expect(s.jumpTo).toHaveBeenCalledTimes(spun); // 950 ms since the input: still waiting
    expect(queue.length).toBeGreaterThan(0); // the loop stays alive to resume
    frame(2300); frame(2400);
    expect(s.jumpTo.mock.calls.length).toBeGreaterThan(spun); // and it is turning again
  });

  it('a press on a map control (the projection toggle) is not a map gesture: it does not even restart the idle timer', () => {
    const s = setup();
    frame(100); frame(1100); frame(1200);
    const spun = s.jumpTo.mock.calls.length;
    const toggle = document.createElement('button');
    toggle.setAttribute('data-control', 'projection');
    toggle.setAttribute('data-spin-exempt', '');
    const inner = document.createElement('span');
    toggle.appendChild(inner);
    document.body.appendChild(toggle);
    now = 1250;
    act(() => { inner.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    frame(1300);
    expect(s.jumpTo.mock.calls.length).toBeGreaterThan(spun); // still turning
    expect(isMapGesture(inner)).toBe(false);
    toggle.remove();
    expect(isMapGesture(document.body)).toBe(true);
    expect(isMapGesture(null)).toBe(true);
  });

  it('choosing the globe (a press on the flat map first) does not end the drift: it starts after the idle time', () => {
    const s = setup({ projection: 'flat' });
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    s.hook.rerender({ projection: 'globe' });
    frame(100); frame(900);
    expect(s.jumpTo).not.toHaveBeenCalled();
    frame(1200); frame(1300);
    expect(s.jumpTo).toHaveBeenCalled();
  });

  it('holds while the pointer is over the page\'s chrome, and resumes after the idle time once it is back over the map', () => {
    const s = setup();
    document.body.appendChild(s.targetRef.current);
    const chrome = document.createElement('div');
    document.body.appendChild(chrome);
    frame(100); frame(1100); frame(1200);
    expect(s.jumpTo).toHaveBeenCalled();
    now = 1250;
    act(() => { chrome.dispatchEvent(new Event('pointermove', { bubbles: true })); });
    s.jumpTo.mockClear();
    frame(5000); frame(9000);
    expect(s.jumpTo).not.toHaveBeenCalled(); // parked on the chrome, however long
    now = 9100;
    act(() => { s.targetRef.current.dispatchEvent(new Event('pointermove', { bubbles: true })); });
    frame(9500);
    expect(s.jumpTo).not.toHaveBeenCalled(); // back over the map: the idle time starts again
    frame(10_200); frame(10_300);
    expect(s.jumpTo).toHaveBeenCalled();
    chrome.remove();
    s.targetRef.current.remove();
  });

  it('a pointer that leaves the window is not "over chrome"', () => {
    const s = setup();
    const chrome = document.createElement('div');
    document.body.appendChild(chrome);
    frame(100);
    now = 200;
    act(() => { chrome.dispatchEvent(new Event('pointermove', { bubbles: true })); });
    act(() => { document.documentElement.dispatchEvent(new Event('mouseleave')); });
    frame(2000); frame(2100);
    expect(s.jumpTo).toHaveBeenCalled();
    chrome.remove();
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
    frame(5200); frame(5300);
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
    frame(1400); frame(1500);
    expect(s.jumpTo).toHaveBeenCalled();
  });

  it('tells the caller when it starts and stops drifting (so labels can hide and be placed again)', () => {
    const s = setup();
    frame(100); frame(900);
    expect(s.onSpinChange).not.toHaveBeenCalled();
    frame(1100);
    expect(s.onSpinChange).toHaveBeenCalledTimes(1);
    expect(s.onSpinChange).toHaveBeenLastCalledWith(true);
    frame(1200); frame(1300);
    expect(s.onSpinChange).toHaveBeenCalledTimes(1); // once per start, never per frame
    now = 1350;
    act(() => { window.dispatchEvent(new Event('pointermove')); });
    frame(1400);
    expect(s.onSpinChange).toHaveBeenLastCalledWith(false);
    expect(s.onSpinChange).toHaveBeenCalledTimes(2);
  });

  it('reports the stop when the loop is torn down mid-drift (held, unmount)', () => {
    const s = setup();
    frame(100); frame(1100); frame(1200);
    s.hook.rerender({ held: true });
    expect(s.onSpinChange).toHaveBeenLastCalledWith(false);
  });

  it('does not run a loop it cannot use: reduced motion, held, flat, hidden tab', () => {
    expect(setup({ reducedMotion: true }).hook.unmount()).toBeUndefined();
    expect(queue).toHaveLength(0);
    setup({ held: true });
    expect(queue).toHaveLength(0);
    queue = [];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    setup();
    expect(queue).toHaveLength(0);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  it('stops its loop and its listeners on unmount', () => {
    const s = setup();
    frame(100);
    s.hook.unmount();
    expect(queue).toHaveLength(0);
  });
});
