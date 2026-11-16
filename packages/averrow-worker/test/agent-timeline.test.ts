// GET /api/agents/timeline (handlers/agentTimeline.ts) — the ops Agents
// Network view's run tape.
//
// Pins:
//   - pure helpers: timestamp normalisation, the NEXUS workflow fold, window
//     overlap + open-run clipping, fast_tick → navigator, per-agent / total
//     bounds and truncated flags;
//   - every D1 read is index-backed: the open-runs predicate is textually
//     idx_agent_runs_open's partial WHERE (migration 0320), and each SQL
//     (extracted from source) SEARCHes its intended index on a fully
//     migrated schema — never a SCAN;
//   - the handler: 400 on window ≠ 1h, cachedValue key, response shape,
//     end-to-end over real SQLite with both stored timestamp formats.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_TIMELINE_CACHE_KEY,
  boundNewest,
  boundRuns,
  computeAgentTimeline,
  foldWorkflowEvents,
  handleAgentTimeline,
  normalizeAgentId,
  normalizeTs,
  overlapsWindow,
  shapePulls,
  shapeRuns,
  sinceRangeBinds,
  timelineStatus,
  windowRuns,
  TIMELINE_WINDOWS,
  parseTimelineWindow,
  keepErrorFor,
  toSqliteTs,
  type ActivityRow,
  type TimelineRun,
} from "../src/handlers/agentTimeline";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, sqlContaining, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import type { Env } from "../src/types";

const SRC = resolve(__dirname, "..", "src");
const TIMELINE_SRC = readFileSync(resolve(SRC, "handlers/agentTimeline.ts"), "utf8");

const RUNS_WINDOW_SQL = sqlContaining(TIMELINE_SRC, ["FROM agent_runs\n", "OR started_at >= ?"]);
const OPEN_RUNS_SQL = sqlContaining(TIMELINE_SRC, ["INDEXED BY idx_agent_runs_open"]);
const PULLS_SQL = sqlContaining(TIMELINE_SRC, ["FROM feed_pull_history"]);
const ACTIVITY_SQL = sqlContaining(TIMELINE_SRC, ["FROM agent_activity_log"]);
const EVENTS_SQL = sqlContaining(TIMELINE_SRC, ["FROM agent_events"]);

const NOW = Date.parse("2026-11-15T12:00:00Z");
const WSTART = NOW - 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const sqlite = (ms: number) => iso(ms).slice(0, 19).replace("T", " ");
const minsAgo = (m: number) => NOW - m * 60_000;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const plan = (raw: SqliteDb, sql: string): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");

// ─── normalizeTs ────────────────────────────────────────────────────

describe("normalizeTs", () => {
  it("normalises SQLite text, ISO, zone-less ISO and ms precision to ISO Z", () => {
    expect(normalizeTs("2026-11-15 10:30:00")).toBe("2026-11-15T10:30:00.000Z");
    expect(normalizeTs("2026-11-15T10:30:00Z")).toBe("2026-11-15T10:30:00.000Z");
    expect(normalizeTs("2026-11-15T10:30:00.742Z")).toBe("2026-11-15T10:30:00.742Z");
    expect(normalizeTs("2026-11-15T10:30:00")).toBe("2026-11-15T10:30:00.000Z");
    expect(normalizeTs("2026-11-15 10:30")).toBe("2026-11-15T10:30:00.000Z");
    expect(normalizeTs("2026-11-15T12:30:00+02:00")).toBe("2026-11-15T10:30:00.000Z");
  });

  it("returns null for null, empty and garbage", () => {
    expect(normalizeTs(null)).toBeNull();
    expect(normalizeTs(undefined)).toBeNull();
    expect(normalizeTs("")).toBeNull();
    expect(normalizeTs("not a date")).toBeNull();
  });
});

describe("normalizeAgentId", () => {
  it("folds legacy fast_tick into navigator and leaves others alone", () => {
    expect(normalizeAgentId("fast_tick")).toBe("navigator");
    expect(normalizeAgentId("navigator")).toBe("navigator");
    expect(normalizeAgentId("daily_briefing")).toBe("daily_briefing");
  });
});

describe("timelineStatus", () => {
  it("partial/running without completed_at is running + open", () => {
    expect(timelineStatus("partial", null)).toEqual({ status: "running", open: true });
    expect(timelineStatus("running", null)).toEqual({ status: "running", open: true });
  });
  it("partial WITH completed_at stays partial (degraded / finished)", () => {
    expect(timelineStatus("partial", "2026-11-15 10:00:00")).toEqual({ status: "partial", open: false });
  });
  it("success / failed pass through; failed without completed_at is not open", () => {
    expect(timelineStatus("success", "2026-11-15 10:00:00")).toEqual({ status: "success", open: false });
    expect(timelineStatus("failed", null)).toEqual({ status: "failed", open: false });
  });
});

// ─── Window overlap + clipping ──────────────────────────────────────

