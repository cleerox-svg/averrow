/**
 * GET /api/agents/timeline?window=1h|24h — individual agent runs, feed pulls
 * and pivot_detected events that overlap the last hour (default) or the last
 * 24 hours, for the ops Agents Network view (flow canvas + run tape).
 * requireStaff (routes/agents.ts). Per-window knobs: TIMELINE_WINDOWS.
 *
 * Sources (every read is index-backed and bounded; reads go through a read
 * replica session, nothing here writes D1):
 *
 *   1. agent_runs started since window_start − 30 min      idx_agent_runs_started (0319)
 *   2. agent_runs still open, started in the last
 *      6 h (1h) / 30 h (24h)                                 idx_agent_runs_open (0320, pinned)
 *   3. feed_pull_history started since window_start − 15 min idx_feed_pulls_started (0319)
 *   4. NEXUS workflow lifecycle rows from agent_activity_log
 *      (agent_id='nexus', since window_start − 4 h)          idx_activity_agent (0047, pinned)
 *   5. agent_events pivot_detected since window_start        idx_agent_events_type_created (0298)
 *
 * A row is kept when `[started_at, completed_at ?? now]` overlaps the window
 * (`overlapsWindow`); the SQL lower bounds are only a superset pre-filter.
 *
 * Timestamp formats: agent_runs / agent_activity_log / agent_events default
 * to SQLite text ('YYYY-MM-DD HH:MM:SS'); feedRunner writes feed_pull_history
 * started_at as ISO ('…T…Z') and completed_at as SQLite text. Every value is
 * normalised to ISO UTC 'Z' by `normalizeTs`. The started_at windows (1, 3)
 * are written as two plain ranges (`sinceRangeBinds`), one per stored format,
 * which SQLite serves as a MULTI-INDEX OR over idx_*_started and which is
 * exact for both formats (a single SQLite-text bound would also pull in every
 * ISO row of the bound's date). Those statements carry no ORDER BY: with one
 * the planner walks the whole started_at index instead (pinned by
 * test/agent-timeline.test.ts); ordering and bounds are applied in JS.
 *
 * Cached via cachedValue: `agents_timeline:v1:1h` (60 s TTL, 30 s live
 * freshness) and `agents_timeline:v1:24h` (300 s TTL, 120 s live freshness),
 * both stale-while-revalidate. No Navigator warm. At 24h `error` is kept
 * only on failed / partial rows to keep the payload small.
 */

import { json } from "../lib/cors";
import { cachedValue } from "../lib/cached-value";
import { getDbContext, getReadSession } from "../lib/db";
import { newTally, addToTally, recordD1Reads, type D1Tally } from "../lib/analytics";
import type { Env } from "../types";
import { historyParts, type ReadPart } from "../lib/telemetry-read";

// ─── Contract ───────────────────────────────────────────────────────

export type TimelineStatus = "success" | "partial" | "failed" | "running";

export interface TimelineRun {
  id: string;
  agent_id: string;
  source: "agent_runs" | "workflow";
  started_at: string;
  completed_at: string | null;
  status: TimelineStatus;
  open: boolean;
  clipped_start: boolean;
  duration_ms: number | null;
  records_processed: number;
  error: string | null;
}

export interface TimelinePull {
  id: string;
  feed_name: string;
  started_at: string;
  completed_at: string | null;
  status: TimelineStatus;
  open: boolean;
  clipped_start: boolean;
  records_ingested: number;
  records_rejected: number;
  duration_ms: number | null;
  error: string | null;
}

export interface TimelineEvent {
  id: string;
  event_type: "pivot_detected";
  source_agent: string;
  target_agent: string | null;
  created_at: string;
  status: string;
}

export type TimelineWindow = "1h" | "24h";

export interface AgentTimelineData {
  window: TimelineWindow;
  generated_at: string;
  window_start: string;
  window_end: string;
  runs: TimelineRun[];
  pulls: TimelinePull[];
  events: TimelineEvent[];
  truncated: { runs: boolean; pulls: boolean; events: boolean };
}

