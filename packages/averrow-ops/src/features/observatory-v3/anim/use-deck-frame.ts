/**
 * useDeckFrame — the ONE requestAnimationFrame driver for the Observatory.
 *
 * It owns the rAF loop, advances the AnimationClock, and calls `onFrame` once
 * per frame. The loop only runs while it can be seen: it is suspended when the
 * hook is disabled, the user prefers reduced motion, the tab is hidden, or the
 * target element is scrolled/clipped out of view. On resume the clock is
 * resynced so the paused gap isn't replayed.
 *
 * `onFrame` is meant to push UNIFORM-ONLY changes (`overlay.setProps` with
 * layers cloned/rebuilt with a new `animTime`/`currentTime`) — never regenerate
 * attributes or touch React state per frame. It is read through a ref, so a new
 * callback identity each render does NOT restart the loop.
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { AnimationClock } from '../lib/animation-clock';
import { usePrefersReducedMotion, usePageVisible, useInView } from '../lib/use-motion';

/** Per-frame timing. The same object is reused every frame — read it, don't retain it. */
export interface DeckFrame {
  /** Clock playhead (timeline units, loops, honours play/pause/speed/seek). */
  t: number;
  /**
   * Monotonic animation seconds: advances in real time only while the loop is
   * running, never wraps, ignores clock speed. Drive pulses/rings/dashes (which
   * must not jump at the clock's loop point) with this.
   */
  seconds: number;
  /** Real seconds since the previous frame (0 on the first), clamped. */
  dt: number;
  /** The rAF timestamp, ms. */
  nowMs: number;
}

export interface UseDeckFrameOptions {
  /** Element whose visibility gates the loop (IntersectionObserver). Omit to ignore. */
  targetRef?: RefObject<Element | null>;
  /** Largest dt (seconds) one frame may add to `seconds` (default 0.1). */
  maxDeltaSeconds?: number;
  /**
   * Cap on how often `onFrame` runs (frames per second; omit for every display frame). rAF still ticks at the display
   * rate, the surplus frames are skipped before anything is drawn. Use it where each frame is expensive (the globe's
   * interleaved overlay repaints the whole basemap with every animated frame).
   */
  maxFps?: number;
}

export interface UseDeckFrameResult {
  /** True while the rAF loop is actually active. */
  running: boolean;
  /** Live prefers-reduced-motion. Callers render a static frame when true. */
  reducedMotion: boolean;
}

const NO_TARGET: RefObject<Element | null> = { current: null };

export function useDeckFrame(
  clock: AnimationClock,
  enabled: boolean,
  onFrame: (t: number, frame: DeckFrame) => void,
  options: UseDeckFrameOptions = {},
): UseDeckFrameResult {
  const { targetRef = NO_TARGET, maxDeltaSeconds = 0.1, maxFps } = options;

  const reducedMotion = usePrefersReducedMotion();
  const pageVisible = usePageVisible();
  const inView = useInView(targetRef);
  const running = enabled && !reducedMotion && pageVisible && inView;

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  // Persist across loop restarts so ring/pulse timestamps stay in one domain.
  const secondsRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    clock.resync(); // don't count the time we were paused / hidden / offscreen
    let lastMs: number | null = null;
    let raf = 0;
    const frame: DeckFrame = { t: clock.currentTime, seconds: secondsRef.current, dt: 0, nowMs: 0 };

    // 2 ms of slack: a 60 Hz display delivers 16.7 ms frames, so a 30 fps cap lands on every second one, not every third.
    const minInterval = maxFps && maxFps > 0 ? 1000 / maxFps - 2 : 0;
    const loop = (ts: number) => {
      if (minInterval > 0 && lastMs !== null && ts - lastMs < minInterval) {
        raf = requestAnimationFrame(loop);
        return;
      }
      const t = clock.tick(ts); // wall-clock-delta based => frame-rate independent
      const dt = lastMs === null ? 0 : Math.min(Math.max(0, (ts - lastMs) / 1000), maxDeltaSeconds);
      lastMs = ts;
      secondsRef.current += dt;
      frame.t = t;
      frame.seconds = secondsRef.current;
      frame.dt = dt;
      frame.nowMs = ts;
      onFrameRef.current(t, frame);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, clock, maxDeltaSeconds, maxFps]);

  return { running, reducedMotion };
}
