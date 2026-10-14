import { describe, it, expect } from 'vitest';
import {
  ringMaskVisible, RING_MASK_DASH_DUTY, glslMod, pulseScale, ringAge, ringProgress, ringActive, easeOutCubic, ringScale, ringAlpha, ringState,
  dashVisible, RING_FADE_IN,
} from './shader-math';
import {
  pulseRateForSeverity, pulseAmpForSeverity, phaseForKey,
} from './pulse';

describe('pulse math', () => {
  it('scale is 1 + amp*sin(t*rate+phase)', () => {
    expect(pulseScale(0, 2, 0, 0.3)).toBeCloseTo(1, 10);
    expect(pulseScale(Math.PI / 2, 1, 0, 0.3)).toBeCloseTo(1.3, 10);
    expect(pulseScale(0, 1, -Math.PI / 2, 0.3)).toBeCloseTo(0.7, 10);
  });

  it('amp 0 disables the pulse entirely', () => {
    for (const t of [0, 1.7, 99]) expect(pulseScale(t, 5, 1.2, 0)).toBe(1);
  });

  it('never goes negative for amp < 1', () => {
    for (let t = 0; t < 10; t += 0.1) expect(pulseScale(t, 3, 0.5, 0.28)).toBeGreaterThan(0);
  });

  it('equal phase => equal scale (synchronised heartbeat); different phase differs', () => {
    const phase = phaseForKey('op-42');
    expect(pulseScale(3.3, 4, phase, 0.2)).toBe(pulseScale(3.3, 4, phaseForKey('op-42'), 0.2));
    expect(pulseScale(3.3, 4, phaseForKey('op-43'), 0.2)).not.toBe(pulseScale(3.3, 4, phase, 0.2));
  });
});

describe('severity -> pulse mapping', () => {
  it('critical breathes fastest, then high, medium, low', () => {
    const r = ['critical', 'high', 'medium', 'low'].map(pulseRateForSeverity);
    expect(r[0]).toBeGreaterThan(r[1]!);
    expect(r[1]).toBeGreaterThan(r[2]!);
    expect(r[2]).toBeGreaterThan(r[3]!);
  });

  it('amplitude also scales with severity', () => {
    expect(pulseAmpForSeverity('critical')).toBeGreaterThan(pulseAmpForSeverity('low'));
  });

  it('is case-insensitive and falls back to the slowest/lowest for unknown values', () => {
    expect(pulseRateForSeverity('CRITICAL')).toBe(pulseRateForSeverity('critical'));
    expect(pulseRateForSeverity(null)).toBe(pulseRateForSeverity('low'));
    expect(pulseRateForSeverity('???')).toBe(pulseRateForSeverity('low'));
    expect(pulseAmpForSeverity(undefined)).toBe(pulseAmpForSeverity('low'));
  });

  it('critical period is ~1.2s', () => {
    expect((2 * Math.PI) / pulseRateForSeverity('critical')).toBeCloseTo(1.2, 6);
  });
});

describe('phaseForKey', () => {
  it('is deterministic and within [0, 2π)', () => {
    for (const k of ['a', 'US|phishing', 42, '']) {
      const p = phaseForKey(k);
      expect(p).toBe(phaseForKey(k));
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(2 * Math.PI);
    }
  });

  it('spreads distinct keys', () => {
    const phases = new Set(Array.from({ length: 50 }, (_, i) => phaseForKey(`op-${i}`).toFixed(4)));
    expect(phases.size).toBeGreaterThan(45);
  });
});