describe("overlapsWindow", () => {
  it("includes a run that started before the window and ended inside it", () => {
    expect(overlapsWindow(minsAgo(70), minsAgo(50), false, WSTART, NOW)).toBe(true);
  });
  it("excludes a run that ended before the window", () => {
    expect(overlapsWindow(minsAgo(80), minsAgo(61), false, WSTART, NOW)).toBe(false);
  });
  it("an open run extends to now", () => {
    expect(overlapsWindow(minsAgo(300), null, true, WSTART, NOW)).toBe(true);
  });
  it("a closed run without completed_at is a point at its start", () => {
    expect(overlapsWindow(minsAgo(90), null, false, WSTART, NOW)).toBe(false);
    expect(overlapsWindow(minsAgo(30), null, false, WSTART, NOW)).toBe(true);
  });
  it("edges are inclusive", () => {
    expect(overlapsWindow(minsAgo(90), WSTART, false, WSTART, NOW)).toBe(true);
    expect(overlapsWindow(NOW, NOW, false, WSTART, NOW)).toBe(true);
  });
});

describe("shapeRuns", () => {
  const row = (over: Partial<Parameters<typeof shapeRuns>[0][number]>) => ({
    id: "r1", agent_id: "sentinel", started_at: sqlite(minsAgo(10)), completed_at: sqlite(minsAgo(9)),
    duration_ms: 60_000, status: "success", records_processed: 5, error_message: null, ...over,
  });

  it("clips an open run that started before the window, nulls its duration", () => {
    const [r] = shapeRuns([row({ started_at: sqlite(minsAgo(200)), completed_at: null, status: "partial", duration_ms: null })], WSTART, NOW);
    expect(r).toMatchObject({ status: "running", open: true, clipped_start: true, duration_ms: null, completed_at: null });
    expect(r!.started_at).toBe(iso(minsAgo(200)));
  });

  it("dedupes by id across the window and open-run reads", () => {
    const open = row({ started_at: sqlite(minsAgo(20)), completed_at: null, status: "partial", duration_ms: null });
    expect(shapeRuns([open, { ...open }], WSTART, NOW)).toHaveLength(1);
  });

  it("maps fast_tick to navigator, clips the error to 200 chars, computes a missing duration", () => {
    const [r] = shapeRuns([row({ agent_id: "fast_tick", duration_ms: null, status: "failed", error_message: "x".repeat(500) })], WSTART, NOW);
    expect(r!.agent_id).toBe("navigator");
    expect(r!.error!.length).toBe(200);
    expect(r!.duration_ms).toBe(60_000);
    expect(r!.clipped_start).toBe(false);
    expect(r!.source).toBe("agent_runs");
  });

  it("drops runs entirely outside the window", () => {
    expect(shapeRuns([row({ started_at: sqlite(minsAgo(85)), completed_at: sqlite(minsAgo(70)) })], WSTART, NOW)).toEqual([]);
  });
});

