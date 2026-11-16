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
  /** Open and older than OPEN_RUN_SUSPECT_MS at the snapshot (set by indexTimeline). */
  suspect?: boolean;
}

/**
 * An open run is only known to be open as of generated_at. The response can be
 * as old as its server cache TTL plus one refetch interval, so never extend an
 * open run past generated_at + this. 1h: 60 s TTL + 60 s refetch, rounded to 2
 * minutes. 24h: 300 s + 300 s, plus 30 s of slack. Shorter caps flicker
 * runs to "status unknown" mid-cycle.
 */
export const OPEN_RUN_CAP_MS = 120_000;
export const OPEN_RUN_CAP_24H_MS = 630_000;
/** An open run this much older than generated_at is suspect: the worker's
 *  reaper ceiling is 90 minutes, so it is almost certainly an orphan. It is
 *  drawn as "status unknown" in live and replay, never as running. */
export const OPEN_RUN_SUSPECT_MS = 90 * 60_000;
/** A pending pivot event stays "in flight" this long after it was written. */
export const EVENT_WAIT_MS = 10 * 60_000;

export interface TimelineIndex {
  /** Latest instant an open span may be drawn as still running. */
  capMs: number;
  /** Median finished duration per lane (expected run length), precomputed. */
  expected: Map<string, number>;
  /** Longest finished span per lane: bounds how far back a scan must look. */
  maxDur: Map<string, number>;
  /** Open spans per lane (few), so per-frame scans skip them in the long list. */
  opens: Map<string, Span[]>;
  /** Feed-group lanes split by feed, each sorted, with its longest finished span. */
  members: Map<string, Map<string, { spans: Span[]; maxDur: number }>>;
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
  if (!timeline) return { lanes, windowStart: 0, windowEnd: 0, capMs: 0, expected: new Map(), maxDur: new Map(), opens: new Map(), members: new Map(), events: [] };
  const laneOfFeed = new Map(feeds.map((f) => [f.feed_name, feedLaneId(f)]));
  for (const r of timeline.runs) push(r.agent_id, runSpan(r));
  for (const p of timeline.pulls) {
    // A pull for a feed the registry no longer lists reads as an ingest feed.
    push(laneOfFeed.get(p.feed_name) ?? (p.feed_name === 'nrd_hagezi' ? FEED_NRD : GROUP_INGEST), pullSpan(p));
  }
  const expected = new Map<string, number>();
  const maxDur = new Map<string, number>();
  const opens = new Map<string, Span[]>();
  const members = new Map<string, Map<string, { spans: Span[]; maxDur: number }>>();
  const genMs = ts(timeline.generated_at) ?? ts(timeline.window_end) ?? 0;
  for (const [lane, list] of lanes) {
    for (const s of list) if (s.endMs === null && genMs > 0 && s.startMs < genMs - OPEN_RUN_SUSPECT_MS) s.suspect = true;
    list.sort((a, b) => a.startMs - b.startMs);
    expected.set(lane, expectedMs(list));
    let md = 0;
    const op: Span[] = [];
    for (const s of list) {
      if (s.endMs === null) op.push(s); else md = Math.max(md, s.endMs - s.startMs);
    }
    maxDur.set(lane, md);
    if (lane.startsWith('feeds:') || lane === FEED_NRD) {
      const byMember = new Map<string, { spans: Span[]; maxDur: number }>();
      for (const s of list) {
        let m = byMember.get(s.member);
        if (!m) { m = { spans: [], maxDur: 0 }; byMember.set(s.member, m); }
        m.spans.push(s);
        if (s.endMs !== null) m.maxDur = Math.max(m.maxDur, s.endMs - s.startMs);
      }
      members.set(lane, byMember);
    }
    if (op.length) opens.set(lane, op);
  }
  const events = timeline.events
    .map((e) => ({ source: e.source_agent, target: e.target_agent, createdMs: ts(e.created_at) ?? 0, status: e.status }))
    .filter((e) => e.createdMs > 0);
  return {
    lanes, expected, maxDur, opens, members, events,
    windowStart: ts(timeline.window_start) ?? 0,
    windowEnd: ts(timeline.window_end) ?? 0,
    capMs: (ts(timeline.generated_at) ?? ts(timeline.window_end) ?? 0)
      + (timeline.window === '24h' ? OPEN_RUN_CAP_24H_MS : OPEN_RUN_CAP_MS),
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

/** Index of the first span that starts after `now` (spans are sorted by start). */
function upperBound(spans: readonly Span[], now: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.startMs <= now) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function computeLaneActivity(index: TimelineIndex, lane: string, now: number): NodeActivity {
  const spans = index.lanes.get(lane);
  if (!spans || !spans.length) return IDLE;
  let running = false;
  let progress = 0;
  let emitting = false;
  let records = 0;
  let lastFinished: Span | null = null;
  const exp = index.expected.get(lane) ?? DEFAULT_EXPECTED_MS;
  const maxDur = index.maxDur.get(lane) ?? 0;
  const hi = upperBound(spans, now); // spans[0..hi) have started
  const latest = hi > 0 ? spans[hi - 1]! : null;
  const lastStartMs = latest ? latest.startMs : null;

  // Open spans live in their own short list: they can start long before `now`.
  for (const s of index.opens.get(lane) ?? []) {
    if (s.startMs > now) continue;
    // Past the cap the run may have finished after the snapshot: unknown, not running.
    if (s.suspect || now > index.capMs) continue;
    running = true;
    emitting = true;
    records += s.records;
    progress = Math.max(progress, Math.min((now - s.startMs) / exp, 0.95));
  }

  // Finished spans: scan back from the playhead. Nothing older than
  // `maxDur + tail` can span or trail `now`, and once the newest-ending
  // finished span is known nothing earlier can end later: stop there. This
  // keeps a 24h lane (thousands of pulls) cheap per frame.
  for (let i = hi - 1; i >= 0; i--) {
    const s = spans[i]!;
    if (s.endMs === null) continue;
    if (s.startMs + maxDur < now - TRANSIT_TAIL_MS && lastFinished && s.startMs + maxDur < (lastFinished.endMs as number)) break;
    if (s.endMs > now) {
      // Ends after `now`: it spans it (only possible when replaying the past).
      running = true;
      emitting = true;
      records += s.records;
      progress = Math.max(progress, Math.min((now - s.startMs) / Math.max(s.endMs - s.startMs, 1), 0.95));
    } else {
      if (!lastFinished || s.endMs >= (lastFinished.endMs as number)) lastFinished = s;
      if (now - s.endMs <= TRANSIT_TAIL_MS && now >= s.startMs) {
        emitting = true;
        records += s.records;
      }
    }
  }
  return {
    running, progress, emitting, records, lastStartMs,
    failed: !!lastFinished && lastFinished.status === 'failed',
    stale: !!latest && latest.endMs === null && (!!latest.suspect || now > index.capMs),
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
  const out = new Map<string, { running: boolean; failed: boolean; emitting: boolean; records: number }>();
  const byMember = index.members.get(lane);
  if (!byMember) return out;
  // Same scan-back as computeLaneActivity, per feed: binary-search the
  // playhead, then walk back only as far as a finished span could still
  // matter. Open pulls are rare and found in the lane's open list.
  for (const s of index.opens.get(lane) ?? []) {
    if (s.startMs > now || s.suspect || now > index.capMs) continue;
    const cur = out.get(s.member) ?? { running: false, failed: false, emitting: false, records: 0 };
    cur.running = true; cur.emitting = true; cur.records += s.records;
    out.set(s.member, cur);
  }
  for (const [member, { spans, maxDur }] of byMember) {
    const hi = upperBound(spans, now);
    let lastFin: Span | null = null;
    let cur = out.get(member);
    for (let i = hi - 1; i >= 0; i--) {
      const s = spans[i]!;
      if (s.endMs === null) continue;
      if (s.startMs + maxDur < now - TRANSIT_TAIL_MS && lastFin && s.startMs + maxDur < (lastFin.endMs as number)) break;
      if (s.endMs > now) {
        cur ??= { running: false, failed: false, emitting: false, records: 0 };
        cur.running = true; cur.emitting = true; cur.records += s.records;
      } else {
        if (!lastFin || s.endMs >= (lastFin.endMs as number)) lastFin = s;
        if (now - s.endMs <= TRANSIT_TAIL_MS) {
          cur ??= { running: false, failed: false, emitting: false, records: 0 };
          cur.emitting = true; cur.records += s.records;
        }
      }
    }
    if (lastFin || cur) {
      cur ??= { running: false, failed: false, emitting: false, records: 0 };
      cur.failed = !!lastFin && lastFin.status === 'failed';
      out.set(member, cur);
    }
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
