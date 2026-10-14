/**
 * Arrival scheduling: turn "a particle reaches its target" into discrete events
 * the frame loop can react to (impact rings, sonar pings, counters…).
 *
 * Particles are GPU-driven (TripsLayer) so JS never sees them move. But the
 * clock is deterministic, so arrival times are known up front: each trip's last
 * timestamp. The scheduler turns two consecutive playheads into the set of
 * arrivals crossed between them — a binary search plus a few array reads per
 * frame, no per-particle work.
 */

import type { TripDatum } from '../lib/trips';
import type { Rgba } from '../lib/map-colors';
import { glslMod } from './shader-math';

export interface ArrivalEvent {
  /** Playhead position in [0, cycleLength) at which the particle lands. */
  time: number;
  lng: number;
  lat: number;
  color: Rgba;
  /** Stable key of the target (for per-target throttling). */
  key: string;
}

/**
 * One event per real trip. buildTripData emits a "twin" (timestamps shifted one
 * cycle back, so it starts negative) for trips that outlive the cycle; those
 * share the original's arrival and are skipped here.
 */
export function buildArrivalEvents(trips: readonly TripDatum[], cycleLength: number): ArrivalEvent[] {
  const events: ArrivalEvent[] = [];
  for (const trip of trips) {
    const last = trip.timestamps.length - 1;
    if (last < 1 || trip.timestamps[0]! < 0) continue;
    const end = trip.path[last];
    if (!end) continue;
    events.push({
      time: glslMod(trip.timestamps[last]!, cycleLength),
      lng: end[0],
      lat: end[1],
      color: trip.color,
      key: `${end[0].toFixed(3)},${end[1].toFixed(3)}`,
    });
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

export class ArrivalScheduler {
  private readonly events: readonly ArrivalEvent[];
  private readonly cycle: number;
  private readonly maxStep: number;

  /**
   * @param events  sorted by `time` (buildArrivalEvents does this)
   * @param maxStep largest forward playhead movement treated as continuous
   *                playback. Bigger jumps (seek) and backward motion emit nothing.
   */
  constructor(events: readonly ArrivalEvent[], cycleLength: number, maxStep: number = cycleLength / 30) {
    this.events = events;
    this.cycle = cycleLength;
    this.maxStep = maxStep;
  }

  get size(): number {
    return this.events.length;
  }

  /** Arrivals with time in (prevT, t], wrap-aware, appended to `out` (returned). */
  collect(prevT: number, t: number, out: ArrivalEvent[] = []): ArrivalEvent[] {
    const c = this.cycle;
    // Shortest signed playhead movement, in (-c/2, c/2].
    let delta = glslMod(t - prevT, c);
    if (delta > c / 2) delta -= c;
    if (delta <= 0 || delta > this.maxStep) return out;

    const to = prevT + delta;
    if (to < c) {
      this.range(prevT, to, false, out);
    } else {
      this.range(prevT, c, false, out); // (prev, c)
      this.range(0, to - c, true, out); // [0, to - c]
    }
    return out;
  }

  /** Events with time in (lo, hi] — or [lo, hi] when `inclusiveLo`. */
  private range(lo: number, hi: number, inclusiveLo: boolean, out: ArrivalEvent[]): void {
    const ev = this.events;
    let i = this.lowerBound(lo, inclusiveLo);
    for (; i < ev.length; i++) {
      const e = ev[i]!;
      if (e.time > hi) break;
      out.push(e);
    }
  }

  /** First index with time > lo (or >= lo when inclusive). */
  private lowerBound(lo: number, inclusive: boolean): number {
    const ev = this.events;
    let a = 0;
    let b = ev.length;
    while (a < b) {
      const mid = (a + b) >>> 1;
      const time = ev[mid]!.time;
      if (inclusive ? time < lo : time <= lo) a = mid + 1;
      else b = mid;
    }
    return a;
  }
}
