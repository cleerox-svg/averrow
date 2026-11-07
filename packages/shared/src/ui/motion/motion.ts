// Averrow motion kit core (P3-4, BRAND_BRIEF §10 G4).
//
// Every move is a no-op unless <html> carries data-accent: with no accent the
// UI is pixel-identical to the legacy look and gains no animation. Moves use
// the Web Animations API (no dependency, nothing left behind on the element);
// where it is missing (jsdom, very old engines) they silently do nothing.
// Reduced motion (OS setting, or html[data-motion="reduce"] for the /kit
// simulation) swaps every move for an opacity-only fade: no travel, no loops.

import { useAppearanceVersion } from '../../theme/tokenReader';

/** M1 durations (ms) and travel (px). Mirrors --motion-* in motion.css. */
export const MOTION = { fast: 120, base: 160, slow: 200, travel: 6, pageTravel: 24 } as const;
export const EASE_STANDARD = 'cubic-bezier(0.2, 0, 0, 1)';
/** Critically damped spring: monotonic, settles without overshoot. */
export const SPRING_LINEAR =
  'linear(0, 0.21 6%, 0.46 13%, 0.66 21%, 0.8 30%, 0.89 39%, 0.95 50%, 0.98 62%, 0.995 77%, 1)';

let springSupported: boolean | null = null;
/** The spring easing where linear() is supported, else ease-standard (an invalid easing would throw). */
export function springEasing(): string {
  if (springSupported === null) {
    springSupported = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('transition-timing-function', SPRING_LINEAR);
  }
  return springSupported ? SPRING_LINEAR : EASE_STANDARD;
}

const html = (): HTMLElement | null => (typeof document === 'undefined' ? null : document.documentElement);

/** True while an accent is set: the motion kit is live. */
export function isMotionOn(): boolean {
  return !!html()?.hasAttribute('data-accent');
}

/** OS reduced-motion preference, or the /kit simulation (html[data-motion="reduce"]). */
export function prefersReducedMotion(): boolean {
  const root = html();
  if (!root) return true;
  if (root.getAttribute('data-motion') === 'reduce') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** isMotionOn() as React state: re-renders when the accent is set or cleared. */
export function useMotionOn(): boolean {
  useAppearanceVersion();
  return isMotionOn();
}

/** Run a WAAPI animation when motion is on and the engine supports it; else null. */
export function play(
  el: Element | null | undefined,
  frames: Keyframe[],
  duration: number,
  easing: string = EASE_STANDARD,
): Animation | null {
  if (!el || !isMotionOn() || typeof (el as HTMLElement).animate !== 'function') return null;
  return el.animate(frames, { duration, easing });
}

/** The reduced-motion stand-in for every move: a short opacity fade. */
export function fadeIn(el: Element | null | undefined): Animation | null {
  return play(el, [{ opacity: 0 }, { opacity: 1 }], MOTION.fast, 'linear');
}
