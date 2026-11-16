// Replay of the last hour, client-side from the loaded timeline payload, and
// the live-status chip model. Pure functions: no DOM, no React.

import type { TimelineWindow } from '@/hooks/useAgentTimeline';

/** Replay clock multiplier (clock seconds per wall second). */
export type ReplaySpeed = number;
export const REPLAY_SPEEDS: Record<TimelineWindow, readonly ReplaySpeed[]> = {
  '1h': [1, 10, 60],
  '24h': [60, 600, 3600],
};
export const DEFAULT_REPLAY_SPEEDS: Record<TimelineWindow, ReplaySpeed> = { '1h': 10, '24h': 600 };
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = DEFAULT_REPLAY_SPEEDS['1h'];
export const STEP_MS = 60_000;
export const STEP_FINE_MS = 10_000;
/** Slider steps per window: arrows, Shift+arrows, and PageUp/PageDown (24h only). */
export const SLIDER_STEPS: Record<TimelineWindow, { coarse: number; fine: number; page: number | null }> = {
  '1h': { coarse: STEP_MS, fine: STEP_FINE_MS, page: null },
  '24h': { coarse: 10 * 60_000, fine: 60_000, page: 60 * 60_000 },
};

/** Visible speed label: "10×" on the hour view, "10 min/s" on 24h. */
export function speedLabel(window: TimelineWindow, speed: ReplaySpeed): string {
  if (window === '1h') return `${speed}×`;
  return speed >= 3600 ? `${speed / 3600} h/s` : `${speed / 60} min/s`;
}

/** Spoken speed label. */
export function speedAria(window: TimelineWindow, speed: ReplaySpeed): string {
  if (window === '1h') return `${speed} times speed`;
  return speed >= 3600
    ? `${speed / 3600} ${speed === 3600 ? 'hour' : 'hours'} per second`
    : `${speed / 60} ${speed === 60 ? 'minute' : 'minutes'} per second`;
}
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
  window: TimelineWindow = '1h',
): number {
  const st = SLIDER_STEPS[window];
  return clampPlayhead(playhead + direction * (fine ? st.fine : st.coarse), start, end);
}

/** PageUp / PageDown: a coarse jump on the 24h view (one hour); no-op on 1h. */
export function pagePlayhead(
  playhead: number, direction: -1 | 1, start: number, end: number, window: TimelineWindow,
): number {
  const page = SLIDER_STEPS[window].page;
  return page === null ? playhead : clampPlayhead(playhead + direction * page, start, end);
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
  | 'live' | 'animation-off' | 'animation-off-system' | 'reconnecting' | 'offline' | 'connecting' | 'replay';

export interface ChipInput {
  /** Replay mode, or null when live. */
  replay: { playhead: number; newData: boolean } | null;
  /** A payload is on screen. */
  hasPayload: boolean;
  /** The last fetch failed. */
  fetchFailed: boolean;
  /** The OS asks for reduced motion. */
  osReduced: boolean;
  /** The animation control is off. */
  paused: boolean;
  /** When the current payload was received (client clock, ms). Shown as "checked". */
  receivedAt: number;
  /** The payload's generated_at (ISO), if any. The data age is measured from it. */
  generatedAt: string | undefined;
  /** Client clock, ms. */
  now: number;
}

export interface ChipModel {
  state: ChipState;
  /** Visible text; changes with the age tick. */
  label: string;
  /** Tooltip: data as-of and checked times. */
  title: string;
  /** Screen-reader text. Depends on the state only, never on the age tick. */
  announce: string;
  /** Small badge next to the label, or null. */
  badge: 'New data' | null;
}

export function chipModel(i: ChipInput): ChipModel {
  const gen = i.generatedAt ? Date.parse(i.generatedAt) : NaN;
  const hasGen = Number.isFinite(gen);
  // The endpoint is KV-cached (~60s), so the data is older than the moment it
  // was received: measure from generated_at.
  const age = formatAge(hasGen ? i.now - gen : i.now - i.receivedAt);
  const asOf = hasGen ? `${fmtHMS(gen)} UTC` : null;
  const title = [asOf ? `Data as of ${asOf}` : 'No data yet', i.receivedAt ? `checked ${fmtHMS(i.receivedAt)} UTC` : null]
    .filter(Boolean).join(' · ');

  if (i.replay) {
    const r = i.replay;
    return {
      state: 'replay',
      label: `Replay · ${fmtHM(r.playhead)} UTC${asOf ? ` · data as of ${asOf}` : ''}`,
      title: `${title} · Breaker and event states show their current value.`,
      announce: r.newData ? 'Replay mode, new data available' : 'Replay mode',
      badge: r.newData ? 'New data' : null,
    };
  }
  if (!i.hasPayload) {
    return i.fetchFailed
      ? { state: 'offline', label: 'Offline', title, announce: 'Offline', badge: null }
      : { state: 'connecting', label: 'Connecting…', title, announce: 'Connecting', badge: null };
  }
  if (i.fetchFailed) {
    return {
      state: 'reconnecting', label: `Reconnecting… · ${asOf ? `data from ${asOf}, ` : ''}${age} old`, title,
      announce: 'Reconnecting. Showing older data', badge: null,
    };
  }
  if (i.osReduced) {
    return {
      state: 'animation-off-system', label: `Live · animation off (system setting) · data ${age} old`, title,
      announce: 'Live, animation off by system setting', badge: null,
    };
  }
  if (i.paused) {
    return { state: 'animation-off', label: `Live · animation off · data ${age} old`, title, announce: 'Live, animation off', badge: null };
  }
  return { state: 'live', label: `Live · data ${age} old`, title, announce: 'Live', badge: null };
}

/**
 * Whether a key event on a replay control may be handled. Never when a
 * modifier is held, another handler already took it, or the target is a text
 * field.
 */
export function canHandleReplayKey(e: {
  defaultPrevented: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; target: EventTarget | null;
}): boolean {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return false;
  const t = e.target as HTMLElement | null;
  if (t && typeof t.tagName === 'string') {
    const tag = t.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return false;
  }
  return true;
}