describe("shapePulls", () => {
  it("handles feedRunner's mixed formats (ISO started_at, SQLite completed_at) and open pulls", () => {
    const pulls = shapePulls([
      { id: "p1", feed_name: "urlhaus", started_at: iso(minsAgo(5)), completed_at: sqlite(minsAgo(4)), duration_ms: null, status: "success", records_ingested: 12, records_rejected: 1, error_message: null },
      { id: "p2", feed_name: "taxii_otx", started_at: iso(minsAgo(70)), completed_at: null, duration_ms: null, status: "partial", records_ingested: 0, records_rejected: 0, error_message: null },
      { id: "p3", feed_name: "old", started_at: iso(minsAgo(74)), completed_at: sqlite(minsAgo(72)), duration_ms: 1, status: "success", records_ingested: 0, records_rejected: 0, error_message: null },
    ], WSTART, NOW);
    expect(pulls.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(pulls[0]).toMatchObject({ status: "success", open: false, duration_ms: 60_000, records_ingested: 12, records_rejected: 1 });
    expect(pulls[1]).toMatchObject({ status: "running", open: true, clipped_start: true, duration_ms: null });
  });
});

// ─── Workflow fold ──────────────────────────────────────────────────

let seq = 0;
const act = (event_type: string, ms: number, meta: Record<string, unknown> | null = null, message: string | null = null): ActivityRow => ({
  id: `a${++seq}`, event_type, message, metadata_json: meta ? JSON.stringify(meta) : null, created_at: sqlite(ms),
});

describe("foldWorkflowEvents", () => {
  it("dispatched → started → batch_complete is one successful run keyed by instance id", () => {
    const runs = foldWorkflowEvents([
      act("workflow_dispatched", minsAgo(50), { instance_id: "inst-1" }),
      act("started", minsAgo(49)),
      act("batch_complete", minsAgo(30), { clustersWritten: 3, cert_serial_clusters: 2, per_ip_clusters: 1, subnet24_clusters: 0, registrar_clusters: 4, cert_san_clusters: 1, pivotsDetected: 99 }),
    ], NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "wf:inst-1", agent_id: "nexus", source: "workflow", status: "success", open: false,
      started_at: iso(minsAgo(49)), completed_at: iso(minsAgo(30)), duration_ms: 19 * 60_000,
      records_processed: 11, error: null,
    });
  });

  it("is order-independent (rows arrive sorted by created_at only)", () => {
    const rows = [
      act("batch_complete", minsAgo(30), { clustersWritten: 1 }),
      act("workflow_dispatched", minsAgo(50), { instance_id: "i" }),
      act("started", minsAgo(49)),
    ];
    expect(foldWorkflowEvents(rows, NOW)[0]).toMatchObject({ id: "wf:i", status: "success", records_processed: 1 });
  });

  it("workflow_failed closes the run as failed with the metadata error", () => {
    const [r] = foldWorkflowEvents([
      act("workflow_dispatched", minsAgo(40), { instance_id: "x" }),
      act("started", minsAgo(39)),
      act("workflow_failed", minsAgo(20), { error: "D1 DB is overloaded" }, "NEXUS Workflow terminated"),
    ], NOW);
    expect(r).toMatchObject({ id: "wf:x", status: "failed", open: false, error: "D1 DB is overloaded", records_processed: 0 });
  });

  it("workflow_dispatch_failed is a zero-length failed run; cooldown skips are ignored", () => {
    const rows = [
      act("workflow_dispatch_failed", minsAgo(15), { error: "WorkflowInternalError" }),
      act("workflow_cooldown_skip", minsAgo(10), { cooldown_remaining_sec: 100 }),
    ];
    const runs = foldWorkflowEvents(rows, NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: `wf:${rows[0]!.id}`, status: "failed", duration_ms: 0, error: "WorkflowInternalError" });
    expect(runs[0]!.started_at).toBe(runs[0]!.completed_at);
  });

  it("an unclosed run under 3h is running/open; at 3h+ it is failed 'no completion event'", () => {
    const runs = foldWorkflowEvents([
      act("workflow_dispatched", minsAgo(200), { instance_id: "stale" }),
      act("workflow_dispatched", minsAgo(20), { instance_id: "live" }),
      act("started", minsAgo(19)),
    ], NOW);
    const byId = new Map(runs.map((r) => [r.id, r]));
    // The stale dispatch is expired before the `started` row, so it can't
    // absorb the live run's start.
    expect(byId.get("wf:stale")).toMatchObject({ status: "failed", open: false, error: "no completion event", completed_at: null });
    expect(byId.get("wf:live")).toMatchObject({ status: "running", open: true, started_at: iso(minsAgo(19)) });
  });

  it("an unclosed run at the end that is 3h+ old is failed, not open", () => {
    const [r] = foldWorkflowEvents([act("workflow_dispatched", minsAgo(181), { instance_id: "lost" })], NOW);
    expect(r).toMatchObject({ status: "failed", open: false, error: "no completion event" });
  });

  it("started pairs with the NEWEST un-started dispatch; completion closes the started run", () => {
    const runs = foldWorkflowEvents([
      act("workflow_dispatched", minsAgo(100), { instance_id: "never-started" }),
      act("workflow_dispatched", minsAgo(20), { instance_id: "b" }),
      act("started", minsAgo(19)),
      act("batch_complete", minsAgo(5), { clustersWritten: 1 }),
    ], NOW);
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get("wf:b")).toMatchObject({ status: "success", started_at: iso(minsAgo(19)), completed_at: iso(minsAgo(5)) });
    expect(byId.get("wf:never-started")).toMatchObject({ status: "running", open: true });
  });

  // created_at has 1 s resolution; ids are random UUIDs, so a tie must not
  // depend on id order. Ids chosen to sort the "wrong" way round.
  const tieRow = (id: string, event_type: string, ms: number, meta: Record<string, unknown> | null = null): ActivityRow => ({
    id, event_type, message: null, metadata_json: meta ? JSON.stringify(meta) : null, created_at: sqlite(ms),
  });

  it("same-second dispatched + started fold into ONE run whichever id sorts first", () => {
    for (const [dispatchId, startId] of [["zzz", "aaa"], ["aaa", "zzz"]]) {
      const runs = foldWorkflowEvents([
        tieRow(startId!, "started", minsAgo(30)),
        tieRow(dispatchId!, "workflow_dispatched", minsAgo(30), { instance_id: "tie" }),
        tieRow("mmm", "batch_complete", minsAgo(10), { clustersWritten: 1 }),
      ], NOW);
      expect(runs, `${dispatchId}/${startId}`).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: "wf:tie", status: "success", open: false, started_at: iso(minsAgo(30)) });
    }
  });

  it("same-second started + batch_complete close the run, not leave it open", () => {
    const runs = foldWorkflowEvents([
      tieRow("b", "batch_complete", minsAgo(5), { clustersWritten: 2 }),
      tieRow("a", "workflow_dispatched", minsAgo(6), { instance_id: "q" }),
      tieRow("z", "started", minsAgo(5)),
    ], NOW);
    expect(runs).toEqual([expect.objectContaining({ id: "wf:q", status: "success", duration_ms: 0, records_processed: 2 })]);
  });

  it("a started that lands seconds BEFORE its dispatch adopts that dispatch (one run, instance id)", () => {
    const t = minsAgo(30);
    const runs = foldWorkflowEvents([
      tieRow("s", "started", t),
      tieRow("d", "workflow_dispatched", t + 3_000, { instance_id: "late" }),
    ], NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "wf:late", status: "running", open: true, started_at: iso(t) });
  });

  it("a dispatch beyond the adopt tolerance after an orphan start opens its own run", () => {
    const t = minsAgo(30);
    const runs = foldWorkflowEvents([
      tieRow("s", "started", t),
      tieRow("d", "workflow_dispatched", t + 61_000, { instance_id: "next" }),
    ], NOW);
    expect(runs.map((r) => r.id).sort()).toEqual(["wf:next", "wf:s"]);
  });

  it("falls back to wf:<activity id> when dispatched metadata has no instance id", () => {
    const rows = [act("workflow_dispatched", minsAgo(5), { workflow: "nexus-run" })];
    expect(foldWorkflowEvents(rows, NOW)[0]!.id).toBe(`wf:${rows[0]!.id}`);
  });

  it("a started with no dispatch in the lookback opens its own run", () => {
    const rows = [act("started", minsAgo(30)), act("batch_complete", minsAgo(10), { clustersWritten: 2 })];
    expect(foldWorkflowEvents(rows, NOW)).toEqual([
      expect.objectContaining({ id: `wf:${rows[0]!.id}`, status: "success", records_processed: 2, started_at: iso(minsAgo(30)) }),
    ]);
  });

  it("a completion with nothing open becomes a zero-length run at its own time", () => {
    const [r] = foldWorkflowEvents([act("batch_complete", minsAgo(10), { clustersWritten: 2 })], NOW);
    expect(r).toMatchObject({ status: "success", duration_ms: 0, records_processed: 2 });
  });

  it("bad metadata JSON is tolerated", () => {
    const row: ActivityRow = { id: "bad", event_type: "workflow_dispatched", message: null, metadata_json: "{not json", created_at: sqlite(minsAgo(5)) };
    expect(foldWorkflowEvents([row], NOW)[0]!.id).toBe("wf:bad");
  });

  it("windowRuns keeps only overlapping folded runs and sets clipped_start", () => {
    const runs = foldWorkflowEvents([
      act("workflow_dispatched", minsAgo(240), { instance_id: "old" }),
      act("batch_complete", minsAgo(200), { clustersWritten: 1 }),
      act("workflow_dispatched", minsAgo(90), { instance_id: "spans" }),
      act("batch_complete", minsAgo(40), { clustersWritten: 1 }),
    ], NOW);
    const windowed = windowRuns(runs, WSTART, NOW);
    expect(windowed.map((r) => r.id)).toEqual(["wf:spans"]);
    expect(windowed[0]!.clipped_start).toBe(true);
  });
});

