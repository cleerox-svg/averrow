/**
 * Movement lens model: infrastructure migration trails.
 *
 * Source: pivot_detected events (/api/observatory/movements). A v2 event names
 * the ASNs (and so countries) an operation moved from and to; a v1 event has no
 * lists, so its `from` is empty and it is drawn as a static pulse at `to`
 * rather than invented as a trail.
 *
 *  - Each from → to country pair is a HOP; an event's hops play in sequence.
 *  - Hops are timed on the replay clock: the event's timestamp inside the
 *    selected period is mapped onto the cycle exactly like the particles, so
 *    scrubbing the timeline moves through migrations too.
 *  - Every hop spawns a ghost ring at the old location when it departs and an
 *    impact ring at the new one when it lands; a faint ghost dot stays behind.
 */

import type { Movement } from '@/hooks/useObservatoryLenses';
import type { LngLat } from '@/lib/country-centroids';
import { parseUtc } from '@/lib/time';
import type { Rgba } from '../map-colors';
import { greatCirclePath } from '../../anim/great-circle';
import { glslMod } from '../../anim/shader-math';
import type { ArrivalEvent } from '../../anim/arrivals';
import { CYCLE_LENGTH } from '../trips';
import { countryCenter, iso2 } from './placement';

/** Clock units one hop takes (60 u/s => 1.5 s). */
export const HOP_UNITS = 90;
export const MAX_COUNTRIES_PER_SIDE = 3;

export const MOVE_COLOR: Rgba = [167, 139, 250, 235];
export const DORMANT_COLOR: Rgba = [148, 163, 184, 215];

export interface MovementHop {
  id: string;
  eventId: string;
  clusterName: string | null;
  /** 0-based position within the event's sequence. */
  index: number;
  fromCc: string;
  toCc: string;
  from: LngLat;
  to: LngLat;
  path: LngLat[];
  /** Per-vertex clock timestamps (TripsLayer), spanning HOP_UNITS. */
  timestamps: number[];
  startUnits: number;
}

export interface MovementPulse {
  id: string;
  eventId: string;
  cc: string;
  position: LngLat;
  kind: 'arrival' | 'dormant';
}

export interface MovementModel {
  hops: MovementHop[];
  /** Static pulses: v1 events (destination only), moves within one country, dormancy. */
  pulses: MovementPulse[];
  /** Ghost (departure) + impact (landing) ring events, sorted by cycle time. */
  ringEvents: ArrivalEvent[];
  byId: Map<string, Movement>;
  /** Events that produced nothing drawable (no placeable country at all). */
  unplaced: number;
}

function placeable(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const cc = iso2(raw);
    if (cc && !out.includes(cc) && countryCenter(cc)) out.push(cc);
    if (out.length >= MAX_COUNTRIES_PER_SIDE) break;
  }
  return out;
}

/** Where an event sits on the replay cycle (clock units), from its timestamp inside the period. */
export function eventUnits(atMs: number, nowMs: number, periodMs: number, cycle: number = CYCLE_LENGTH): number {
  if (!(periodMs > 0) || !Number.isFinite(atMs)) return 0;
  const frac = Math.min(1, Math.max(0, (atMs - (nowMs - periodMs)) / periodMs));
  return frac * cycle;
}

export function buildMovementModel(
  movements: readonly Movement[],
  opts: { nowMs: number; periodMs: number; cycle?: number },
): MovementModel {
  const cycle = opts.cycle ?? CYCLE_LENGTH;
  const hops: MovementHop[] = [];
  const pulses: MovementPulse[] = [];
  const ringEvents: ArrivalEvent[] = [];
  const byId = new Map<string, Movement>();
  let unplaced = 0;

  for (const m of movements) {
    byId.set(m.id, m);
    const from = placeable(m.from.countries);
    const to = placeable(m.to.countries);
    const t0 = eventUnits(parseUtc(m.at).getTime(), opts.nowMs, opts.periodMs, cycle);
    let drawn = false;

    if (m.kind === 'dormancy' || (to.length === 0 && from.length > 0)) {
      // The cluster went dark: mark where it was.
      for (const cc of from) {
        pulses.push({ id: `${m.id}:d:${cc}`, eventId: m.id, cc, position: countryCenter(cc)!, kind: 'dormant' });
        drawn = true;
      }
    } else if (from.length === 0) {
      // v1 payload (or unmapped origin): destination only, never an invented trail.
      for (const cc of to) {
        pulses.push({ id: `${m.id}:a:${cc}`, eventId: m.id, cc, position: countryCenter(cc)!, kind: 'arrival' });
        drawn = true;
      }
    } else {
      let seq = 0;
      for (const f of from) {
        for (const t of to) {
          if (f === t) continue;
          const a = countryCenter(f)!;
          const b = countryCenter(t)!;
          const path = greatCirclePath(a, b, 28);
          const start = t0 + seq * HOP_UNITS;
          const stamps = (base: number) => path.map((_, i) => base + (i / (path.length - 1)) * HOP_UNITS);
          hops.push({
            id: `${m.id}:${f}-${t}`, eventId: m.id, clusterName: m.cluster_name, index: seq,
            fromCc: f, toCc: t, from: a, to: b, path, timestamps: stamps(start), startUnits: start,
          });
          // A hop that would run past the end of the cycle carries on after the wrap.
          if (start + HOP_UNITS * 2 > cycle) {
            hops.push({
              id: `${m.id}:${f}-${t}:w`, eventId: m.id, clusterName: m.cluster_name, index: seq,
              fromCc: f, toCc: t, from: a, to: b, path, timestamps: stamps(start - cycle), startUnits: start - cycle,
            });
          }
          ringEvents.push(
            { time: glslMod(start, cycle), lng: a[0], lat: a[1], color: MOVE_COLOR, key: `g:${m.id}:${f}` },
            { time: glslMod(start + HOP_UNITS, cycle), lng: b[0], lat: b[1], color: MOVE_COLOR, key: `i:${m.id}:${t}` },
          );
          seq++;
          drawn = true;
        }
      }
      if (!drawn) {
        // Moved between ASNs inside the same country(ies): a pulse where it landed.
        for (const cc of to) {
          pulses.push({ id: `${m.id}:a:${cc}`, eventId: m.id, cc, position: countryCenter(cc)!, kind: 'arrival' });
          drawn = true;
        }
      }
    }
    if (!drawn) unplaced++;
  }

  ringEvents.sort((a, b) => a.time - b.time);
  return { hops, pulses, ringEvents, byId, unplaced };
}

/** Numbered labels for the static (reduced-motion) rendering: "1", "2" … per event. */
export function hopLabel(h: MovementHop): string {
  return String(h.index + 1);
}
