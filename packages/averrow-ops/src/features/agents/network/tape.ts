// Run tape geometry and lanes: pure, shared by RunTape and its tests.

import {
  FEED_GROUP_LABEL, FEED_GROUP_NODE, FEED_NRD, type Placement,
} from './model';
import type { Span, TimelineIndex } from './activity';

export const TAPE_WINDOW_MS = 60 * 60 * 1000;
export const TAPE_PAD_MS = 90 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Right-hand padding past NOW: 90 s on the 1h axis, scaled for longer ones. */
export function tapePadMs(windowMs: number): number {
  return (windowMs * TAPE_PAD_MS) / TAPE_WINDOW_MS;
}

/** Grid spacing: every 10 minutes on the hour view, every 2 hours on 24h. */
export function tapeTickMs(windowMs: number): number {
  return windowMs >= DAY_MS ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000;
}

/** Merge threshold: bars shorter than one pixel are merged only on long
 *  windows (the 1h view draws every run, exactly as before). */
export function mergeQuantumMs(windowMs: number, plotWidthPx: number): number {
  if (windowMs <= TAPE_WINDOW_MS) return 0;
  return Math.max(1000, Math.round(windowMs / Math.max(plotWidthPx, 1) / 1000) * 1000);
}
export const TAPE_GUTTER = 156;
export const TAPE_TOP = 34;
export const TAPE_LANE_H = 20;
export const TAPE_MIN_WIDTH = 640;

export interface TapeLane {
  id: string;
  label: string;
  /** Click selects the agent (feed lanes are not selectable). */
  agent: boolean;
  muted: boolean;
  tag?: 'retired' | 'on demand' | 'ops job';
}

export interface TapeLanes {
  lanes: TapeLane[];
  /** Canvas agents with no run in the window (not drawn). */
  quiet: number;
}

const GROUP_ORDER = [FEED_GROUP_NODE.ingest, FEED_GROUP_NODE.enrichment, FEED_GROUP_NODE.social, FEED_NRD];
const GROUP_LABEL: Record<string, string> = {
  [FEED_GROUP_NODE.ingest]: FEED_GROUP_LABEL.ingest,
  [FEED_GROUP_NODE.enrichment]: FEED_GROUP_LABEL.enrichment,
  [FEED_GROUP_NODE.social]: FEED_GROUP_LABEL.social,
  [FEED_NRD]: 'nrd_hagezi',
};

/** One lane per feed group, then every agent that ran, in stage order.
 *  Retired, on-demand and ops-job ids appear (muted, tagged) only if they ran. */
export function buildTapeLanes(
  placement: Placement,
  index: TimelineIndex,
  labelOf: (id: string) => string,
): TapeLanes {
  const has = (id: string) => (index.lanes.get(id)?.length ?? 0) > 0;
  const lanes: TapeLane[] = [];
  const used = new Set<string>();
  for (const g of GROUP_ORDER) {
    if (has(g)) { lanes.push({ id: g, label: GROUP_LABEL[g]!, agent: false, muted: false }); used.add(g); }
  }
  let quiet = 0;
  for (const id of Object.values(placement.stages).flat()) {
    if (has(id)) { lanes.push({ id, label: labelOf(id), agent: true, muted: false }); used.add(id); }
    else quiet++;
  }
  const tail: Array<[string[], TapeLane['tag']]> = [
    [placement.onDemand, 'on demand'], [placement.retired, 'retired'], [placement.ops, 'ops job'],
  ];
  for (const [ids, tag] of tail) {
    for (const id of ids) {
      if (has(id)) { lanes.push({ id, label: labelOf(id), agent: true, muted: true, tag }); used.add(id); }
    }
  }
  // Run writers the registry does not know (daily_briefing, daily_snapshots...).
  for (const id of [...index.lanes.keys()].sort()) {
    if (used.has(id) || id === 'flight_control' || id.startsWith('feeds:') || id.startsWith('feed:')) continue;
    lanes.push({ id, label: labelOf(id), agent: false, muted: true, tag: 'ops job' });
  }
  return { lanes, quiet };
}

export interface TapeGeometry {
  width: number;
  height: number;
  gx: number;
  x1: number;
  top: number;
  lh: number;
  startMs: number;
  endMs: number;
  /** Time -> x. */
  x: (ms: number) => number;
  /** x -> time (inverse of `x`). */
  t: (x: number) => number;
}