export interface AgentTimelineBody {
  success: true;
  data: AgentTimelineData;
}

// ─── Knobs ──────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Per-window knobs. Every lookback is relative to window_start except the
 *  open-runs read (relative to now). The SQL limits are safety nets only —
 *  hitting one sets the matching `truncated` flag. */
export interface TimelineWindowConfig {
  windowMs: number;
  /** Runs that started this long before window_start can still overlap it. */
  runLookbackMs: number;
  pullLookbackMs: number;
  /** Open (never finalized) agent_runs read back this far from NOW;
   *  older ones are the reaper's job. */
  openRunLookbackMs: number;
  /** NEXUS workflow events are folded from window_start − this. */
  workflowLookbackMs: number;
  maxRunsPerAgent: number;
  maxRunsTotal: number;
  maxPulls: number;
  maxEvents: number;
  runSqlLimit: number;
  pullSqlLimit: number;
  activitySqlLimit: number;
  cacheKey: string;
  ttlSeconds: number;
  freshSeconds: number;
  /** Keep `error` only on failed / partial rows (payload size at 24h). */
  errorsOnlyOnFailure: boolean;
}

export const TIMELINE_WINDOWS: Record<TimelineWindow, TimelineWindowConfig> = {
  "1h": {
    windowMs: HOUR,
    runLookbackMs: 30 * MIN,
    pullLookbackMs: 15 * MIN,
    openRunLookbackMs: 6 * HOUR,
    workflowLookbackMs: 4 * HOUR,
    maxRunsPerAgent: 60,
    maxRunsTotal: 400,
    maxPulls: 300,
    maxEvents: 50,
    runSqlLimit: 3000,
    pullSqlLimit: 2000,
    activitySqlLimit: 500,
    cacheKey: "agents_timeline:v1:1h",
    ttlSeconds: 60,
    freshSeconds: 30,
    errorsOnlyOnFailure: false,
  },
  // Navigator alone is ~288 runs/day and page_capture ~144, so the per-agent
  // cap is 400; SQL limits are ~2× the response bounds.
  "24h": {
    windowMs: 24 * HOUR,
    runLookbackMs: 30 * MIN,
    pullLookbackMs: 15 * MIN,
    openRunLookbackMs: 24 * HOUR + 6 * HOUR,
    workflowLookbackMs: 4 * HOUR,
    maxRunsPerAgent: 400,
    maxRunsTotal: 6000,
    maxPulls: 4000,
    maxEvents: 300,
    runSqlLimit: 12_000,
    pullSqlLimit: 8000,
    activitySqlLimit: 2000,
    cacheKey: "agents_timeline:v1:24h",
    ttlSeconds: 300,
    freshSeconds: 120,
    errorsOnlyOnFailure: true,
  },
};

export function parseTimelineWindow(raw: string | null): TimelineWindow | null {
  if (raw === null) return "1h";
  return raw === "1h" || raw === "24h" ? raw : null;
}

// 1h aliases (kept for existing callers / tests).
export const AGENT_TIMELINE_CACHE_KEY = TIMELINE_WINDOWS["1h"].cacheKey;
export const AGENT_TIMELINE_TTL_S = TIMELINE_WINDOWS["1h"].ttlSeconds;
export const AGENT_TIMELINE_FRESH_S = TIMELINE_WINDOWS["1h"].freshSeconds;
export const MAX_RUNS_PER_AGENT = TIMELINE_WINDOWS["1h"].maxRunsPerAgent;
export const MAX_RUNS_TOTAL = TIMELINE_WINDOWS["1h"].maxRunsTotal;

/** An unclosed workflow run older than this is reported failed. */
export const WORKFLOW_STALE_MS = 3 * HOUR;
export const MAX_ERROR_CHARS = 200;

const WORKFLOW_AGENT_ID = "nexus";

// ─── Pure helpers ───────────────────────────────────────────────────

/**
 * Normalise a stored D1 timestamp to ISO UTC ('…Z'). Accepts SQLite text
 * ('YYYY-MM-DD HH:MM[:SS[.sss]]'), ISO with or without a zone, and returns
 * null for null / empty / unparseable input. Zone-less values are UTC (that
 * is what SQLite's datetime() and the worker's writers mean).
 */