// ─── Bounds ─────────────────────────────────────────────────────────

const mkRun = (agent: string, i: number): TimelineRun => ({
  id: `${agent}-${i}`, agent_id: agent, source: "agent_runs", started_at: iso(minsAgo(59) + i * 1000),
  completed_at: null, status: "success", open: false, clipped_start: false, duration_ms: 1, records_processed: 0, error: null,
});

describe("boundRuns / boundNewest", () => {
  it("keeps the newest 60 per agent and flags truncation", () => {
    const runs = Array.from({ length: 80 }, (_, i) => mkRun("navigator", i));
    const out = boundRuns(runs);
    expect(out.truncated).toBe(true);
    expect(out.runs).toHaveLength(60);
    expect(out.runs[0]!.id).toBe("navigator-20"); // oldest kept, oldest-first order
    expect(out.runs[59]!.id).toBe("navigator-79");
  });

  it("caps the total at 400 across agents", () => {
    const runs = Array.from({ length: 10 }, (_, a) => Array.from({ length: 50 }, (_, i) => mkRun(`agent${a}`, i))).flat();
    const out = boundRuns(runs);
    expect(out.runs).toHaveLength(400);
    expect(out.truncated).toBe(true);
  });

  it("is not truncated under the bounds", () => {
    const out = boundRuns([mkRun("a", 1), mkRun("b", 2)]);
    expect(out).toEqual({ runs: [mkRun("a", 1), mkRun("b", 2)], truncated: false });
  });

  it("boundNewest keeps the newest N, oldest-first", () => {
    const out = boundNewest(["c", "a", "d", "b"], 2, (s) => s);
    expect(out).toEqual({ items: ["c", "d"], truncated: true });
    expect(boundNewest(["a"], 2, (s) => s)).toEqual({ items: ["a"], truncated: false });
  });
});

