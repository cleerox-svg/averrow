import { describe, it, expect } from 'vitest';
import { spinAllowed, spinStep, SPIN_IDLE_MS, SPIN_DEG_PER_S, SPIN_MAX_DT, type SpinInputs } from './spin';

const base: SpinInputs = {
  projection: 'globe', reducedMotion: false, pageVisible: true, inView: true, held: false, cameraBusy: false,
  nowMs: 100_000, lastInteractionMs: 100_000 - SPIN_IDLE_MS,
};
const w = (over: Partial<SpinInputs>): SpinInputs => ({ ...base, ...over });

describe('spinAllowed: the globe drifts only when nobody is using it', () => {
  it('spins once the idle time has passed, on the globe', () => {
    expect(spinAllowed(base)).toBe(true);
  });
  it('waits for the idle time after the last interaction', () => {
    expect(spinAllowed(w({ lastInteractionMs: 100_000 }))).toBe(false);
    expect(spinAllowed(w({ lastInteractionMs: 100_000 - SPIN_IDLE_MS + 1 }))).toBe(false);
    expect(spinAllowed(w({ lastInteractionMs: 100_000 - SPIN_IDLE_MS }))).toBe(true);
  });
  it('honours a custom idle time', () => {
    expect(spinAllowed(w({ lastInteractionMs: 100_000 - 3000, idleMs: 3000 }))).toBe(true);
    expect(spinAllowed(w({ lastInteractionMs: 100_000 - 2999, idleMs: 3000 }))).toBe(false);
  });
  it('never on the flat map', () => {
    expect(spinAllowed(w({ projection: 'flat' }))).toBe(false);
  });
  it('never under reduced motion', () => {
    expect(spinAllowed(w({ reducedMotion: true }))).toBe(false);
  });
  it('pauses in a hidden tab and when the map is off screen', () => {
    expect(spinAllowed(w({ pageVisible: false }))).toBe(false);
    expect(spinAllowed(w({ inView: false }))).toBe(false);
  });
  it('holds while something is selected, and while the camera is moving for another reason', () => {
    expect(spinAllowed(w({ held: true }))).toBe(false);
    expect(spinAllowed(w({ cameraBusy: true }))).toBe(false);
  });
});

describe('spinStep', () => {
  it('slides the view west (the surface turns east) at the drift speed', () => {
    expect(spinStep(10, 0.2)).toBeCloseTo(10 - SPIN_DEG_PER_S * 0.2, 9);
    expect(spinStep(10, 0.2, 2)).toBeCloseTo(9.6, 9);
  });
  it('is frame-rate independent: two half steps equal one whole', () => {
    expect(spinStep(spinStep(40, 0.05), 0.05)).toBeCloseTo(spinStep(40, 0.1), 9);
  });
  it('wraps across the antimeridian into [-180, 180)', () => {
    const lng = spinStep(-179, 0.25, 8);
    expect(lng).toBeGreaterThanOrEqual(-180);
    expect(lng).toBeLessThan(180);
    expect(lng).toBeCloseTo(179, 9);
  });
  it('clamps a stalled frame instead of jumping the globe, and ignores negative time', () => {
    expect(spinStep(0, 60)).toBeCloseTo(-SPIN_DEG_PER_S * SPIN_MAX_DT, 9);
    expect(spinStep(5, -3)).toBe(5);
  });
});
