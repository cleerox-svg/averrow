import { describe, it, expect } from 'vitest';
import { AnimationClock } from './animation-clock';

/** Drive a clock for `seconds` of real time at a fixed frame rate. */
function run(clock: AnimationClock, seconds: number, fps: number, startMs = 1000): number {
  const frame = 1000 / fps;
  const frames = Math.round(seconds * fps);
  clock.tick(startMs); // baseline
  for (let i = 1; i <= frames; i++) clock.tick(startMs + i * frame);
  return clock.currentTime;
}

describe('AnimationClock', () => {
  it('advances by wall-clock time, independent of frame rate', () => {
    const at = (fps: number) => run(new AnimationClock({ cycleLength: 3600 }), 2, fps);
    const t30 = at(30);
    expect(t30).toBeCloseTo(120, 5); // 2s * 60 units/s
    expect(at(60)).toBeCloseTo(t30, 5);
    expect(at(144)).toBeCloseTo(t30, 3);
  });

  it('wraps at the cycle length', () => {
    const c = new AnimationClock({ cycleLength: 100 });
    run(c, 2, 60); // 120 units
    expect(c.currentTime).toBeCloseTo(20, 5);
    expect(c.currentTime).toBeLessThan(100);
  });

  it('does not advance while paused and resumes without a jump', () => {
    const c = new AnimationClock({ cycleLength: 3600 });
    c.tick(0);
    c.tick(50);
    const before = c.currentTime;
    c.pause();
    c.tick(5000);
    expect(c.currentTime).toBe(before);
    c.play();
    c.tick(5016); // first tick after play only re-baselines
    expect(c.currentTime).toBe(before);
    c.tick(5066);
    expect(c.currentTime).toBeGreaterThan(before);
  });

  it('clamps huge deltas (tab restored after a long hide)', () => {
    const c = new AnimationClock({ cycleLength: 3600, maxDeltaMs: 100 });
    c.tick(0);
    c.tick(60_000);
    expect(c.currentTime).toBeCloseTo(6, 5); // 100ms * 60u/s
  });

  it('resync drops the gap entirely', () => {
    const c = new AnimationClock({ cycleLength: 3600 });
    c.tick(0);
    c.resync();
    c.tick(10_000);
    expect(c.currentTime).toBe(0);
  });

  it('speed scales advancement and supports reverse', () => {
    const fast = new AnimationClock({ cycleLength: 3600, speed: 2 });
    expect(run(fast, 1, 60)).toBeCloseTo(120, 5);
    const rev = new AnimationClock({ cycleLength: 3600, speed: -1 });
    run(rev, 1, 60);
    expect(rev.currentTime).toBeCloseTo(3600 - 60, 5);
  });

  it('seek wraps into range and survives subsequent ticks', () => {
    const c = new AnimationClock({ cycleLength: 100 });
    c.seek(250);
    expect(c.currentTime).toBe(50);
    c.seek(-10);
    expect(c.currentTime).toBe(90);
    c.seekFraction(0.25);
    expect(c.currentTime).toBe(25);
    c.seekFraction(5);
    expect(c.currentTime).toBe(0); // clamped to 1 => wraps to 0
    c.seek(Number.NaN);
    expect(c.currentTime).toBe(0);
  });

  it('seek while paused holds position', () => {
    const c = new AnimationClock({ cycleLength: 100, paused: true });
    c.tick(0);
    c.seek(40);
    c.tick(500);
    expect(c.currentTime).toBe(40);
    expect(c.isPlaying).toBe(false);
  });

  it('rejects an invalid cycle length', () => {
    expect(() => new AnimationClock({ cycleLength: 0 })).toThrow(RangeError);
  });
});
