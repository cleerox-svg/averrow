/**
 * Motion policy: what moves, and for how long.
 *
 * The console follows one rule: ONE animated idea per view, restrained and
 * tied to meaning.
 *   - Threats: particles are the motion. Nodes breathe only when critical or
 *     high; impact rings only for critical / high arrivals; live pings use
 *     their own (cyan) colour so "something just landed" never reads as severity.
 *   - Lens layers carry their own single idea (pulse, dash flow, trail).
 *   - Reduced motion: nothing loops. Particles become static beams (the corridors
 *     stay visible instead of dead dots), pulses stop, transitions are instant.
 */

import type { Rgba } from './map-colors';

/** Severities that earn a heartbeat / an impact ring. */
const LOUD = new Set(['critical', 'high']);

export const LENS_FADE_IN_MS = 240;
export const LENS_FADE_OUT_MS = 200;
export const COLOR_TRANSITION_MS = 250;
export const DRAWER_ENTER_MS = 220;

/** Sonar ping colour: distinct from every severity / threat-type hue. */
export const PING_COLOR: Rgba = [122, 234, 255, 240];

export const isLoudSeverity = (severity: string | null | undefined): boolean => LOUD.has((severity ?? '').toLowerCase());

export interface MotionPolicy {
  /** Particles + impact rings run. */
  flow: boolean;
  /** Corridors drawn as static beams although the Beams layer is off (reduced motion stands in for particles). */
  staticBeams: boolean;
  /** Dashes, pulses, halos and trails may animate. */
  ambient: boolean;
  /** Camera / fade / colour transitions are instant. */
  instant: boolean;
}

export function motionPolicy(opts: { reducedMotion: boolean; particlesLayer: boolean }): MotionPolicy {
  return {
    flow: opts.particlesLayer && !opts.reducedMotion,
    staticBeams: opts.particlesLayer && opts.reducedMotion,
    ambient: !opts.reducedMotion,
    instant: opts.reducedMotion,
  };
}

/** Heartbeat amplitude (fractional radius swing): only critical / high nodes breathe. */
export function breatheAmp(severity: string | null | undefined, ampFor: (s: string) => number, policy: Pick<MotionPolicy, 'ambient'>): number {
  if (!policy.ambient || !isLoudSeverity(severity)) return 0;
  return ampFor((severity ?? '').toLowerCase());
}

/** 0..1 progress of a fade that started at `startMs`, easeOutCubic; 1 when instant or finished. */
export function fadeProgress(nowMs: number, startMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 1;
  const t = Math.min(1, Math.max(0, (nowMs - startMs) / durationMs));
  return 1 - (1 - t) ** 3;
}

export interface LensFade {
  /** Opacity of the incoming scene. */
  incoming: number;
  /** Opacity of the outgoing scene (0 when it should be dropped). */
  outgoing: number;
  /** Still animating. */
  active: boolean;
}

/**
 * Cross-fade between two lens scenes, driven by a clock value (never a CSS
 * timer, so it stays in step with the map's frames). The outgoing scene is
 * kept for LENS_FADE_OUT_MS, the incoming one fades in over LENS_FADE_IN_MS.
 */
export function lensFade(nowMs: number, startMs: number | null, instant: boolean): LensFade {
  if (startMs === null || instant) return { incoming: 1, outgoing: 0, active: false };
  const elapsed = nowMs - startMs;
  if (elapsed >= LENS_FADE_IN_MS) return { incoming: 1, outgoing: 0, active: false };
  return {
    incoming: fadeProgress(nowMs, startMs, LENS_FADE_IN_MS),
    outgoing: elapsed >= LENS_FADE_OUT_MS ? 0 : 1 - fadeProgress(nowMs, startMs, LENS_FADE_OUT_MS),
    active: true,
  };
}
