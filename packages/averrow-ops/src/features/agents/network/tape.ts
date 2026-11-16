// Run tape geometry and lanes: pure, shared by RunTape and its tests.

import {
  FEED_GROUP_LABEL, FEED_GROUP_NODE, FEED_NRD, type Placement,
} from './model';
import type { Span, TimelineIndex } from './activity';

export const TAPE_WINDOW_MS = 60 * 60 * 1000;
export const TAPE_PAD_MS = 90 * 1000;
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

export function tapeGeometry(width: number, laneCount: number, now: number): TapeGeometry {
  const w = Math.max(width, TAPE_MIN_WIDTH);
  const gx = TAPE_GUTTER;
  const x1 = w - 16;
  const startMs = now - TAPE_WINDOW_MS;
  const endMs = now + TAPE_PAD_MS;
  const px = (x1 - gx) / (endMs - startMs);
  return {
    width: w, height: TAPE_TOP + Math.max(laneCount, 1) * TAPE_LANE_H + 12,
    gx, x1, top: TAPE_TOP, lh: TAPE_LANE_H, startMs, endMs,
    x: (ms) => gx + (ms - startMs) * px,
    t: (x) => startMs + (x - gx) / px,
  };
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
): TapeHit | null {
  const lane = Math.floor((py - g.top) / g.lh);
  if (lane < 0 || lane >= lanes.length || px < 0 || px > g.width) return null;
  if (px < g.gx) return { lane, span: null };
  const spans = index.lanes.get(lanes[lane]!.id) ?? [];
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]!;
    const xa = g.x(Math.max(s.startMs, g.startMs));
    const xb = g.x(Math.min(s.endMs ?? Math.min(now, index.capMs), g.endMs));
    if (px >= xa - 3 && px <= Math.max(xb, xa + 3) + 3) return { lane, span: s };
  }
  return { lane, span: null };
}
