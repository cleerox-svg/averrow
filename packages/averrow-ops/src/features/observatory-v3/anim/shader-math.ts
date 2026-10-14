/**
 * Pure-TS mirrors of the GLSL math in the animation extensions.
 *
 * Every function here has a line-for-line twin in a shader injected by
 * PulseExtension / RingExtension / DashFlowExtension. They exist so the
 * animation maths can be unit-tested without a GPU, and so CPU-side code
 * (reduced-motion static frames, hit-testing, scheduling) agrees with what the
 * shader draws. If you change a formula, change both sides.
 */

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** GLSL `mod(x, y)`: result has the sign of y (always [0, y) for y > 0). */
export function glslMod(x: number, y: number): number {
  return x - y * Math.floor(x / y);
}

// ─── Pulse ──────────────────────────────────────────────────

/** Radius multiplier: `1 + amp * sin(t * rate + phase)`. */
export function pulseScale(t: number, rate: number, phase: number, amp: number): number {
  return 1 + amp * Math.sin(t * rate + phase);
}

// ─── Ring ───────────────────────────────────────────────────

/** Fraction of the ring life spent fading IN (avoids a hard pop at spawn). */
export const RING_FADE_IN = 0.06;
/** Smallest duration the shader divides by (guards 0 / unset slots). */
export const RING_MIN_DURATION = 1e-4;

export function ringAge(now: number, start: number): number {
  return now - start;
}

/** Normalised life: 0 at spawn, 1 at expiry (unclamped). */
export function ringProgress(now: number, start: number, duration: number): number {
  return ringAge(now, start) / Math.max(duration, RING_MIN_DURATION);
}

/** True inside the closed life window [0, duration]; outside it the ring collapses. */
export function ringActive(now: number, start: number, duration: number): boolean {
  const age = ringAge(now, start);
  return age >= 0 && ringProgress(now, start, duration) <= 1;
}

export function easeOutCubic(p: number): number {
  const q = 1 - clamp01(p);
  return 1 - q * q * q;
}

/** Radius multiplier eased from r0 to r1 over the ring's life. */
export function ringScale(p: number, r0: number, r1: number): number {
  return r0 + (r1 - r0) * easeOutCubic(p);
}

/** Alpha multiplier: quick fade-in, then (1 - p)^2 down to 0 at expiry. */
export function ringAlpha(p: number): number {
  const c = clamp01(p);
  return clamp01(c / RING_FADE_IN) * (1 - c) * (1 - c);
}

export interface RingState {
  active: boolean;
  /** Radius multiplier (0 when collapsed). */
  scale: number;
  /** Alpha multiplier (0 when collapsed). */
  alpha: number;
}

/** Everything the ring vertex shader derives for one instance. */
export function ringState(now: number, start: number, duration: number, r0: number, r1: number): RingState {
  if (!ringActive(now, start, duration)) return { active: false, scale: 0, alpha: 0 };
  const p = ringProgress(now, start, duration);
  return { active: true, scale: ringScale(p, r0, r1), alpha: ringAlpha(p) };
}

// ─── Dash flow ──────────────────────────────────────────────

/**
 * Whether a fragment at path distance `dist` is inside a dash at time `t`.
 * Positive `speed` flows in the direction of increasing distance (along the
 * path, source -> target).
 */
export function dashVisible(dist: number, t: number, dash: number, gap: number, speed: number): boolean {
  const cycle = dash + gap;
  return glslMod(dist - t * speed, cycle) <= dash;
}

/** Fraction of each dash period that is drawn (the rest is the gap). Shared with RingMaskExtension's GLSL. */
export const RING_MASK_DASH_DUTY = 0.58;

/**
 * Whether a point at angle `turn` (0..1, clockwise from 12 o'clock) is inside
 * the ring mask at time `t`. Mirrors RingMaskExtension's fragment shader.
 */
export function ringMaskVisible(turn: number, fraction: number, dashes: number, spin: number, t: number): boolean {
  const tn = glslMod(turn, 1);
  if (tn > fraction) return false;
  if (dashes > 0.5) return glslMod(tn * dashes - t * spin, 1) <= RING_MASK_DASH_DUTY;
  return true;
}
