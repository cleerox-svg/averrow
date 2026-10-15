/**
 * Replay dots: during the replay each threat POPS IN at its timestamp (a bright dot that grows, then shrinks) and SETTLES
 * to a faint dot that stays until the cycle wraps, so the map fills up as the period plays and the timeline's histogram has
 * a picture to match. A time-gated scatter on the shared AnimationClock: the layer's data never changes, only the
 * playhead moves (the accessors read it through `updateTriggers`).
 *
 * Pure (no deck.gl). Under reduced motion there is no pop and no time gate: every dot is drawn settled and static.
 */

import { easeOutCubic } from './shader-math';
import type { ArrivalEvent } from './arrivals';

/** How long the pop lasts, in clock units (60 u/s => 0.67 s). */
export const POP_UNITS = 40;
/** Share of the pop spent growing (the rest is the settle). */
const GROW_SHARE = 0.2;
export const POP_RADIUS_PX = 9;
export const SETTLE_RADIUS_PX = 2.6;
export const POP_ALPHA = 255;
export const SETTLE_ALPHA = 90;
/** Dots kept (evenly sampled) so a heavy period stays cheap to re-evaluate every frame. */
export const MAX_REPLAY_DOTS = 1500;

export interface DotState { radius: number; alpha: number }

const SETTLED: DotState = { radius: SETTLE_RADIUS_PX, alpha: SETTLE_ALPHA };
const HIDDEN: DotState = { radius: 0, alpha: 0 };

/** Radius (px) and alpha (0..255) of a dot that lands at `time`, with the playhead at `playhead` (both clock units). */
export function replayDotState(playhead: number, time: number, reducedMotion: boolean): DotState {
  if (reducedMotion) return SETTLED;
  const age = playhead - time;
  if (age < 0) return HIDDEN;
  if (age >= POP_UNITS) return SETTLED;
  const p = age / POP_UNITS;
  if (p < GROW_SHARE) {
    const g = easeOutCubic(p / GROW_SHARE);
    return { radius: POP_RADIUS_PX * g, alpha: POP_ALPHA };
  }
  const k = easeOutCubic((p - GROW_SHARE) / (1 - GROW_SHARE));
  return {
    radius: POP_RADIUS_PX + (SETTLE_RADIUS_PX - POP_RADIUS_PX) * k,
    alpha: POP_ALPHA + (SETTLE_ALPHA - POP_ALPHA) * k,
  };
}

/** At most `max` events, evenly spaced (keeps the time order). */
export function sampleDots(events: readonly ArrivalEvent[], max: number = MAX_REPLAY_DOTS): ArrivalEvent[] {
  if (events.length <= max) return events.slice();
  const out: ArrivalEvent[] = [];
  const step = events.length / max;
  for (let i = 0; i < max; i++) out.push(events[Math.floor(i * step)]!);
  return out;
}