// ─── SQL: index pins ────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("agent timeline SQL is index-backed", () => {
  it("the open-runs read repeats idx_agent_runs_open's partial WHERE (migration 0320) verbatim", () => {
    const ddl = liveIndexDdl("agent_runs").get("idx_agent_runs_open");
    expect(ddl).toBeDefined();
    const where = /WHERE\s+(.+?);?\s*$/s.exec(norm(ddl!))![1]!;
    expect(where).toBe("completed_at IS NULL AND status IN ('partial', 'running')");
    expect(norm(OPEN_RUNS_SQL)).toContain(`WHERE ${where} AND started_at >= ?`);
  });

  it("each read SEARCHes its index on the fully migrated schema, never a SCAN", () => {
    const db = openMigratedDb();
    const cases: Array<[string, RegExp, string]> = [
      [RUNS_WINDOW_SQL, /MULTI-INDEX OR.*SEARCH agent_runs USING INDEX idx_agent_runs_started.*SEARCH agent_runs USING INDEX idx_agent_runs_started/, "agent_runs"],
      [OPEN_RUNS_SQL, /SEARCH agent_runs USING INDEX idx_agent_runs_open \(started_at>\?\)/, "agent_runs"],
      [PULLS_SQL, /MULTI-INDEX OR.*SEARCH feed_pull_history USING INDEX idx_feed_pulls_started.*SEARCH feed_pull_history USING INDEX idx_feed_pulls_started/, "feed_pull_history"],
      [ACTIVITY_SQL, /SEARCH agent_activity_log USING INDEX idx_activity_agent \(agent_id=\? AND created_at>\?\)/, "agent_activity_log"],
      [EVENTS_SQL, /SEARCH agent_events USING INDEX idx_agent_events_type_created \(event_type=\? AND created_at>\?\)/, "agent_events"],
    ];
    for (const [sql, want, table] of cases) {
      const p = plan(db, sql);
      expect(p, sql).toMatch(want);
      expect(p, sql).not.toMatch(new RegExp(`SCAN ${table}\\b`));
      expect(p, sql).not.toMatch(/USE TEMP B-TREE/);
    }
  });

  it("the activity read is newest-first so a capped read drops the oldest rows", () => {
    expect(norm(ACTIVITY_SQL)).toContain("ORDER BY created_at DESC LIMIT ?");
  });

  it("the started_at range is exact for both stored formats (== datetime() filter)", () => {
    const raw = openMigratedDb();
    const ins = raw.prepare("INSERT INTO agent_runs (id, agent_id, started_at, status) VALUES (?, 'sentinel', ?, 'success')");
    const since = Date.parse("2026-11-15T10:30:00Z");
    let n = 0;
    for (const offMin of [-1500, -61, -1, 0, 1, 59, 600, 1500]) {
      const ms = since + offMin * 60_000;
      for (const v of [sqlite(ms), iso(ms).slice(0, 19) + "Z", iso(ms)]) ins.run(`r${n++}`, v);
    }
    const ranged = (raw.prepare(RUNS_WINDOW_SQL).all(...sinceRangeBinds(since), 10_000) as Array<{ id: string }>).map((r) => r.id).sort();
    const exact = (raw.prepare("SELECT id FROM agent_runs WHERE datetime(started_at) >= datetime(?)").all(sqlite(since)) as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ranged).toEqual(exact);
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged.length).toBeLessThan(n);
  });
});

// ─── End to end over SQLite ─────────────────────────────────────────

