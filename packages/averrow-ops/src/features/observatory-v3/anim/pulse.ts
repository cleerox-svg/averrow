/**
 * Pulse parameters: severity -> heartbeat, and phase keys.
 *
 * `animTime` fed to PulseExtension is in SECONDS (DeckFrame.seconds), so rates
 * are radians per second.
 */

export type PulseSeverity = string | null | undefined;

const TAU = Math.PI * 2;

/** Rad/s. Critical breathes fastest (period ~1.2s), low slowest (~3.9s). */
const RATE_BY_SEVERITY: Record<string, number> = {
  critical: TAU / 1.2,
  high: TAU / 1.8,
  medium: TAU / 2.6,
  low: TAU / 3.9,
};
const DEFAULT_RATE = TAU / 3.9;

/** Fractional radius swing (0.28 => +-28%). */
const AMP_BY_SEVERITY: Record<string, number> = {
  critical: 0.28,
  high: 0.22,
  medium: 0.16,
  low: 0.1,
};
const DEFAULT_AMP = 0.1;

export function pulseRateForSeverity(severity: PulseSeverity): number {
  return RATE_BY_SEVERITY[(severity ?? '').toLowerCase()] ?? DEFAULT_RATE;
}

export function pulseAmpForSeverity(severity: PulseSeverity): number {
  return AMP_BY_SEVERITY[(severity ?? '').toLowerCase()] ?? DEFAULT_AMP;
}

/**
 * Deterministic phase in [0, 2π) for a key. Give every node of one operation the
 * same key and they share a phase: a synchronised heartbeat.
 */
export function phaseForKey(key: string | number): number {
  const s = String(key);
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * TAU;
}
