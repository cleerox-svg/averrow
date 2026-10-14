/**
 * useIdleSpin — the globe's ambient drift, as a hook around the pure policy in `spin.ts`.
 *
 * The drift is for WALL SCREENS and briefings (nobody at the keyboard). So:
 *   - it starts only after `idleMs` with no input, and stops on the next frame after any;
 *   - the first real interaction (a press, wheel, key or touch) ends it for the rest of the session: it does not
 *     auto-resume (`interactedThisSession`, module state so it survives a remount). Plain pointer movement only
 *     restarts the idle timer, so a nudged mouse does not end the wall-screen behaviour for good;
 *   - it holds while the pointer is over the page's chrome (panel, drawer, legend, toolbar: everything outside the map
 *     root, `pointerOverChrome`) and while the caller says so (`held`: something selected, the legend open);
 *   - it stands down under reduced motion, in a hidden tab, off screen and while the camera moves for another reason.
 *
 * The rAF loop exists ONLY while it could spin (globe, motion allowed, visible, in view, not held, not yet interacted):
 * every other state tears it down instead of polling to no effect, and a change of state restarts it.
 *
 * The loop never touches React state: the map is nudged directly and deck.gl follows the map's `move` events.
 * `onSpinChange` tells the caller when drifting starts and stops, so screen-space labels (placed for a still
 * camera) are hidden while the globe turns and placed again when it stops.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type maplibregl from 'maplibre-gl';
import { useInView, usePageVisible } from './use-motion';
import { spinAllowed, spinStep, SPIN_IDLE_MS } from './spin';
import type { Projection } from './projection';

/** `eventData` key that tags the spin's own camera moves. */
export const SPIN_EVENT_KEY = 'spin';

/** Input that is somebody USING the console: it ends the drift for the session. */
const ENGAGE_EVENTS = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;

let interactedThisSession = false;
/** Whether anybody has used the console since the page loaded. */
export const hasInteractedThisSession = (): boolean => interactedThisSession;
/** Test seam: forget the session's interaction. */
export function resetSpinSession(): void { interactedThisSession = false; }

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
  const canRun = active && !reducedMotion && pageVisible && inView && !held && !interactedThisSession;

  // Input listeners live as long as the hook, not just on the globe: choosing the globe (a click on the flat map) is
  // itself an interaction, and must end the wall-screen behaviour before the globe is even showing.
  useEffect(() => {
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    const engage = () => { interactedThisSession = true; poke(); };
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
      // Somebody used the console: the drift is over for the session, so the loop is too.
      if (interactedThisSession) { setSpinning(false); return; }
      const dt = last === null ? 0 : (ts - last) / 1000;
      last = ts;
      const map = mapRef.current;
      if (map) {
        const cameraBusy = map.isMoving();
        // A fly-to or a user gesture in flight is an interaction in its own right.
        if (cameraBusy) lastInput.current = ts;
        const go = spinAllowed({
          projection, reducedMotion: false, pageVisible: true, inView: true,
          held: false, cameraBusy, pointerOverChrome: overChrome.current, interacted: false,
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