describe('ring math', () => {
  it('age and progress', () => {
    expect(ringAge(10, 4)).toBe(6);
    expect(ringProgress(10, 4, 12)).toBeCloseTo(0.5, 10);
  });

  it('active window is the closed interval [0, duration]', () => {
    expect(ringActive(4, 4, 2)).toBe(true); // age 0
    expect(ringActive(6, 4, 2)).toBe(true); // age == duration
    expect(ringActive(3.999, 4, 2)).toBe(false); // before spawn
    expect(ringActive(6.001, 4, 2)).toBe(false); // after expiry
  });

  it('empty slots (start far in the past) are inactive', () => {
    expect(ringActive(1234, -1e9, 1)).toBe(false);
  });

  it('a zero duration cannot divide by zero', () => {
    expect(Number.isFinite(ringProgress(5, 5, 0))).toBe(true);
  });

  it('radius eases out from r0 to r1', () => {
    expect(ringScale(0, 0.2, 1)).toBeCloseTo(0.2, 10);
    expect(ringScale(1, 0.2, 1)).toBeCloseTo(1, 10);
    // ease-out: more than halfway at p = 0.5
    expect(ringScale(0.5, 0.2, 1)).toBeGreaterThan(0.6);
    // monotonic
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const s = ringScale(p, 0.2, 1);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('easeOutCubic clamps its input', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it('alpha fades in quickly, peaks, then falls to 0 at expiry', () => {
    expect(ringAlpha(0)).toBe(0);
    expect(ringAlpha(RING_FADE_IN)).toBeGreaterThan(0.8);
    expect(ringAlpha(0.5)).toBeLessThan(ringAlpha(0.2));
    expect(ringAlpha(1)).toBe(0);
  });

  it('ringState collapses (scale 0, alpha 0) outside the window and is live inside it', () => {
    expect(ringState(3, 4, 2, 0.1, 1)).toEqual({ active: false, scale: 0, alpha: 0 });
    expect(ringState(7, 4, 2, 0.1, 1)).toEqual({ active: false, scale: 0, alpha: 0 });
    const mid = ringState(5, 4, 2, 0.1, 1);
    expect(mid.active).toBe(true);
    expect(mid.scale).toBeGreaterThan(0.1);
    expect(mid.scale).toBeLessThan(1);
    expect(mid.alpha).toBeGreaterThan(0);
  });
});

describe('dash flow math', () => {
  it('glslMod follows the sign of the divisor', () => {
    expect(glslMod(5, 3)).toBe(2);
    expect(glslMod(-1, 3)).toBe(2);
    expect(glslMod(-3, 3)).toBeCloseTo(0, 10);
  });

  it('visible inside the dash, hidden in the gap', () => {
    expect(dashVisible(0.2, 0, 0.6, 0.9, 1)).toBe(true);
    expect(dashVisible(1.0, 0, 0.6, 0.9, 1)).toBe(false);
    expect(dashVisible(1.6, 0, 0.6, 0.9, 1)).toBe(true); // next period (cycle 1.5)
  });

  it('positive speed shifts the pattern toward increasing distance', () => {
    // a dash edge at distance 0.6 moves to 0.6 + speed*t
    expect(dashVisible(0.7, 0, 0.6, 0.9, 1)).toBe(false);
    expect(dashVisible(0.7, 0.3, 0.6, 0.9, 1)).toBe(true);
  });

  it('negative speed reverses and the pattern is periodic in t', () => {
    const cycle = 0.6 + 0.9;
    for (const d of [0.1, 0.5, 0.9, 1.4]) {
      // speed 2 for cycle/2 seconds advances exactly one full period
      expect(dashVisible(d, 0, 0.6, 0.9, 2)).toBe(dashVisible(d, cycle / 2, 0.6, 0.9, 2));
    }
    // reversed speed moves the other way
    expect(dashVisible(0.7, 0.3, 0.6, 0.9, -1)).toBe(false);
  });
});

describe('ringMaskVisible', () => {
  it('a solid full ring is always visible', () => {
    for (const turn of [0, 0.3, 0.999]) expect(ringMaskVisible(turn, 1, 0, 0, 5)).toBe(true);
  });
  it('a fraction hides the rest of the circle, clockwise from the top', () => {
    expect(ringMaskVisible(0.1, 0.62, 0, 0, 0)).toBe(true);
    expect(ringMaskVisible(0.62, 0.62, 0, 0, 0)).toBe(true);
    expect(ringMaskVisible(0.63, 0.62, 0, 0, 0)).toBe(false);
    expect(ringMaskVisible(0.9, 0, 0, 0, 0)).toBe(false);
  });
  it('dashes alternate around the circle with the shared duty cycle', () => {
    const N = 10;
    const period = 1 / N;
    expect(ringMaskVisible(period * (RING_MASK_DASH_DUTY - 0.01), 1, N, 0, 0)).toBe(true);
    expect(ringMaskVisible(period * (RING_MASK_DASH_DUTY + 0.05), 1, N, 0, 0)).toBe(false);
    const visible = Array.from({ length: 1000 }, (_, i) => ringMaskVisible(i / 1000, 1, N, 0, 0)).filter(Boolean).length;
    expect(visible / 1000).toBeCloseTo(RING_MASK_DASH_DUTY, 1);
  });
  it('spin rotates the dashes clockwise over time and repeats each revolution', () => {
    const N = 8;
    const at = (turn: number, t: number) => ringMaskVisible(turn, 1, N, 0.5, t);
    // after half a dash period of travel the pattern is shifted by that much
    const shifted = 1 / N / 2;
    for (const turn of [0.01, 0.07, 0.31]) expect(at(turn + shifted, (shifted * N) / 0.5)).toBe(at(turn, 0));
    // one full revolution (2 s at 0.5 rev/s) returns the same pattern
    for (const turn of [0.02, 0.2, 0.55, 0.9]) expect(at(turn, 2)).toBe(at(turn, 0));
  });
});
