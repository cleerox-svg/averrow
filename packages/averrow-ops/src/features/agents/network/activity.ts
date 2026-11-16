// What is happening on each node right now, derived from the last-hour
// timeline. Pure functions (no DOM) so the particle gating is testable.

import type { AgentTimeline, TimelinePull, TimelineRun, TimelineStatus } from '@/hooks/useAgentTimeline';
import {
  FEED_GROUP_NODE, FEED_NRD, GROUP_ENRICHMENT, GROUP_INGEST, HUB_THREATS, INBOX_ABUSE,
  feedGroupOf, type NetworkEdge,
} from './model';
import type { FeedOverview } from '@/hooks/useFeeds';

/** A finished source keeps emitting for this long (the hand-off in flight). */
export const TRANSIT_TAIL_MS = 6_000;
/** One particle crosses an edge in this long. */
export const PARTICLE_PERIOD_MS = 1_800;
export const MAX_PARTICLES = 8;
const DEFAULT_EXPECTED_MS = 60_000;

export interface Span {
  id: string | number;
  startMs: number;
  endMs: number | null; // null = still open
  status: TimelineStatus;
  records: number;
  error: string | null;
  clipped: boolean;
  /** Real lane member (agent id or feed name). */
  member: string;
}

/** An open run is only known to be open as of generated_at; the response is
 *  cached up to ~60s and refetched every 60s, so never extend one past generated_at + this (90s keeps the cap from flickering between refetches). */
export const OPEN_RUN_CAP_MS = 90_000;
/** A pending pivot event stays "in flight" this long after it was written. */
export const EVENT_WAIT_MS = 10 * 60_000;

export interface TimelineIndex {
  /** Latest instant an open span may be drawn as still running. */
  capMs: number;
  /** Median finished duration per lane (expected run length), precomputed. */
  expected: Map<string, number>;
  /** pivot_detected events (the only EVENT edge). */
  events: Array<{ source: string; target: string | null; createdMs: number; status: string }>;
  /** Spans per lane id: agent id, or a feed group node id, or FEED_NRD. */
  lanes: Map<string, Span[]>;
  windowStart: number;
  windowEnd: number;
}

const ts = (iso: string | null): number | null => {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
};

function runSpan(r: TimelineRun): Span | null {
  const s = ts(r.started_at);
  if (s === null) return null;
  const e = r.open ? null : ts(r.completed_at);
  return {
    id: r.id, startMs: s, endMs: e, status: r.open ? 'running' : r.status,
    records: r.records_processed || 0, error: r.error, clipped: r.clipped_start, member: r.agent_id,
  };
}

function pullSpan(p: TimelinePull): Span | null {
  const s = ts(p.started_at);
  if (s === null) return null;
  const e = p.open ? null : ts(p.completed_at);
  return {
    id: p.id, startMs: s, endMs: e, status: p.open ? 'running' : p.status,
    records: p.records_ingested || 0, error: p.error, clipped: p.clipped_start, member: p.feed_name,
  };
}

/** Lane id a feed's pulls belong to. */
export function feedLaneId(feed: Pick<FeedOverview, 'feed_name' | 'feed_type'>): string {
  const g = feedGroupOf(feed);
  return g === 'nrd' ? FEED_NRD : FEED_GROUP_NODE[g];
}

export function indexTimeline(
  timeline: AgentTimeline | undefined,
  feeds: ReadonlyArray<Pick<FeedOverview, 'feed_name' | 'feed_type'>>,
): TimelineIndex {
  const lanes = new Map<string, Span[]>();
  const push = (lane: string, span: Span | null) => {
    if (!span) return;
    const list = lanes.get(lane);
    if (list) list.push(span); else lanes.set(lane, [span]);
  };
  if (!timeline) return { lanes, windowStart: 0, windowEnd: 0, capMs: 0, expected: new Map(), events: [] };
  const laneOfFeed = new Map(feeds.map((f) => [f.feed_name, feedLaneId(f)]));
  for (const r of timeline.runs) push(r.agent_id, runSpan(r));
  for (const p of timeline.pulls) {
    // A pull for a feed the registry no longer lists reads as an ingest feed.
    push(laneOfFeed.get(p.feed_name) ?? (p.feed_name === 'nrd_hagezi' ? FEED_NRD : GROUP_INGEST), pullSpan(p));
  }
  const expected = new Map<string, number>();
  for (const [lane, list] of lanes) {
    list.sort((a, b) => a.startMs - b.startMs);
    expected.set(lane, expectedMs(list));
  }
  const events = timeline.events
    .map((e) => ({ source: e.source_agent, target: e.target_agent, createdMs: ts(e.created_at) ?? 0, status: e.status }))
    .filter((e) => e.createdMs > 0);
  return {
    lanes, expected, events,
    windowStart: ts(timeline.window_start) ?? 0,
    windowEnd: ts(timeline.window_end) ?? 0,
    capMs: (ts(timeline.generated_at) ?? ts(timeline.window_end) ?? 0) + OPEN_RUN_CAP_MS,
  };
}