function seededDb(): SqliteDb {
  const raw = openMigratedDb();
  const run = raw.prepare(
    "INSERT INTO agent_runs (id, agent_id, started_at, completed_at, duration_ms, status, records_processed, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  run.run("in", "sentinel", sqlite(minsAgo(10)), sqlite(minsAgo(9)), 60_000, "success", 7, null);
  run.run("legacy", "fast_tick", sqlite(minsAgo(20)), sqlite(minsAgo(19)), 1000, "success", 1, null);
  run.run("old-open", "cartographer", sqlite(minsAgo(150)), null, null, "partial", 0, null);
  run.run("ancient-open", "cartographer", sqlite(minsAgo(500)), null, null, "partial", 0, null);
  run.run("before", "analyst", sqlite(minsAgo(100)), sqlite(minsAgo(95)), 1, "success", 0, null);
  run.run("degraded", "observer", sqlite(minsAgo(5)), sqlite(minsAgo(4)), 1, "partial", 0, "ai degraded");
  const pull = raw.prepare(
    "INSERT INTO feed_pull_history (id, feed_name, started_at, completed_at, status, records_ingested) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // feedRunner shape: ISO started_at, SQLite completed_at. The ISO row from
  // earlier on the window's date must not leak in.
  pull.run("p-in", "urlhaus", iso(minsAgo(3)), sqlite(minsAgo(2)), "success", 4);
  pull.run("p-old-same-day", "urlhaus", iso(minsAgo(300)), sqlite(minsAgo(299)), "success", 4);
  const log = raw.prepare(
    "INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  log.run("l1", "nexus", "workflow_dispatched", "d", JSON.stringify({ instance_id: "abc" }), sqlite(minsAgo(45)));
  log.run("l2", "nexus", "started", "s", null, sqlite(minsAgo(44)));
  log.run("l3", "nexus", "batch_complete", "c", JSON.stringify({ clustersWritten: 5 }), sqlite(minsAgo(25)));
  log.run("l4", "abuse_mailbox_classifier", "batch_complete", "x", null, sqlite(minsAgo(5)));
  const ev = raw.prepare(
    "INSERT INTO agent_events (id, event_type, source_agent, target_agent, created_at, status) VALUES (?, ?, ?, ?, ?, ?)",
  );
  ev.run("e1", "pivot_detected", "nexus", "observer", sqlite(minsAgo(12)), "done");
  ev.run("e2", "nexus_complete", "nexus", null, sqlite(minsAgo(12)), "done");
  ev.run("e3", "pivot_detected", "nexus", "observer", sqlite(minsAgo(90)), "done");
  return raw;
}

describe.skipIf(!hasSqlite())("computeAgentTimeline over SQLite", () => {
  it("returns the contract shape with windowed runs, pulls and pivot events", async () => {
    const data = await computeAgentTimeline(d1FromSqlite(seededDb()), NOW);
    expect(data).toMatchObject({
      window: "1h",
      generated_at: iso(NOW),
      window_end: iso(NOW),
      window_start: iso(WSTART),
      truncated: { runs: false, pulls: false, events: false },
    });
    const ids = data.runs.map((r) => r.id).sort();
    expect(ids).toEqual(["degraded", "in", "legacy", "old-open", "wf:abc"].sort());
    const byId = new Map(data.runs.map((r) => [r.id, r]));
    expect(byId.get("legacy")!.agent_id).toBe("navigator");
    expect(byId.get("old-open")).toMatchObject({ status: "running", open: true, clipped_start: true });
    expect(byId.get("degraded")).toMatchObject({ status: "partial", open: false, error: "ai degraded" });
    expect(byId.get("wf:abc")).toMatchObject({ source: "workflow", agent_id: "nexus", status: "success", records_processed: 5 });
    // Oldest-first.
    const starts = data.runs.map((r) => r.started_at);
    expect([...starts].sort()).toEqual(starts);

    expect(data.pulls.map((p) => p.id)).toEqual(["p-in"]);
    expect(data.events).toEqual([
      { id: "e1", event_type: "pivot_detected", source_agent: "nexus", target_agent: "observer", created_at: iso(minsAgo(12)), status: "done" },
    ]);
  });
});

// ─── Handler ────────────────────────────────────────────────────────

function envFor(db: D1Database, kv = fakeKv()): { env: Env; kv: ReturnType<typeof fakeKv> } {
  // getReadSession → env.DB.withSession(); the harness DB stands in for the session.
  const env = { DB: Object.assign(db, { withSession: () => db }), CACHE: kv } as unknown as Env;
  return { env, kv };
}

describe.skipIf(!hasSqlite())("handleAgentTimeline", () => {
  it("400s on any window other than 1h or 24h", async () => {
    const { env } = envFor(d1FromSqlite(openMigratedDb()));
    for (const w of ["1H", "24H", "", "60m", "7d", "48h", "1h,24h"]) {
      const res = await handleAgentTimeline(new Request(`https://x/api/agents/timeline?window=${encodeURIComponent(w)}`), env);
      expect(res.status, w).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: "window must be 1h or 24h" });
    }
  });

  it("serves window=24h under its own cache key, separate from 1h", async () => {
    const { env, kv } = envFor(d1FromSqlite(seededDb()));
    const res = await handleAgentTimeline(new Request("https://x/api/agents/timeline?window=24h"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { window: string } };
    expect(body.data.window).toBe("24h");
    expect(kv.store.has("cv:agents_timeline:v1:24h")).toBe(true);
    expect(kv.store.has("cv:agents_timeline:v1:1h")).toBe(false);
    await handleAgentTimeline(new Request("https://x/api/agents/timeline?window=1h"), env);
    expect(kv.store.has("cv:agents_timeline:v1:1h")).toBe(true);
    expect(JSON.parse(kv.store.get("cv:agents_timeline:v1:1h")!).v.data.window).toBe("1h");
    expect(JSON.parse(kv.store.get("cv:agents_timeline:v1:24h")!).v.data.window).toBe("24h");
  });

  it("serves window=1h (and the default) through cachedValue key agents_timeline:v1:1h", async () => {
    expect(AGENT_TIMELINE_CACHE_KEY).toBe("agents_timeline:v1:1h");
    const { env, kv } = envFor(d1FromSqlite(seededDb()));
    const res = await handleAgentTimeline(new Request("https://x/api/agents/timeline?window=1h"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { window: string; runs: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.window).toBe("1h");
    expect(kv.store.has("cv:agents_timeline:v1:1h")).toBe(true);

    const again = await handleAgentTimeline(new Request("https://x/api/agents/timeline"), env);
    expect(again.status).toBe(200);
  });

  it("is routed before /api/agents/:name under requireStaff", () => {
    const routes = readFileSync(resolve(SRC, "routes/agents.ts"), "utf8");
    const timelineAt = routes.indexOf('"/api/agents/timeline"');
    const nameAt = routes.indexOf('router.get("/api/agents/:name"');
    expect(timelineAt).toBeGreaterThan(-1);
    expect(timelineAt).toBeLessThan(nameAt);
    const block = routes.slice(timelineAt, routes.indexOf("});", timelineAt));
    expect(block).toContain("requireStaff(request, env)");
  });
});

// ─── 24h window ─────────────────────────────────────────────────────

describe("24h window config", () => {
  it("matches the Round 4 contract", () => {
    const c = TIMELINE_WINDOWS["24h"];
    expect(c).toMatchObject({
      windowMs: 24 * 3_600_000, runLookbackMs: 30 * 60_000, pullLookbackMs: 15 * 60_000,
      openRunLookbackMs: 30 * 3_600_000, workflowLookbackMs: 4 * 3_600_000,
      maxRunsPerAgent: 400, maxRunsTotal: 6000, maxPulls: 4000, maxEvents: 300,
      cacheKey: "agents_timeline:v1:24h", ttlSeconds: 300, freshSeconds: 120, errorsOnlyOnFailure: true,
    });
    expect(c.runSqlLimit).toBeGreaterThan(c.maxRunsTotal);
    expect(c.pullSqlLimit).toBeGreaterThan(c.maxPulls);
    // 1h unchanged.
    expect(TIMELINE_WINDOWS["1h"]).toMatchObject({
      windowMs: 3_600_000, openRunLookbackMs: 6 * 3_600_000, workflowLookbackMs: 4 * 3_600_000,
      maxRunsPerAgent: 60, maxRunsTotal: 400, maxPulls: 300, maxEvents: 50,
      cacheKey: "agents_timeline:v1:1h", ttlSeconds: 60, freshSeconds: 30, errorsOnlyOnFailure: false,
    });
  });

  it("parseTimelineWindow defaults to 1h and rejects anything else", () => {
    expect(parseTimelineWindow(null)).toBe("1h");
    expect(parseTimelineWindow("1h")).toBe("1h");
    expect(parseTimelineWindow("24h")).toBe("24h");
    expect(parseTimelineWindow("")).toBeNull();
    expect(parseTimelineWindow("7d")).toBeNull();
  });

  it("keepErrorFor keeps errors only on failed / partial", () => {
    expect(keepErrorFor("failed", "x")).toBe("x");
    expect(keepErrorFor("partial", "x")).toBe("x");
    expect(keepErrorFor("success", "x")).toBeNull();
    expect(keepErrorFor("running", "x")).toBeNull();
  });
});

describe.skipIf(!hasSqlite())("24h SQL plans (24h binds)", () => {
  it("each read SEARCHes its index with 24h binds — no SCAN, no temp B-tree", () => {
    const db = openMigratedDb();
    const c = TIMELINE_WINDOWS["24h"];
    const wstart = NOW - c.windowMs;
    const cases: Array<[string, unknown[], RegExp, string]> = [
      [RUNS_WINDOW_SQL, [...sinceRangeBinds(wstart - c.runLookbackMs), c.runSqlLimit],
        /MULTI-INDEX OR.*idx_agent_runs_started.*idx_agent_runs_started/, "agent_runs"],
      [OPEN_RUNS_SQL, [toSqliteTs(NOW - c.openRunLookbackMs)], /SEARCH agent_runs USING INDEX idx_agent_runs_open \(started_at>\?\)/, "agent_runs"],
      [PULLS_SQL, [...sinceRangeBinds(wstart - c.pullLookbackMs), c.pullSqlLimit],
        /MULTI-INDEX OR.*idx_feed_pulls_started.*idx_feed_pulls_started/, "feed_pull_history"],
      [ACTIVITY_SQL, ["nexus", toSqliteTs(wstart - c.workflowLookbackMs), c.activitySqlLimit],
        /SEARCH agent_activity_log USING INDEX idx_activity_agent \(agent_id=\? AND created_at>\?\)/, "agent_activity_log"],
      [EVENTS_SQL, [toSqliteTs(wstart), c.maxEvents + 1],
        /SEARCH agent_events USING INDEX idx_agent_events_type_created \(event_type=\? AND created_at>\?\)/, "agent_events"],
    ];
    for (const [sql, binds, want, table] of cases) {
      const p = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as Array<string | number>)) as Array<{ detail: string }>)
        .map((r) => r.detail).join(" | ");
      expect(p, sql).toMatch(want);
      expect(p, sql).not.toMatch(new RegExp(`SCAN ${table}\\b`));
      expect(p, sql).not.toMatch(/USE TEMP B-TREE/);
    }
  });
});

describe.skipIf(!hasSqlite())("computeAgentTimeline 24h at daily volume", () => {
  function dailyDb(opts: { navigatorRuns: number; pulls: number; extraAgents?: number; runsPerExtra?: number }): SqliteDb {
    const raw = openMigratedDb();
    const run = raw.prepare(
      "INSERT INTO agent_runs (id, agent_id, started_at, completed_at, duration_ms, status, records_processed, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const span = 24 * 60; // minutes in the window
    for (let i = 0; i < opts.navigatorRuns; i++) {
      const start = NOW - Math.floor(((i + 0.5) * span) / opts.navigatorRuns) * 60_000;
      // Every 10th run failed with an error; successes also carry error text
      // so the 24h trim is observable.
      run.run(`nav${i}`, i % 2 ? "navigator" : "fast_tick", sqlite(start), sqlite(start + 20_000), 20_000,
        i % 10 === 0 ? "failed" : "success", 3, i % 10 === 0 ? "boom" : "noise");
    }
    for (let a = 0; a < (opts.extraAgents ?? 0); a++) {
      for (let i = 0; i < (opts.runsPerExtra ?? 0); i++) {
        const start = NOW - (i * 4 + a * 0.1) * 60_000;
        run.run(`x${a}-${i}`, `agent${a}`, sqlite(start), sqlite(start + 1000), 1000, "partial", 0, "degraded");
      }
    }
    // A run older than the window (+ lookback) must not appear.
    run.run("too-old", "sentinel", sqlite(NOW - 25 * 3_600_000), sqlite(NOW - 25 * 3_600_000 + 1000), 1000, "success", 0, null);
    const pull = raw.prepare(
      "INSERT INTO feed_pull_history (id, feed_name, started_at, completed_at, status, records_ingested, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < opts.pulls; i++) {
      const start = NOW - Math.floor((i * span * 60_000) / opts.pulls);
      pull.run(`p${i}`, `feed${i % 50}`, iso(start), sqlite(start + 5000), i % 7 ? "success" : "failed", 1, i % 7 ? "warn" : "pull failed");
    }
    return raw;
  }

  it("300 navigator runs + 1500 pulls fit the 24h bounds untruncated, errors only on failed/partial", async () => {
    const data = await computeAgentTimeline(d1FromSqlite(dailyDb({ navigatorRuns: 300, pulls: 1500 })), NOW, undefined, "24h");
    expect(data.window).toBe("24h");
    expect(data.window_start).toBe(iso(NOW - 24 * 3_600_000));
    expect(data.truncated).toEqual({ runs: false, pulls: false, events: false });
    const nav = data.runs.filter((r) => r.agent_id === "navigator");
    expect(nav).toHaveLength(300); // fast_tick folded in
    expect(data.runs.some((r) => r.id === "too-old")).toBe(false);
    expect(data.pulls).toHaveLength(1500);
    for (const r of data.runs) expect(r.error).toBe(r.status === "failed" ? "boom" : null);
    for (const p of data.pulls) expect(p.error).toBe(p.status === "failed" ? "pull failed" : null);
    const starts = data.runs.map((r) => r.started_at);
    expect([...starts].sort()).toEqual(starts);
  });

  it("caps navigator at 400/agent (newest kept) and pulls at 4000, setting truncated", async () => {
    const data = await computeAgentTimeline(d1FromSqlite(dailyDb({ navigatorRuns: 500, pulls: 4500 })), NOW, undefined, "24h");
    const nav = data.runs.filter((r) => r.agent_id === "navigator");
    expect(nav).toHaveLength(400);
    // Newest kept: the most recent navigator run (nav0) is present.
    expect(nav.some((r) => r.id === "nav0")).toBe(true);
    expect(nav.some((r) => r.id === "nav499")).toBe(false);
    expect(data.pulls).toHaveLength(4000);
    expect(data.pulls.some((p) => p.id === "p0")).toBe(true);
    expect(data.truncated.runs).toBe(true);
    expect(data.truncated.pulls).toBe(true);
    // Partial rows keep their error at 24h.
    expect(data.runs.filter((r) => r.status === "partial").every((r) => r.error === "degraded")).toBe(true);
  });

  it("caps the 24h total at 6000 runs", async () => {
    const data = await computeAgentTimeline(
      d1FromSqlite(dailyDb({ navigatorRuns: 0, pulls: 0, extraAgents: 20, runsPerExtra: 320 })), NOW, undefined, "24h");
    expect(data.runs).toHaveLength(6000);
    expect(data.truncated.runs).toBe(true);
  });

  it("the same data at 1h keeps the 1h bounds and all error text", async () => {
    const data = await computeAgentTimeline(d1FromSqlite(dailyDb({ navigatorRuns: 300, pulls: 1500 })), NOW);
    expect(data.window).toBe("1h");
    expect(data.runs.length).toBeLessThanOrEqual(60);
    expect(data.pulls.length).toBeLessThanOrEqual(300);
    expect(data.truncated.pulls).toBe(false); // ~63 pulls in the last hour
    expect(data.pulls.some((p) => p.error === "warn")).toBe(true);
  });
});
