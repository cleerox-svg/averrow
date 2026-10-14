/**
 * useIdleSpin — the globe's ambient drift, as a hook around the pure policy in `spin.ts`.
 *
 * One rAF loop that exists only while the globe is the active projection. Each frame it asks
 * `spinAllowed` and, if so, nudges the camera centre eastward. ANY input on the page (pointer,
 * wheel, key, touch) restarts the idle timer, so the globe stops on the very next frame and
 * stays still for `SPIN_IDLE_MS` after the last input. It also stands down while the camera is
 * moving for another reason (a drag, a zoom, a fly-to), under reduced motion, in a hidden tab,
 * off screen, and while something is selected.
 *
 * The loop never touches React state: the map is nudged directly, deck.gl follows the map's
 * `move` events, and `onDrift` (throttled) lets the caller refresh screen-space labels.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type maplibregl from 'maplibre-gl';
import { useInView, usePageVisible } from './use-motion';
import { spinAllowed, spinStep, SPIN_IDLE_MS } from './spin';
import type { Projection } from './projection';

/** Labels follow a drifting globe at this cadence (never per frame). */
export const DRIFT_REFRESH_MS = 700;

/** `eventData` key that tags the spin's own camera moves. */
export const SPIN_EVENT_KEY = 'spin';

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'] as const;

export interface UseIdleSpinOptions {
  mapRef: RefObject<maplibregl.Map | null>;
  targetRef: RefObject<Element | null>;
  projection: Projection;
  /** The map is ready (style loaded). */
  ready: boolean;
  reducedMotion: boolean;
  /** Something is selected / open: someone is reading, do not move the world. */
  held: boolean;
  idleMs?: number;
  /** Called at most every `DRIFT_REFRESH_MS` while drifting. */
  onDrift?: () => void;
}

export function useIdleSpin({
  mapRef, targetRef, projection, ready, reducedMotion, held, idleMs = SPIN_IDLE_MS, onDrift,
}: UseIdleSpinOptions): { poke: () => void } {
  const pageVisible = usePageVisible();
  const inView = useInView(targetRef);
  const lastInput = useRef(typeof performance !== 'undefined' ? performance.now() : 0);
  const poke = useCallback(() => { lastInput.current = performance.now(); }, []);

  // Latest inputs, read by the loop without restarting it.
  const live = useRef({ reducedMotion, held, pageVisible, inView, idleMs, onDrift });
  live.current = { reducedMotion, held, pageVisible, inView, idleMs, onDrift };

  const active = ready && projection === 'globe';

  // Any input anywhere on the page counts as presence; a stalled idle timer restarts from the last one.
  useEffect(() => {
    if (!active) return;
    poke(); // entering the globe is itself an interaction: wait the idle time before drifting
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    for (const ev of INPUT_EVENTS) window.addEventListener(ev, poke, opts);
    return () => { for (const ev of INPUT_EVENTS) window.removeEventListener(ev, poke, opts); };
  }, [active, poke]);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last: number | null = null;
    let lastDrift = 0;
    const loop = (ts: number) => {
      const dt = last === null ? 0 : (ts - last) / 1000;
      last = ts;
      const map = mapRef.current;
      if (map) {
        const cameraBusy = map.isMoving();
        // A fly-to or a user gesture in flight is an interaction in its own right.
        if (cameraBusy) lastInput.current = ts;
        const l = live.current;
        const go = spinAllowed({
          projection, reducedMotion: l.reducedMotion, pageVisible: l.pageVisible, inView: l.inView,
          held: l.held, cameraBusy, nowMs: ts, lastInteractionMs: lastInput.current, idleMs: l.idleMs,
        });
        if (go && dt > 0) {
          const c = map.getCenter();
          // eventData marks the move as ours: the label refresh on `moveend` skips it (onDrift covers labels, throttled).
          map.jumpTo({ center: [spinStep(c.lng, dt), c.lat] }, { [SPIN_EVENT_KEY]: true });
          if (ts - lastDrift >= DRIFT_REFRESH_MS) {
            lastDrift = ts;
            l.onDrift?.();
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, projection, mapRef]);

  return { poke };
}