export interface NodeActivity {
  running: boolean;
  /** 0..1 estimated progress of the open run (0 when not running). */
  progress: number;
  /** The most recent finished run failed. */
  failed: boolean;
  /** Running now, or finished within TRANSIT_TAIL_MS: data is in flight. */
  emitting: boolean;
  /** Records of the runs that are emitting. */
  records: number;
  /** Start of the latest run, or null. */
  lastStartMs: number | null;
  /** The latest run is open but the snapshot is too old to say it still is. */
  stale: boolean;
}

export const IDLE: NodeActivity = {
  running: false, progress: 0, failed: false, emitting: false, records: 0, lastStartMs: null, stale: false,
};

function expectedMs(spans: Span[]): number {
  const d = spans.filter((s) => s.endMs !== null).map((s) => (s.endMs as number) - s.startMs).sort((a, b) => a - b);
  if (!d.length) return DEFAULT_EXPECTED_MS;
  return Math.max(d[Math.floor(d.length / 2)]!, 1_000);
}

const frameCache = new WeakMap<TimelineIndex, { now: number; m: Map<string, NodeActivity> }>();

/** Lane activity, computed once per (index, now): a frame asks for the same
 *  lane from many nodes and edges. */
export function laneActivity(index: TimelineIndex, lane: string, now: number): NodeActivity {
  let entry = frameCache.get(index);
  if (!entry || entry.now !== now) {
    entry = { now, m: new Map() };
    frameCache.set(index, entry);
  }
  let hit = entry.m.get(lane);
  if (!hit) {
    hit = computeLaneActivity(index, lane, now);
    entry.m.set(lane, hit);
  }
  return hit;
}

function computeLaneActivity(index: TimelineIndex, lane: string, now: number): NodeActivity {
  const spans = index.lanes.get(lane);
  if (!spans || !spans.length) return IDLE;
  let running = false;
  let progress = 0;
  let emitting = false;
  let records = 0;
  let lastStartMs: number | null = null;
  let lastFinished: Span | null = null;
  let latest: Span | null = null;
  const exp = index.expected.get(lane) ?? DEFAULT_EXPECTED_MS;
  for (const s of spans) {
    if (s.startMs > now) continue;
    if (lastStartMs === null || s.startMs > lastStartMs) lastStartMs = s.startMs;
    if (!latest || s.startMs >= latest.startMs) latest = s;
    if (s.endMs === null) {
      // Past the cap the run may have finished after the snapshot: unknown, not running.
      if (now > index.capMs) continue;
      running = true;
      emitting = true;
      records += s.records;
      progress = Math.max(progress, Math.min((now - s.startMs) / exp, 0.95));
    } else if (s.endMs > now) {
      // Ends after `now`: it spans it (only possible when replaying the past).
      running = true;
      emitting = true;
      records += s.records;
      progress = Math.max(progress, Math.min((now - s.startMs) / Math.max(s.endMs - s.startMs, 1), 0.95));
    } else {
      if (!lastFinished || s.endMs > (lastFinished.endMs as number)) lastFinished = s;
      if (now - s.endMs <= TRANSIT_TAIL_MS && now >= s.startMs) {
        emitting = true;
        records += s.records;
      }
    }
  }
  return {
    running, progress, emitting, records, lastStartMs,
    failed: !!lastFinished && lastFinished.status === 'failed',
    stale: !!latest && latest.endMs === null && now > index.capMs,
  };
}

