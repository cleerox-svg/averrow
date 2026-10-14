/**
 * RingBuffer — a fixed pool of ring slots backed by typed arrays.
 *
 * Impact rings, sonar pings and migration ghosts are short-lived and frequent.
 * Allocating a layer (or even a data array) per ring would churn the GC and
 * force attribute re-uploads. Instead the layer is created ONCE with `capacity`
 * instances over a stable index array; spawning a ring overwrites the oldest slot
 * in place and bumps `version`, which feeds `updateTriggers` so deck re-reads
 * the (tiny) pool. Expired slots cost nothing — RingExtension collapses them.
 *
 * Time is in the same domain as the layer's `animTime` (seconds).
 */

import type { Rgba } from '../lib/map-colors';

export const DEFAULT_RING_CAPACITY = 256;

/** Far enough in the past that (animTime - start) is always beyond any duration. */
const EMPTY_START = -1e9;

export interface RingSpawn {
  lng: number;
  lat: number;
  /** Spawn time, seconds (same domain as animTime). */
  start: number;
  /** Life, seconds. */
  duration: number;
  color: Rgba;
}

/** Deck's per-object accessor context (subset we use). */
interface AccessorInfo {
  index: number;
  target: number[];
}

export class RingBuffer {
  readonly capacity: number;
  /** Stable instance array for `data`: [0 .. capacity-1]. Never reallocated. */
  readonly indices: readonly number[];
  /** Bumped by every push/clear; wire into `updateTriggers`. */
  version = 0;

  readonly positions: Float32Array; // lng, lat per slot
  readonly colors: Uint8ClampedArray; // r, g, b, a per slot
  readonly starts: Float32Array;
  readonly durations: Float32Array;

  private head = 0;
  private spawned = 0;

  constructor(capacity: number = DEFAULT_RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
    this.indices = Array.from({ length: capacity }, (_, i) => i);
    this.positions = new Float32Array(capacity * 2);
    this.colors = new Uint8ClampedArray(capacity * 4);
    this.starts = new Float32Array(capacity).fill(EMPTY_START);
    this.durations = new Float32Array(capacity).fill(1);
  }

  /** Number of rings pushed since creation / clear (monotonic; may exceed capacity). */
  get totalSpawned(): number {
    return this.spawned;
  }

  /** Write one ring into the next slot (overwriting the oldest). Returns the slot. Does NOT bump version: call `commit()` after a batch. */
  write(ring: RingSpawn): number {
    const slot = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.spawned++;
    this.positions[slot * 2] = ring.lng;
    this.positions[slot * 2 + 1] = ring.lat;
    this.colors[slot * 4] = ring.color[0];
    this.colors[slot * 4 + 1] = ring.color[1];
    this.colors[slot * 4 + 2] = ring.color[2];
    this.colors[slot * 4 + 3] = ring.color[3] ?? 255;
    this.starts[slot] = ring.start;
    this.durations[slot] = ring.duration;
    return slot;
  }

  /** Publish pending writes to deck (bumps `version`). Batch several writes per frame, then commit once. */
  commit(): void {
    this.version++;
  }

  /** write + commit. */
  push(ring: RingSpawn): number {
    const slot = this.write(ring);
    this.commit();
    return slot;
  }

  /** Expire every slot. */
  clear(): void {
    this.starts.fill(EMPTY_START);
    this.head = 0;
    this.spawned = 0;
    this.commit();
  }

  /** How many slots are inside their life window at `now`. */
  activeCount(now: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const age = now - this.starts[i]!;
      if (age >= 0 && age <= this.durations[i]!) n++;
    }
    return n;
  }

  // Accessors (stable, allocation-free; deck passes a reusable `target`) ──

  readonly getPosition = (_: number, info: AccessorInfo): [number, number] => {
    const t = info.target;
    const i = info.index * 2;
    t[0] = this.positions[i]!;
    t[1] = this.positions[i + 1]!;
    return t as [number, number];
  };

  readonly getColor = (_: number, info: AccessorInfo): [number, number, number, number] => {
    const t = info.target;
    const i = info.index * 4;
    t[0] = this.colors[i]!;
    t[1] = this.colors[i + 1]!;
    t[2] = this.colors[i + 2]!;
    t[3] = this.colors[i + 3]!;
    return t as [number, number, number, number];
  };

  readonly getStart = (_: number, info: AccessorInfo): number => this.starts[info.index]!;
  readonly getDuration = (_: number, info: AccessorInfo): number => this.durations[info.index]!;
}

/**
 * Props that bind a ScatterplotLayer(+RingExtension) to a RingBuffer. Spread into
 * the layer; `version` in updateTriggers is what makes deck re-read the pool.
 */
export function ringBufferLayerProps(buffer: RingBuffer) {
  const v = buffer.version;
  return {
    data: buffer.indices as number[],
    getPosition: buffer.getPosition,
    getLineColor: buffer.getColor,
    getRingStart: buffer.getStart,
    getRingDuration: buffer.getDuration,
    updateTriggers: {
      getPosition: v,
      getLineColor: v,
      getRingStart: v,
      getRingDuration: v,
    },
  };
}
