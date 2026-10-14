import { describe, it, expect } from 'vitest';
import { RingBuffer, ringBufferLayerProps, DEFAULT_RING_CAPACITY } from './ring-buffer';
import { ImpactRingSpawner } from './impact-rings';
import type { ArrivalEvent } from './arrivals';

const ring = (n: number) => ({ lng: n, lat: -n, start: n, duration: 2, color: [10, 20, 30, 200] as [number, number, number, number] });
const info = (index: number) => ({ index, target: [] as number[] });

describe('RingBuffer', () => {
  it('defaults to 256 slots with a stable index array', () => {
    const b = new RingBuffer();
    expect(DEFAULT_RING_CAPACITY).toBe(256);
    expect(b.capacity).toBe(256);
    expect(b.indices).toHaveLength(256);
    expect(b.indices[0]).toBe(0);
    expect(b.indices[255]).toBe(255);
  });

  it('rejects bad capacities', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });

  it('all slots start expired', () => {
    const b = new RingBuffer(8);
    expect(b.activeCount(0)).toBe(0);
    expect(b.activeCount(1e6)).toBe(0);
  });

  it('push writes into typed arrays and bumps version once per commit', () => {
    const b = new RingBuffer(4);
    expect(b.version).toBe(0);
    const slot = b.push(ring(3));
    expect(slot).toBe(0);
    expect(b.version).toBe(1);
    expect(b.positions[0]).toBe(3);
    expect(b.positions[1]).toBe(-3);
    expect(Array.from(b.colors.slice(0, 4))).toEqual([10, 20, 30, 200]);
    expect(b.starts[0]).toBe(3);
    expect(b.durations[0]).toBe(2);
  });

  it('write() batches; commit() publishes with a single bump', () => {
    const b = new RingBuffer(4);
    b.write(ring(1));
    b.write(ring(2));
    b.write(ring(3));
    expect(b.version).toBe(0);
    b.commit();
    expect(b.version).toBe(1);
  });

  it('wraps around, overwriting the oldest slot, without reallocating', () => {
    const b = new RingBuffer(3);
    const positions = b.positions;
    const indices = b.indices;
    for (let i = 1; i <= 5; i++) b.push(ring(i));
    expect(b.positions).toBe(positions);
    expect(b.indices).toBe(indices);
    // slots: 0<-1,4  1<-2,5  2<-3
    expect(b.starts[0]).toBe(4);
    expect(b.starts[1]).toBe(5);
    expect(b.starts[2]).toBe(3);
    expect(b.totalSpawned).toBe(5);
    expect(b.version).toBe(5);
  });

  it('activeCount counts slots inside their life window', () => {
    const b = new RingBuffer(4);
    b.push({ ...ring(0), start: 10, duration: 2 });
    b.push({ ...ring(0), start: 11, duration: 2 });
    expect(b.activeCount(10.5)).toBe(1);
    expect(b.activeCount(11.5)).toBe(2);
    expect(b.activeCount(12.5)).toBe(1);
    expect(b.activeCount(14)).toBe(0);
  });

  it('clear expires everything, resets the head and bumps version', () => {
    const b = new RingBuffer(4);
    b.push(ring(1));
    const v = b.version;
    b.clear();
    expect(b.version).toBeGreaterThan(v);
    expect(b.activeCount(1)).toBe(0);
    expect(b.push(ring(9))).toBe(0);
  });

  it('accessors read slots by index and reuse deck\'s target array', () => {
    const b = new RingBuffer(4);
    b.push(ring(1));
    b.push(ring(2));
    const i1 = info(1);
    expect(b.getPosition(0, i1)).toBe(i1.target);
    expect(i1.target).toEqual([2, -2]);
    expect(b.getColor(0, info(1))).toEqual([10, 20, 30, 200]);
    expect(b.getStart(0, info(1))).toBe(2);
    expect(b.getDuration(0, info(1))).toBe(2);
  });

  it('colour alpha defaults to opaque when omitted', () => {
    const b = new RingBuffer(2);
    b.push({ ...ring(1), color: [1, 2, 3] as unknown as [number, number, number, number] });
    expect(b.colors[3]).toBe(255);
  });
});

describe('ringBufferLayerProps', () => {
  it('binds the stable data + accessors, and keys every updateTrigger to version', () => {
    const b = new RingBuffer(4);
    const a = ringBufferLayerProps(b);
    expect(a.data).toBe(b.indices);
    expect(a.getPosition).toBe(b.getPosition);
    expect(Object.values(a.updateTriggers).every(v => v === 0)).toBe(true);
    b.push(ring(1));
    const c = ringBufferLayerProps(b);
    expect(c.data).toBe(a.data); // same data identity => no data reload
    expect(c.getPosition).toBe(a.getPosition); // stable accessors
    expect(Object.values(c.updateTriggers).every(v => v === 1)).toBe(true);
  });
});

const ev = (key: string, time = 0): ArrivalEvent => ({ time, lng: 1, lat: 2, color: [255, 0, 0, 220], key });

describe('ImpactRingSpawner', () => {
  it('spawns a ring per event and commits once per call', () => {
    const b = new RingBuffer(16);
    const s = new ImpactRingSpawner(b, { duration: 1.4, alpha: 200 });
    expect(s.spawn([ev('a'), ev('b'), ev('c')], 5)).toBe(3);
    expect(b.version).toBe(1);
    expect(b.starts[0]).toBe(5);
    expect(b.durations[0]).toBeCloseTo(1.4);
    expect(b.colors[3]).toBe(200);
  });

  it('applies a per-target cooldown', () => {
    const b = new RingBuffer(16);
    const s = new ImpactRingSpawner(b, { cooldown: 0.6 });
    expect(s.spawn([ev('a')], 1)).toBe(1);
    expect(s.spawn([ev('a')], 1.3)).toBe(0); // inside cooldown
    expect(s.spawn([ev('b')], 1.3)).toBe(1); // other target unaffected
    expect(s.spawn([ev('a')], 1.7)).toBe(1); // cooled down
  });

  it('caps rings per frame and does not bump version when nothing spawned', () => {
    const b = new RingBuffer(16);
    const s = new ImpactRingSpawner(b, { maxPerFrame: 2 });
    expect(s.spawn([ev('a'), ev('b'), ev('c'), ev('d')], 0)).toBe(2);
    const v = b.version;
    expect(s.spawn([ev('a')], 0.1)).toBe(0);
    expect(b.version).toBe(v);
  });

  it('reset forgets cooldowns', () => {
    const b = new RingBuffer(16);
    const s = new ImpactRingSpawner(b, { cooldown: 10 });
    s.spawn([ev('a')], 0);
    expect(s.spawn([ev('a')], 1)).toBe(0);
    s.reset();
    expect(s.spawn([ev('a')], 1)).toBe(1);
  });
});