/** Lanes whose activity makes an edge's source emit. The hub emits when
 *  anything that writes threats is active. */
export function emitterLanes(from: string): string[] {
  if (from === HUB_THREATS) return [GROUP_INGEST, GROUP_ENRICHMENT, 'navigator', 'enricher'];
  if (from === INBOX_ABUSE) return ['abuse_mailbox_classifier'];
  return [from];
}

export function edgeActivity(index: TimelineIndex, edge: NetworkEdge, now: number): NodeActivity {
  // The EVENT edge fires on an actual pivot_detected event, not on every run
  // of its source: in transit just after it is written, or while it waits
  // for the consumer (pending) inside the snapshot's trust window.
  if (edge.mechanism === 'EVENT') {
    let n = 0;
    let last: number | null = null;
    for (const ev of index.events) {
      if (ev.source !== edge.from || (ev.target !== null && ev.target !== edge.to) || ev.createdMs > now) continue;
      const inTail = now - ev.createdMs <= TRANSIT_TAIL_MS;
      const waiting = ev.status === 'pending' && now <= index.capMs && now - ev.createdMs <= EVENT_WAIT_MS;
      if (inTail || waiting) { n++; if (last === null || ev.createdMs > last) last = ev.createdMs; }
    }
    return n === 0 ? IDLE : { running: false, progress: 0, failed: false, emitting: true, records: n, lastStartMs: last, stale: false };
  }
  // threats -> sentinel is the same-tick ingest hand-off; the other hub
  // edges read the table after anything that writes it.
  const lanes = edge.from === HUB_THREATS && edge.to === 'sentinel' ? [GROUP_INGEST] : emitterLanes(edge.from);
  let out = IDLE;
  for (const l of lanes) {
    const a = laneActivity(index, l, now);
    if (a.emitting && (!out.emitting || a.records > out.records)) out = a;
  }
  return out;
}

/** Per-member (feed) state inside a grouped lane, for the feed dots. */
export function activeMembers(
  index: TimelineIndex,
  lane: string,
  now: number,
): Map<string, { running: boolean; failed: boolean; emitting: boolean; records: number }> {
  const out = new Map<string, { running: boolean; failed: boolean; emitting: boolean; records: number; lastEnd: number }>();
  for (const s of index.lanes.get(lane) ?? []) {
    if (s.startMs > now) continue;
    const cur = out.get(s.member) ?? { running: false, failed: false, emitting: false, records: 0, lastEnd: -1 };
    if (s.endMs === null) {
      if (now > index.capMs) continue;
      cur.running = true; cur.emitting = true; cur.records += s.records;
    } else if (s.endMs > now) {
      cur.running = true; cur.emitting = true; cur.records += s.records;
    } else {
      if (s.endMs >= cur.lastEnd) { cur.lastEnd = s.endMs; cur.failed = s.status === 'failed'; }
      if (now - s.endMs <= TRANSIT_TAIL_MS) { cur.emitting = true; cur.records += s.records; }
    }
    out.set(s.member, cur);
  }
  return out;
}

export function particleCount(records: number): number {
  return Math.max(1, Math.min(MAX_PARTICLES, 1 + Math.floor(Math.log2(1 + Math.max(records, 0)) / 2)));
}

/**
 * Progress values (0..1 along the edge) of the particles to draw now.
 * Particles ride only spine edges, only while the upstream run or pull is
 * live in the transit window, and never under reduced motion.
 */
export function edgeParticles(
  edge: Pick<NetworkEdge, 'tier'>,
  activity: NodeActivity,
  now: number,
  reducedMotion: boolean,
  /** Clock that drives particle travel. Defaults to `now`; replay passes the
   *  wall clock so dots fly at normal speed whatever the replay speed. */
  phaseMs: number = now,
): number[] {
  if (reducedMotion || edge.tier !== 'spine' || !activity.emitting) return [];
  const n = particleCount(activity.records);
  const base = (phaseMs % PARTICLE_PERIOD_MS) / PARTICLE_PERIOD_MS;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((base + i / n) % 1);
  return out;
}
