/**
 * Idle spin: the globe drifts slowly eastward while nobody is using it (a wall screen, a
 * briefing), and stops the instant someone touches it.
 *
 * Pure policy + stepping here (unit-tested); `use-idle-spin.ts` owns the rAF loop and the
 * input listeners. Spin runs only when ALL of these hold:
 *   - the projection is the globe (never the flat map);
 *   - motion is allowed (not prefers-reduced-motion);
 *   - the tab is visible and the map is on screen;
 *   - nothing is selected or open (an open drawer or legend means someone is reading);
 *   - the pointer is not over the page's chrome (panel, drawer, legend, toolbar);
 *   - the camera is not otherwise moving (a flyTo, a drag, a zoom);
 *   - there has been no input for `SPIN_IDLE_MS` (so it resumes by itself after somebody has used the globe).
 */

import type { Projection } from './projection';

/** Quiet time before the globe starts drifting, ms. */
export const SPIN_IDLE_MS = 12_000;
/** Drift speed, degrees of longitude per second (a full turn in ~100 s). */
export const SPIN_DEG_PER_S = 3.6;
/** Largest step one frame may take (a long frame after a stall must not jump the globe; 4 fps still drifts at full speed), seconds. */
export const SPIN_MAX_DT = 0.25;

export interface SpinInputs {
  projection: Projection;
  reducedMotion: boolean;
  pageVisible: boolean;
  inView: boolean;
  /** Something is selected / open, or the camera was asked to go somewhere. */
  held: boolean;
  /** The camera is moving for another reason (user drag/zoom, a fly-to). */
  cameraBusy: boolean;
  /** The pointer is over the page's chrome rather than the map. */
  pointerOverChrome?: boolean;
  nowMs: number;
  lastInteractionMs: number;
  idleMs?: number;
}

/** Whether the globe may drift right now. */
export function spinAllowed(i: SpinInputs): boolean {
  if (i.projection !== 'globe') return false;
  if (i.reducedMotion || !i.pageVisible || !i.inView) return false;
  if (i.held || i.cameraBusy || i.pointerOverChrome) return false;
  return i.nowMs - i.lastInteractionMs >= (i.idleMs ?? SPIN_IDLE_MS);
}

/** Wrap a longitude into [-180, 180). */
function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** The centre longitude after `dtSeconds` of drift (the surface turns eastward, so the view slides west). */
export function spinStep(lng: number, dtSeconds: number, degPerSecond: number = SPIN_DEG_PER_S): number {
  const dt = Math.min(Math.max(0, dtSeconds), SPIN_MAX_DT);
  return wrapLng(lng - degPerSecond * dt);
}
