// Replay of the last hour, client-side from the loaded timeline payload, and
// the live-status chip model. Pure functions: no DOM, no React.

export const REPLAY_SPEEDS = [1, 10, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 10;
export const STEP_MS = 60_000;
export const STEP_FINE_MS = 10_000;
/** A hidden tab must not jump the playhead when frames resume. */
export const MAX_FRAME_MS = 250;

export function clampPlayhead(ms: number, start: number, end: number): number {
  return Math.min(Math.max(ms, start), end);
}

/** Advance the playhead by `dtMs` of wall time. Speed only scales the clock. */
export function advancePlayhead(
  playhead: number, dtMs: number, speed: number, start: number, end: number,
): { playhead: number; atEnd: boolean } {
  const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
  const next = clampPlayhead(playhead + dt * speed, start, end);
  return { playhead: next, atEnd: next >= end };
}

/** One keyboard step: 1 min, or 10 s with Shift. */
export function stepPlayhead(
  playhead: number, direction: -1 | 1, fine: boolean, start: number, end: number,
): number {
  return clampPlayhead(playhead + direction * (fine ? STEP_FINE_MS : STEP_MS), start, end);
}

const p2 = (n: number) => String(n).padStart(2, '0');
export function fmtHM(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
export function fmtHMS(ms: number): string {
  const d = new Date(ms);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

/** "20s", "2m 05s": seconds stay two digits past a minute so digits do not jump. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${p2(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${p2(m % 60)}m`;
}

export type ChipState =
  | 'live' | 'paused' | 'motion-off' | 'reconnecting' | 'offline' | 'connecting' | 'replay';

export interface ChipInput {
  /** Replay mode, or null when live. */
  replay: { playhead: number; atEnd: boolean; newData: boolean } | null;
  /** A payload is on screen. */
  hasPayload: boolean;
  /** The last fetch failed. */
  fetchFailed: boolean;
  /** The OS asks for reduced motion. */
  osReduced: boolean;
  /** The Pause control is on. */
  paused: boolean;
  /** When the current payload was received (client clock, ms). */
  receivedAt: number;
  /** The payload's generated_at (ISO), if any. */
  generatedAt: string | undefined;
  /** Client clock, ms. */
  now: number;
}

export interface ChipModel {
  state: ChipState;
  /** Visible text; changes with the age tick. */
  label: string;
  /** Tooltip: the secondary "data as of" line. */
  title: string;
  /** Screen-reader text. Depends on the state only, never on the age tick. */
  announce: string;
}

export function chipModel(i: ChipInput): ChipModel {
  const gen = i.generatedAt ? Date.parse(i.generatedAt) : NaN;
  const title = Number.isFinite(gen) ? `Data as of ${fmtHMS(gen)} UTC` : 'No data yet';
  const age = formatAge(i.now - i.receivedAt);

  if (i.replay) {
    const r = i.replay;
    let label = `Replay · ${fmtHM(r.playhead)} UTC`;
    let announce = 'Replay mode';
    if (r.atEnd) { label += ' · end of data'; announce += ', end of data'; }
    if (r.newData) { label += ' · new data available'; announce += ', new data available'; }
    return { state: 'replay', label, title, announce };
  }
  if (!i.hasPayload) {
    return i.fetchFailed
      ? { state: 'offline', label: 'Offline', title, announce: 'Offline' }
      : { state: 'connecting', label: 'Connecting…', title, announce: 'Connecting' };
  }
  if (i.fetchFailed) {
    return {
      state: 'reconnecting', label: `Reconnecting… · ${age} old`, title,
      announce: 'Reconnecting. Showing older data',
    };
  }
  if (i.osReduced) {
    return { state: 'motion-off', label: `Motion off · updated ${age} ago`, title, announce: 'Motion off' };
  }
  if (i.paused) {
    return { state: 'paused', label: `Paused · updated ${age} ago`, title, announce: 'Motion paused' };
  }
  return { state: 'live', label: `Live · updated ${age} ago`, title, announce: 'Live' };
}