export function tapeGeometry(width: number, laneCount: number, now: number, windowMs: number = TAPE_WINDOW_MS): TapeGeometry {
  const w = Math.max(width, TAPE_MIN_WIDTH);
  const gx = TAPE_GUTTER;
  const x1 = w - 16;
  const startMs = now - windowMs;
  const endMs = now + tapePadMs(windowMs);
  const px = (x1 - gx) / (endMs - startMs);
  return {
    width: w, height: TAPE_TOP + Math.max(laneCount, 1) * TAPE_LANE_H + 12,
    gx, x1, top: TAPE_TOP, lh: TAPE_LANE_H, startMs, endMs,
    x: (ms) => gx + (ms - startMs) * px,
    t: (x) => startMs + (x - gx) / px,
  };
}

/** A drawn bar: a run/pull, or several sub-pixel ones merged into one mark. */
export interface Bar extends Span {
  /** For a merged bar, the span shown in tooltips (the worst status, else the latest). */
  rep?: Span;
  /** How many runs a merged bar stands for. */
  count?: number;
}

const barCache = new WeakMap<TimelineIndex, Map<string, Bar[]>>();
const STATUS_RANK: Record<string, number> = { failed: 3, partial: 2, running: 1, success: 0 };

/**
 * The bars of a lane at a given merge quantum, computed once per payload and
 * width. With quantum 0 (the hour view) these are the spans themselves. A
 * longer window merges runs shorter than `quantum` whose gap is at most
 * `quantum`, so a lane never holds more bars than the plot has pixels.
 */
export function barsForLane(index: TimelineIndex, lane: string, quantum: number): readonly Bar[] {
  const spans = index.lanes.get(lane) ?? [];
  if (quantum <= 0) {
    // No merging, but failures still draw (and hit-test) on top of an overlapping later run.
    if (!spans.some((s) => s.status === 'failed')) return spans;
    let perIndex0 = barCache.get(index);
    if (!perIndex0) { perIndex0 = new Map(); barCache.set(index, perIndex0); }
    const key0 = `${lane}|0`;
    const hit0 = perIndex0.get(key0);
    if (hit0) return hit0;
    const ordered: Bar[] = [...spans.filter((s) => s.status !== 'failed'), ...spans.filter((s) => s.status === 'failed')];
    perIndex0.set(key0, ordered);
    return ordered;
  }
  let perIndex = barCache.get(index);
  if (!perIndex) { perIndex = new Map(); barCache.set(index, perIndex); }
  const key = `${lane}|${quantum}`;
  const hit = perIndex.get(key);
  if (hit) return hit;
  const out: Bar[] = [];
  // Failures are never merged away: they keep their own bar and come last, so they draw (and hit-test) on top.
  const failed: Bar[] = [];
  let group: { first: Span; last: Span; end: number; worst: Span; n: number } | null = null;
  const flush = () => {
    if (!group) return;
    if (group.n === 1) out.push(group.first);
    else {
      out.push({
        ...group.worst, startMs: group.first.startMs, endMs: group.end, clipped: group.first.clipped,
        status: group.worst.status, rep: group.worst, count: group.n,
      });
    }
    group = null;
  };
  for (const s of spans) {
    if (s.status === 'failed') { failed.push(s); continue; }
    const tiny = s.endMs !== null && s.endMs - s.startMs < quantum;
    if (!tiny) { flush(); out.push(s); continue; }
    const end = s.endMs as number;
    if (group && s.startMs - group.end <= quantum) {
      group.last = s;
      group.end = Math.max(group.end, end);
      group.n++;
      if ((STATUS_RANK[s.status] ?? 0) >= (STATUS_RANK[group.worst.status] ?? 0)) group.worst = s;
    } else {
      flush();
      group = { first: s, last: s, end, worst: s, n: 1 };
    }
  }
  flush();
  out.push(...failed);
  perIndex.set(key, out);
  return out;
}

export interface TapeHit { lane: number; span: Span | null }

/** Lane (and run bar) under a point; null outside the lanes. */
export function tapeHitTest(
  g: TapeGeometry,
  lanes: readonly TapeLane[],
  index: TimelineIndex,
  now: number,
  px: number,
  py: number,
  quantum = 0,
): TapeHit | null {
  const lane = Math.floor((py - g.top) / g.lh);
  if (lane < 0 || lane >= lanes.length || px < 0 || px > g.width) return null;
  if (px < g.gx) return { lane, span: null };
  const spans = barsForLane(index, lanes[lane]!.id, quantum);
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]!;
    const xa = g.x(Math.max(s.startMs, g.startMs));
    const xb = g.x(Math.min(s.endMs ?? Math.min(now, index.capMs), g.endMs));
    if (px >= xa - 3 && px <= Math.max(xb, xa + 3) + 3) return { lane, span: s.rep ?? s };
  }
  return { lane, span: null };
}
