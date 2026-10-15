/**
 * ImpactRingSpawner — turns arrival events into rings in a RingBuffer, with
 * back-pressure so a busy map stays readable and cheap:
 *   - per-target cooldown (a hot target emits one ring per `cooldown`, not one
 *     per particle),
 *   - a per-frame cap,
 *   - a single `commit()` per frame (one version bump => one attribute re-read).
 */

import type { ArrivalEvent } from './arrivals';
import type { RingBuffer } from './ring-buffer';

export interface ImpactRingOptions {
  /** Ring life, seconds (default 1.4). */
  duration?: number;
  /** Min seconds between rings at the same target (default 0.6). */
  cooldown?: number;
  /** Max rings spawned per frame (default 6). */
  maxPerFrame?: number;
  /** Alpha written to the ring colour (the shader fades it) (default 235). */
  alpha?: number;
  /** Full ring radius in px for an event (absent / 0 = the layer's default). */
  radiusFor?: (event: ArrivalEvent) => number | undefined;
}

/** Impact ring radius bounds, px: a one-threat corridor gets the small ring, a heavy one the large, never outside. */
export const RING_RADIUS_PX = { desktop: { min: 16, max: 40 }, mobile: { min: 12, max: 26 } } as const;
/** The volume at which the ring reaches its maximum (log scale: 1 -> min, this -> max). */
export const RING_FULL_VOLUME = 1000;

/** Ring radius for an arc carrying `volume` threats: log-scaled between the min and the max for the device. */
export function ringRadiusPx(volume: number | undefined, mobile: boolean): number | undefined {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return undefined;
  const { min, max } = mobile ? RING_RADIUS_PX.mobile : RING_RADIUS_PX.desktop;
  const t = Math.min(1, Math.max(0, Math.log10(Math.max(1, volume)) / Math.log10(RING_FULL_VOLUME)));
  return min + (max - min) * t;
}

const PRUNE_AT = 512;

export class ImpactRingSpawner {
  private readonly lastByTarget = new Map<string, number>();
  private readonly duration: number;
  private readonly cooldown: number;
  private readonly maxPerFrame: number;
  private readonly alpha: number;
  private readonly radiusFor: ImpactRingOptions['radiusFor'];

  constructor(private readonly buffer: RingBuffer, opts: ImpactRingOptions = {}) {
    this.duration = opts.duration ?? 1.4;
    this.cooldown = opts.cooldown ?? 0.6;
    this.maxPerFrame = opts.maxPerFrame ?? 6;
    this.alpha = opts.alpha ?? 235;
    this.radiusFor = opts.radiusFor;
  }

  /** Spawn rings for `events` at animation time `seconds`. Returns how many were spawned. */
  spawn(events: readonly ArrivalEvent[], seconds: number): number {
    let n = 0;
    for (const e of events) {
      if (n >= this.maxPerFrame) break;
      const last = this.lastByTarget.get(e.key);
      if (last !== undefined && seconds - last < this.cooldown) continue;
      this.lastByTarget.set(e.key, seconds);
      this.buffer.write({
        lng: e.lng,
        lat: e.lat,
        start: seconds,
        duration: this.duration,
        color: [e.color[0], e.color[1], e.color[2], this.alpha],
        radius: this.radiusFor?.(e),
      });
      n++;
    }
    if (n > 0) this.buffer.commit();
    if (this.lastByTarget.size > PRUNE_AT) this.prune(seconds);
    return n;
  }

  /** Forget cooldowns (call when the data set changes). */
  reset(): void {
    this.lastByTarget.clear();
  }

  private prune(seconds: number): void {
    for (const [key, at] of this.lastByTarget) {
      if (seconds - at >= this.cooldown) this.lastByTarget.delete(key);
    }
  }
}