export function normalizeTs(raw: string | null | undefined): string | null {
  const ms = tsMs(raw);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Epoch ms of a stored timestamp, or null. Same parsing as normalizeTs. */
export function tsMs(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** SQLite datetime() text for an epoch ms ('YYYY-MM-DD HH:MM:SS'). */
export function toSqliteTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * `col >= <since>` for a TEXT column holding either stored format, as two
 * plain ranges SQLite serves as a MULTI-INDEX OR over an index on `col`:
 *   - SQLite-text rows on the bound's date: [sqliteBound, 'YYYY-MM-DDT')
 *   - every ISO row from the bound on, and every row of a later date (both
 *     formats compare on the date first): >= isoBound
 * Bind with `sinceRangeBinds`. `col` is a fixed identifier, never input.
 */
export function sinceRangeBinds(sinceMs: number): [string, string, string] {
  // Whole-second ISO bound with '.000Z': at an equal second, both '…:SSZ'
  // and '…:SS.sssZ' rows sort >= it ('Z' > '.'), matching datetime().
  const sec = Math.floor(sinceMs / 1000) * 1000;
  const iso = new Date(sec).toISOString();
  return [toSqliteTs(sec), `${iso.slice(0, 10)}T`, iso];
}

/** Map a stored run/pull status + completed_at to the timeline status. */
export function timelineStatus(
  status: string | null | undefined,
  completedAt: string | null | undefined,
): { status: TimelineStatus; open: boolean } {
  const done = tsMs(completedAt) !== null;
  if (!done && (status === "partial" || status === "running")) return { status: "running", open: true };
  if (status === "success" || status === "failed" || status === "partial") return { status, open: false };
  // 'running' with completed_at set, or an unknown value: finished, outcome unclear.
  return { status: "partial", open: false };
}

/**
 * True when `[start, end ?? (open ? now : start)]` overlaps
 * `[windowStart, windowEnd]`. A closed row with no completed_at is a point.
 */
export function overlapsWindow(
  startMs: number,
  endMs: number | null,
  open: boolean,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  const end = endMs ?? (open ? windowEndMs : startMs);
  return startMs <= windowEndMs && end >= windowStartMs;
}

export function clipError(msg: string | null | undefined): string | null {
  if (typeof msg !== "string" || !msg) return null;
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS - 1)}…` : msg;
}

/** 24h payload trim: `error` survives only on failed / partial rows. */
export function keepErrorFor(status: TimelineStatus, error: string | null): string | null {
  return status === "failed" || status === "partial" ? error : null;
}

/** Legacy Navigator rows were written as agent_id='fast_tick'. */
export function normalizeAgentId(agentId: string): string {
  return agentId === "fast_tick" ? "navigator" : agentId;
}

function durationOf(startMs: number, endMs: number | null, stored: number | null | undefined): number | null {
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) return stored;
  return endMs === null ? null : Math.max(0, endMs - startMs);
}

const byStartDesc = <T extends { started_at: string }>(a: T, b: T): number =>
  a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0;

/**
 * Keep the newest `perAgent` runs per agent, then the newest `total`
 * overall. Returned oldest-first (timeline order).
 */
export function boundRuns(
  runs: TimelineRun[],
  perAgent = MAX_RUNS_PER_AGENT,
  total = MAX_RUNS_TOTAL,
): { runs: TimelineRun[]; truncated: boolean } {
  const sorted = [...runs].sort(byStartDesc);
  const perCount = new Map<string, number>();
  const kept: TimelineRun[] = [];
  let truncated = false;
  for (const r of sorted) {
    const n = perCount.get(r.agent_id) ?? 0;
    if (n >= perAgent) { truncated = true; continue; }
    if (kept.length >= total) { truncated = true; continue; }
    perCount.set(r.agent_id, n + 1);
    kept.push(r);
  }
  return { runs: kept.reverse(), truncated };
}

/** Keep the newest `max` items (by `key`), returned oldest-first. */
export function boundNewest<T>(items: T[], max: number, key: (t: T) => string): { items: T[]; truncated: boolean } {
  const sorted = [...items].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  return { items: sorted.slice(0, max).reverse(), truncated: sorted.length > max };
}

// ─── NEXUS workflow fold ────────────────────────────────────────────

export interface ActivityRow {
  id: string;
  event_type: string;
  message: string | null;
  metadata_json: string | null;
  created_at: string;
}

/** Keys of batch_complete metadata that together make NEXUS's
 *  `totalClustersWritten` (workflows/nexusRun.ts log-complete step). */
const CLUSTER_COUNT_KEYS = [
  "clustersWritten",
  "cert_serial_clusters",
  "cert_san_clusters",
  "per_ip_clusters",
  "subnet24_clusters",
  "registrar_clusters",
] as const;

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clustersWritten(meta: Record<string, unknown>): number {
  let n = 0;
  for (const k of CLUSTER_COUNT_KEYS) {
    const v = meta[k];
    if (typeof v === "number" && Number.isFinite(v)) n += v;
  }
  return n;
}

interface OpenWf {
  run: TimelineRun;
  startedMs: number;
  hasStarted: boolean;
  /** False for a run opened by a `started` row with no dispatch to pair with. */
  hasDispatch: boolean;
}

/**
 * How long after a dispatch-less `started` row a `workflow_dispatched` row
 * may still be adopted as that run's dispatch. dispatchWorkflow logs the
 * dispatch only after `workflow.create()` returns and a KV put lands, while
 * the workflow's own count-before + log-start steps can already have
 * written `started` — so `started` can precede its dispatch by seconds
 * (more under D1 overload, when the dispatch INSERT itself is slow). NEXUS
 * is dispatched every 4 h (manual triggers are rare), so two dispatches
 * within 60 s of one start is not a realistic ambiguity.
 */
export const DISPATCH_ADOPT_TOLERANCE_MS = 60_000;

/** Same-second tie order: a run's lifecycle rows sort in the order they happen. */
const LIFECYCLE_RANK: Record<string, number> = {
  workflow_dispatched: 0,
  started: 1,
  batch_complete: 2,
  workflow_failed: 2,
  workflow_dispatch_failed: 2,
};
const rankOf = (eventType: string): number => LIFECYCLE_RANK[eventType] ?? 3;

/**
 * Fold NEXUS lifecycle rows (any order; sorted here) into runs.
 *
 * Only `workflow_dispatched` carries an instance id, so the rest pair by
 * time order (rows at the same second ordered dispatched < started <
 * completion, since created_at has 1 s resolution):
 *   workflow_dispatched      opens a run (id `wf:<instance_id>`, else `wf:<row id>`)
 *   started                  sets started_at of the NEWEST open run not yet started
 *                            (a workflow starts seconds after its dispatch); opens
 *                            one if none — its dispatch is outside the lookback,
 *                            or its dispatch row lands after it, in which case
 *                            that dispatch (≤ DISPATCH_ADOPT_TOLERANCE_MS later)
 *                            is adopted into the run instead of opening another
 *   batch_complete           closes the oldest STARTED open run (else the oldest
 *                            open run) → success, records = clusters written
 *                            (best effort, `CLUSTER_COUNT_KEYS`)
 *   workflow_failed          closes the same way → failed, with its error
 *   workflow_dispatch_failed zero-length failed run
 *   workflow_cooldown_skip   ignored (no run happened); any other type ignored
 * Before each started / completion row, open runs already >= 3 h old at that
 * row's time are closed as failed "no completion event", so a lost run can
 * never absorb a later run's events. A completion with nothing open becomes a
 * zero-length run at its own time. Still open at the end: < 3 h old →
 * running/open, otherwise failed "no completion event" (completed_at null).
 */
export function foldWorkflowEvents(rows: ActivityRow[], nowMs: number, agentId = WORKFLOW_AGENT_ID): TimelineRun[] {
  const sorted = rows
    .map((r) => ({ r, ms: tsMs(r.created_at) }))
    .filter((x): x is { r: ActivityRow; ms: number } => x.ms !== null)
    // created_at has 1-second resolution, so a dispatch and its `started`
    // routinely tie: break ties by lifecycle rank, then id (determinism).
    .sort((a, b) =>
      a.ms - b.ms ||
      rankOf(a.r.event_type) - rankOf(b.r.event_type) ||
      (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));

  const out: TimelineRun[] = [];
  const open: OpenWf[] = [];

  const newRun = (id: string, ms: number): TimelineRun => ({
    id,
    agent_id: agentId,
    source: "workflow",
    started_at: new Date(ms).toISOString(),
    completed_at: null,
    status: "running",
    open: true,
    clipped_start: false,
    duration_ms: null,
    records_processed: 0,
    error: null,
  });
  const close = (wf: OpenWf, ms: number, status: "success" | "failed", records: number, err: string | null) => {
    const run = wf.run;
    run.completed_at = new Date(ms).toISOString();
    run.status = status;
    run.open = false;
    run.duration_ms = Math.max(0, ms - wf.startedMs);
    run.records_processed = records;
    run.error = err;
    out.push(run);
  };

  const expireBefore = (atMs: number) => {
    for (let i = open.length - 1; i >= 0; i--) {
      const wf = open[i]!;
      if (atMs - wf.startedMs < WORKFLOW_STALE_MS) continue;
      wf.run.status = "failed";
      wf.run.open = false;
      wf.run.error = "no completion event";
      out.push(wf.run);
      open.splice(i, 1);
    }
  };

  for (const { r, ms } of sorted) {
    const meta = parseMeta(r.metadata_json);
    switch (r.event_type) {
      case "workflow_dispatched": {
        const inst = typeof meta["instance_id"] === "string" && meta["instance_id"] ? meta["instance_id"] : r.id;
        // A `started` that landed before its own dispatch row opened a
        // dispatch-less run: adopt this dispatch into it (newest first)
        // instead of opening a second run that would never start.
        let orphan: OpenWf | undefined;
        for (let i = open.length - 1; i >= 0 && !orphan; i--) {
          const o = open[i]!;
          if (!o.hasDispatch && o.hasStarted && ms - o.startedMs >= 0 && ms - o.startedMs <= DISPATCH_ADOPT_TOLERANCE_MS) orphan = o;
        }
        if (orphan) {
          orphan.hasDispatch = true;
          orphan.run.id = `wf:${inst}`;
        } else {
          open.push({ run: newRun(`wf:${inst}`, ms), startedMs: ms, hasStarted: false, hasDispatch: true });
        }
        break;
      }
      case "started": {
        expireBefore(ms);
        let wf: OpenWf | undefined;
        for (let i = open.length - 1; i >= 0 && !wf; i--) if (!open[i]!.hasStarted) wf = open[i];
        if (wf) {
          wf.hasStarted = true;
          wf.startedMs = ms;
          wf.run.started_at = new Date(ms).toISOString();
        } else {
          open.push({ run: newRun(`wf:${r.id}`, ms), startedMs: ms, hasStarted: true, hasDispatch: false });
        }
        break;
      }
      case "batch_complete":
      case "workflow_failed": {
        expireBefore(ms);
        const idx = open.findIndex((o) => o.hasStarted);
        const picked = open.splice(idx >= 0 ? idx : 0, 1)[0];
        const wf = picked ?? { run: newRun(`wf:${r.id}`, ms), startedMs: ms, hasStarted: true, hasDispatch: false };
        if (r.event_type === "batch_complete") {
          close(wf, ms, "success", clustersWritten(meta), null);
        } else {
          const e = typeof meta["error"] === "string" ? meta["error"] : r.message;
          close(wf, ms, "failed", 0, clipError(e) ?? "workflow failed");
        }
        break;
      }
      case "workflow_dispatch_failed": {
        const wf: OpenWf = { run: newRun(`wf:${r.id}`, ms), startedMs: ms, hasStarted: true, hasDispatch: true };
        const e = typeof meta["error"] === "string" ? meta["error"] : r.message;
        close(wf, ms, "failed", 0, clipError(e) ?? "workflow dispatch failed");
        break;
      }
      default:
        // workflow_cooldown_skip and unrelated activity: no run.
        break;
    }
  }

  for (const wf of open) {
    if (nowMs - wf.startedMs >= WORKFLOW_STALE_MS) {
      wf.run.status = "failed";
      wf.run.open = false;
      wf.run.error = "no completion event";
    }
    out.push(wf.run);
  }
  return out;
}

// ─── Row shaping ────────────────────────────────────────────────────

interface RunRow {
  id: string;
  agent_id: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: string;
  records_processed: number | null;
  error_message: string | null;
}

interface PullRow {
  id: string;
  feed_name: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: string;
  records_ingested: number | null;
  records_rejected: number | null;
  error_message: string | null;
}

interface EventRow {
  id: string;
  source_agent: string;
  target_agent: string | null;
  created_at: string;
  status: string | null;
}

/** agent_runs rows (both reads, possibly overlapping) → windowed runs. */
export function shapeRuns(rows: RunRow[], windowStartMs: number, windowEndMs: number): TimelineRun[] {
  const seen = new Set<string>();
  const out: TimelineRun[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const startMs = tsMs(r.started_at);
    if (startMs === null) continue;
    const endMs = tsMs(r.completed_at);
    const { status, open } = timelineStatus(r.status, r.completed_at);
    if (!overlapsWindow(startMs, endMs, open, windowStartMs, windowEndMs)) continue;
    out.push({
      id: r.id,
      agent_id: normalizeAgentId(r.agent_id),
      source: "agent_runs",
      started_at: new Date(startMs).toISOString(),
      completed_at: endMs === null ? null : new Date(endMs).toISOString(),
      status,
      open,
      clipped_start: startMs < windowStartMs,
      duration_ms: open ? null : durationOf(startMs, endMs, r.duration_ms),
      records_processed: r.records_processed ?? 0,
      error: clipError(r.error_message),
    });
  }
  return out;
}

/** Folded workflow runs → windowed runs (sets clipped_start). */
export function windowRuns(runs: TimelineRun[], windowStartMs: number, windowEndMs: number): TimelineRun[] {
  const out: TimelineRun[] = [];
  for (const r of runs) {
    const startMs = tsMs(r.started_at);
    if (startMs === null) continue;
    if (!overlapsWindow(startMs, tsMs(r.completed_at), r.open, windowStartMs, windowEndMs)) continue;
    out.push({ ...r, clipped_start: startMs < windowStartMs });
  }
  return out;
}

export function shapePulls(rows: PullRow[], windowStartMs: number, windowEndMs: number): TimelinePull[] {
  const out: TimelinePull[] = [];
  for (const r of rows) {
    const startMs = tsMs(r.started_at);
    if (startMs === null) continue;
    const endMs = tsMs(r.completed_at);
    const { status, open } = timelineStatus(r.status, r.completed_at);
    if (!overlapsWindow(startMs, endMs, open, windowStartMs, windowEndMs)) continue;
    out.push({
      id: r.id,
      feed_name: r.feed_name,
      started_at: new Date(startMs).toISOString(),
      completed_at: endMs === null ? null : new Date(endMs).toISOString(),
      status,
      open,
      clipped_start: startMs < windowStartMs,
      records_ingested: r.records_ingested ?? 0,
      records_rejected: r.records_rejected ?? 0,
      duration_ms: open ? null : durationOf(startMs, endMs, r.duration_ms),
      error: clipError(r.error_message),
    });
  }
  return out;
}

// ─── D1 reads ───────────────────────────────────────────────────────

type ReadDb = Pick<D1Database, "prepare">;

async function readAll<T>(stmt: D1PreparedStatement, tally: D1Tally): Promise<T[]> {
  const r = await stmt.all<T>();
  addToTally(tally, r.meta);
  return r.results ?? [];
}

/**
 * One read across the parts of the telemetry ∪ core union (Track B1c). One
 * part = exactly the old single read. Several: rows concatenated telemetry
 * first and deduped by `id` (a backfilled copy is the same row); `newestFirst`
 * re-applies an ORDER BY created_at DESC LIMIT n over the merged rows.
 */
async function readUnion<T extends { id: string }>(
  parts: ReadPart[],
  sql: string,
  binds: unknown[],
  tally: D1Tally,
  newestFirst?: { col: Extract<keyof T, string>; limit: number },
): Promise<T[]> {
  const lists = await Promise.all(parts.map((part) => readAll<T>(part.db.prepare(sql).bind(...binds), tally)));
  if (lists.length === 1) return lists[0] ?? [];
  const seen = new Set<string>();
  let out = lists.flat().filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  if (newestFirst) {
    const c = newestFirst.col;
    out = out
      .sort((a, b) => String(b[c] ?? "").localeCompare(String(a[c] ?? "")))
      .slice(0, newestFirst.limit);
  }
  return out;
}

/**
 * Build the timeline. Exported for tests; `nowMs` is injectable so window
 * edges are deterministic.
 */
export async function computeAgentTimeline(
  db: ReadDb,
  nowMs: number,
  tally: D1Tally = newTally(),
  window: TimelineWindow = "1h",
  env?: Env,
): Promise<AgentTimelineData> {
  const cfg = TIMELINE_WINDOWS[window];
  const windowEndMs = nowMs;
  const windowStartMs = nowMs - cfg.windowMs;
  // agent_runs / agent_activity_log / agent_events span telemetry ∪ core
  // during the cut-over; feed_pull_history stays on `db` (its own family).
  const [runParts, activityParts, eventParts] = await Promise.all([
    historyParts(env, "agent_runs", { core: db }),
    historyParts(env, "agent_activity_log", { core: db }),
    historyParts(env, "agent_events", { core: db }),
  ]);

  const [windowRunRows, openRunRows, pullRows, activityRows, eventRows] = await Promise.all([
    // 1. Runs started near/in the window. MULTI-INDEX OR on
    //    idx_agent_runs_started; no ORDER BY (see file header).
    readUnion<RunRow>(runParts,
      `SELECT id, agent_id, started_at, completed_at, duration_ms, status, records_processed, error_message
         FROM agent_runs
        WHERE (started_at >= ? AND started_at < ?) OR started_at >= ?
        LIMIT ?`,
      [...sinceRangeBinds(windowStartMs - cfg.runLookbackMs), cfg.runSqlLimit], tally),

    // 2. Still-open runs that started before (1)'s bound. The WHERE repeats
    //    idx_agent_runs_open's partial-index predicate (migration 0320)
    //    verbatim so SQLite can use it; INDEXED BY pins it (same reason as
    //    lib/agent-runs-reaper.ts). The SQLite-text bound is a superset for
    //    ISO rows, which only over-includes a handful of open rows.
    readUnion<RunRow>(runParts,
      `SELECT id, agent_id, started_at, completed_at, duration_ms, status, records_processed, error_message
         FROM agent_runs INDEXED BY idx_agent_runs_open
        WHERE completed_at IS NULL AND status IN ('partial', 'running')
          AND started_at >= ?`,
      [toSqliteTs(nowMs - cfg.openRunLookbackMs)], tally),

    // 3. Feed pulls started near/in the window (idx_feed_pulls_started).
    readAll<PullRow>(db.prepare(
      `SELECT id, feed_name, started_at, completed_at, duration_ms, status,
              records_ingested, records_rejected, error_message
         FROM feed_pull_history
        WHERE (started_at >= ? AND started_at < ?) OR started_at >= ?
        LIMIT ?`,
    ).bind(...sinceRangeBinds(windowStartMs - cfg.pullLookbackMs), cfg.pullSqlLimit), tally),

    // 4. NEXUS workflow lifecycle. agent_activity_log also holds per-message
    //    abuse-mailbox rows etc., so it is read ONLY through
    //    idx_activity_agent (agent_id, created_at DESC), pinned. Newest
    //    first so a capped read drops the OLDEST rows, never in-window
    //    ones; foldWorkflowEvents re-sorts.
    readUnion<ActivityRow>(activityParts,
      `SELECT id, event_type, message, metadata_json, created_at
         FROM agent_activity_log INDEXED BY idx_activity_agent
        WHERE agent_id = ? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [WORKFLOW_AGENT_ID, toSqliteTs(windowStartMs - cfg.workflowLookbackMs), cfg.activitySqlLimit], tally,
      { col: "created_at", limit: cfg.activitySqlLimit }),

    // 5. The one event edge (nexus → observer), idx_agent_events_type_created.
    readUnion<EventRow>(eventParts,
      `SELECT id, source_agent, target_agent, created_at, status
         FROM agent_events
        WHERE event_type = 'pivot_detected' AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [toSqliteTs(windowStartMs), cfg.maxEvents + 1], tally,
      { col: "created_at", limit: cfg.maxEvents + 1 }),
  ]);

  const runs = [
    ...shapeRuns([...windowRunRows, ...openRunRows], windowStartMs, windowEndMs),
    ...windowRuns(foldWorkflowEvents(activityRows, nowMs), windowStartMs, windowEndMs),
  ];
  const boundedRuns = boundRuns(runs, cfg.maxRunsPerAgent, cfg.maxRunsTotal);

  const pulls = boundNewest(shapePulls(pullRows, windowStartMs, windowEndMs), cfg.maxPulls, (p) => p.started_at);

  const events: TimelineEvent[] = [];
  for (const e of eventRows) {
    const ms = tsMs(e.created_at);
    if (ms === null || ms < windowStartMs || ms > windowEndMs) continue;
    events.push({
      id: e.id,
      event_type: "pivot_detected",
      source_agent: e.source_agent,
      target_agent: e.target_agent,
      created_at: new Date(ms).toISOString(),
      status: e.status ?? "pending",
    });
  }
  const boundedEvents = boundNewest(events, cfg.maxEvents, (e) => e.created_at);

  if (cfg.errorsOnlyOnFailure) {
    for (const r of boundedRuns.runs) r.error = keepErrorFor(r.status, r.error);
    for (const p of pulls.items) p.error = keepErrorFor(p.status, p.error);
  }

  const generatedAt = new Date(nowMs).toISOString();
  return {
    window,
    generated_at: generatedAt,
    window_start: new Date(windowStartMs).toISOString(),
    window_end: generatedAt,
    runs: boundedRuns.runs,
    pulls: pulls.items,
    events: boundedEvents.items,
    truncated: {
      runs: boundedRuns.truncated || windowRunRows.length >= cfg.runSqlLimit || activityRows.length >= cfg.activitySqlLimit,
      pulls: pulls.truncated || pullRows.length >= cfg.pullSqlLimit,
      events: boundedEvents.truncated || eventRows.length > cfg.maxEvents,
    },
  };
}

// ─── Handler ────────────────────────────────────────────────────────

export async function handleAgentTimeline(
  request: Request,
  env: Env,
  execCtx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const window = parseTimelineWindow(new URL(request.url).searchParams.get("window"));
  if (!window) {
    return json({ success: false, error: "window must be 1h or 24h" }, 400, origin);
  }
  const cfg = TIMELINE_WINDOWS[window];
  try {
    const value = await cachedValue<AgentTimelineBody>(
      env,
      cfg.cacheKey,
      cfg.ttlSeconds,
      async () => {
        const tally = newTally();
        const db = getReadSession(env, getDbContext(request));
        const data = await computeAgentTimeline(db, Date.now(), tally, window, env);
        // 1h keeps the original attribution label so its history is unbroken.
        recordD1Reads(env, window === "1h" ? "agents_timeline" : "agents_timeline_24h", tally);
        return { success: true, data };
      },
      {
        staleWhileRevalidate: {
          freshSeconds: cfg.freshSeconds,
          waitUntil: execCtx ? (p) => execCtx.waitUntil(p) : undefined,
        },
      },
    );
    return json(value, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
