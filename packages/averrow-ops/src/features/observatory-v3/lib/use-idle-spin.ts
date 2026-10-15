/**
 * useIdleSpin — the globe's ambient drift, as a hook around the pure policy in `spin.ts`.
 *
 * The drift is for WALL SCREENS and briefings (nobody at the keyboard). So:
 *   - it starts only after `idleMs` with no input, and stops on the next frame after any;
 *   - any real input (a press, wheel, key or touch on the map, or the pointer moving) pauses it and restarts the idle
 *     timer: it RESUMES after `idleMs` of quiet, so a wall screen that somebody touched goes back to turning by itself.
 *     (It used to end for the whole session on the first press. That made a click on the Flat | Globe toggle, which is
 *     what turns the globe on, kill the drift before it began.) A press on a map CONTROL (the projection toggle) is not
 *     a map gesture and does not even restart the timer;
 *   - it holds while the pointer is over the page's chrome (panel, drawer, legend, toolbar: everything outside the map
 *     root, `pointerOverChrome`) and while the caller says so (`held`: something selected, the legend open);
 *   - it stands down under reduced motion, in a hidden tab, off screen and while the camera moves for another reason.
 *
 * The rAF loop exists ONLY while it could spin (globe, motion allowed, visible, in view, not held):
 * every other state tears it down instead of polling to no effect, and a change of state restarts it.
 *
 * The loop never touches React state: the map is nudged directly and deck.gl follows the map's `move` events.
 * `onSpinChange` tells the caller when drifting starts and stops, so screen-space labels (placed for a still
 * camera) are hidden while the globe turns and placed again when it stops.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { useInView, usePageVisible } from './use-motion';
import { spinAllowed, spinStep, SPIN_IDLE_MS } from './spin';
import type { Projection } from './projection';

/** `eventData` key that tags the spin's own camera moves. */
export const SPIN_EVENT_KEY = 'spin';

/** Input that is somebody USING the console: it pauses the drift until `idleMs` of quiet. */
const ENGAGE_EVENTS = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;

/** A press on one of the map's own controls (the Flat | Globe toggle) is not a gesture on the map. */
const MAP_CONTROL = '[data-control]';
/** True when an engage event is a real gesture: it did not start on a map control. */
export function isMapGesture(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest(MAP_CONTROL));
}

export interface UseIdleSpinOptions {
  mapRef: RefObject<maplibregl.Map | null>;
  /** The map's root element: a pointer outside it is over the page's chrome. */
  targetRef: RefObject<Element | null>;
  projection: Projection;
  /** The map is ready (style loaded). */
  ready: boolean;
  reducedMotion: boolean;
  /** Something is selected / open / being read: do not move the world. */
  held: boolean;
  idleMs?: number;
  /** The globe started (true) or stopped (false) drifting. */
  onSpinChange?: (spinning: boolean) => void;
}

export function useIdleSpin({
  mapRef, targetRef, projection, ready, reducedMotion, held, idleMs = SPIN_IDLE_MS, onSpinChange,
}: UseIdleSpinOptions): { poke: () => void } {
  const pageVisible = usePageVisible();
  const inView = useInView(targetRef);
  const lastInput = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  /** Presence only (restarts the idle timer): a requested camera move, entering the globe, pointer movement. */
  const poke = useCallback(() => { lastInput.current = performance.now(); }, []);
  const overChrome = useRef(false);

  // Latest inputs, read by the loop without restarting it.
  const live = useRef({ idleMs, onSpinChange });
  live.current = { idleMs, onSpinChange };

  const active = ready && projection === 'globe';
  const canRun = active && !reducedMotion && pageVisible && inView && !held;

  // Input listeners live as long as the hook, not just on the globe, so the idle timer already reflects the last input
  // when the globe appears.
  useEffect(() => {
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    const engage = (e: Event) => { if (isMapGesture(e.target)) poke(); };
    const move = (e: Event) => {
      poke();
      const root = targetRef.current;
      overChrome.current = !!root && e.target instanceof Node && !root.contains(e.target);
    };
    const leave = () => { overChrome.current = false; };
    for (const ev of ENGAGE_EVENTS) window.addEventListener(ev, engage, opts);
    window.addEventListener('pointermove', move, opts);
    document.documentElement.addEventListener('mouseleave', leave);
    return () => {
      for (const ev of ENGAGE_EVENTS) window.removeEventListener(ev, engage, opts);
      window.removeEventListener('pointermove', move, opts);
      document.documentElement.removeEventListener('mouseleave', leave);
    };
  }, [poke, targetRef]);

  // Entering the globe is not an interaction by itself, but the idle time starts from here.
  useEffect(() => { if (active) poke(); }, [active, poke]);

  useEffect(() => {
    if (!canRun) return;
    let raf = 0;
    let last: number | null = null;
    let spinning = false;
    const setSpinning = (v: boolean) => {
      if (v === spinning) return;
      spinning = v;
      live.current.onSpinChange?.(v);
    };
    const loop = (ts: number) => {
      const dt = last === null ? 0 : (ts - last) / 1000;
      last = ts;
      const map = mapRef.current;
      if (map) {
        const cameraBusy = map.isMoving();
        // A fly-to or a user gesture in flight is an interaction in its own right.
        if (cameraBusy) lastInput.current = ts;
        const go = spinAllowed({
          projection, reducedMotion: false, pageVisible: true, inView: true,
          held: false, cameraBusy, pointerOverChrome: overChrome.current,
          nowMs: ts, lastInteractionMs: lastInput.current, idleMs: live.current.idleMs,
        });
        if (go && dt > 0) {
          setSpinning(true);
          const c = map.getCenter();
          // eventData marks the move as ours: the label refresh on `moveend` skips it (onSpinChange covers labels).
          map.jumpTo({ center: [spinStep(c.lng, dt), c.lat] }, { [SPIN_EVENT_KEY]: true });
        } else if (!go) {
          setSpinning(false);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      setSpinning(false);
    };
  }, [canRun, projection, mapRef]);

  return { poke };
}
