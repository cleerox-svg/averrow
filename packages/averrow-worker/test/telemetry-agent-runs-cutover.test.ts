/**
 * Track B1c — the agent-runs family on TELEMETRY_DB (write-forward + union reads).
 *
 * Two real SQLite databases stand in for core (every migrations/ file) and
 * TELEMETRY_DB (every migrations-telemetry/ file). Pins:
 *   1. A run is inserted on the routed DB and every later write of the run
 *      goes to THAT DB, even when db_route:telemetry flips mid-run
 *      (createAgentRun/finalizeAgentRun handle; executeAgent; both ways).
 *   2. route='core' (flag unset) is one core part with no split — today's read.
 *   3. Union row reads dedupe a backfilled copy; union aggregates never count
 *      a copied row twice (split predicate from the backfill cursor).
 *   4. Flight Control's getAgentHealth sees the newest run in either DB and
 *      tags its DB (the orphan force-fail goes there).
 *   5. The orphan reaper sweeps both DBs.
 *   6. copy-config / backfill are idempotent and resumable; preflight blocks
 *      until config rows are copied.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";
import type { Env } from "../src/types";
import type { AgentModule } from "../src/lib/agentRunner";
import { resetTelemetryRouteCache, TELEMETRY_ROUTE_KV_KEY, TELEMETRY_USED_KV_KEY } from "../src/lib/db-route";
import {
  historyParts,
  mergeGroupedRows,
  resetBackfillCursorCache,
  unionGrouped,
  unionRows,
  byDesc,
  applySplit,
} from "../src/lib/telemetry-read";
import { createAgentRun, finalizeAgentRun, getLatestRun, listRunsForAgent, updateAgentRunProgress } from "../src/db/agent-runs";
import { executeAgent } from "../src/lib/agentRunner";
import { getAgentHealth } from "../src/agents/flightControl";
import { reapOrphanAgentRuns } from "../src/lib/agent-runs-reaper";
import { processAgentEvents } from "../src/cron/orchestrator";
import {
  backfillTelemetryHistory,
  copyTelemetryConfig,
  telemetryPreflight,
  COPY_COLUMNS,
  backfillSelectSql,
} from "../src/lib/telemetry-cutover";

function openTelemetryDb(): SqliteDb {
  const nodeRequire = createRequire(import.meta.url);
  const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(":memory:");
  const dir = resolve(__dirname, "..", "migrations-telemetry");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of splitStatements(readFileSync(resolve(dir, file), "utf8"))) db.exec(stmt);
  }
  return db;
}

interface World {
  core: SqliteDb;
  tel: SqliteDb;
  kv: ReturnType<typeof fakeKv>;
  env: Env;
  route(r: "core" | "telemetry" | null): void;
}

// Built once: replaying every core migration is the slow part.
let coreTemplate: SqliteDb | null = null;

function world(route: "core" | "telemetry" | null = "telemetry"): World {
  // Fresh core per test: clear the family tables of the shared migrated DB.
  coreTemplate ??= openMigratedDb();
  const core = coreTemplate;
  for (const t of ["agent_runs", "agent_configs", "agent_events", "agent_activity_log", "agent_approvals"]) core.exec(`DELETE FROM ${t}`);
  const tel = openTelemetryDb();
  const kv = fakeKv();
  const env = { DB: d1FromSqlite(core), TELEMETRY_DB: d1FromSqlite(tel), CACHE: kv } as unknown as Env;
  const w: World = {
    core, tel, kv, env,
    route(r) {
      if (r === null) kv.store.delete(TELEMETRY_ROUTE_KV_KEY);
      else kv.store.set(TELEMETRY_ROUTE_KV_KEY, r);
      resetTelemetryRouteCache();
    },
  };
  w.route(route);
  return w;
}

const rowsOf = (db: SqliteDb, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Array<Record<string, unknown>>;
const runIds = (db: SqliteDb) => rowsOf(db, "SELECT id FROM agent_runs ORDER BY id").map((r) => r.id);

function insertRun(db: SqliteDb, id: string, agent: string, hoursAgo: number, status = "success", completed = true): void {
  const ts = sqliteTimestampHoursAgo(hoursAgo);
  db.prepare(
    `INSERT INTO agent_runs (id, agent_id, started_at, completed_at, duration_ms, status) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, agent, ts, completed ? ts : null, 1000, status);
}

beforeEach(() => {
  resetTelemetryRouteCache();
  resetBackfillCursorCache();
});

describe.skipIf(!hasSqlite())("run lifecycle carries its DB (resolve once)", () => {
  it("created on telemetry, finalized on telemetry after a flip back to core", async () => {
    const w = world("telemetry");
    const run = await createAgentRun(w.env, "daily_snapshots");
    expect(run.route).toBe("telemetry");
    w.route("core");
    await updateAgentRunProgress(w.env, run, 7);
    const fin = await finalizeAgentRun(w.env, run, { kind: "complete", stats: { records_processed: 9, outputs_generated: 1 } });
    expect(fin.ok).toBe(true);
    expect(runIds(w.core)).toEqual([]);
    expect(rowsOf(w.tel, "SELECT status, records_processed, completed_at FROM agent_runs WHERE id = ?", run.id)[0])
      .toMatchObject({ status: "success", records_processed: 9 });
  });

  it("created on core, finalized on core after a flip to telemetry", async () => {
    const w = world(null);
    const run = await createAgentRun(w.env, "daily_snapshots");
    expect(run.route).toBe("core");
    w.route("telemetry");
    await finalizeAgentRun(w.env, run, { kind: "failed", error_message: "boom" });
    expect(runIds(w.tel)).toEqual([]);
    expect(rowsOf(w.core, "SELECT status, error_message FROM agent_runs WHERE id = ?", run.id)[0])
      .toMatchObject({ status: "failed", error_message: "boom" });
  });

  it("executeAgent inserts, finalizes and resets the breaker on the DB it resolved at start", async () => {
    const w = world("telemetry");
    w.tel.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('b1c_probe', 'approved', datetime('now'))").run();
    const mod = {
      name: "b1c_probe",
      displayName: "probe",
      description: "test",
      color: "#000",
      trigger: "manual",
      stallThresholdMinutes: 30,
      async execute() {
        w.route("core"); // flip mid-run
        return { itemsProcessed: 3, itemsCreated: 0, itemsUpdated: 0, output: {} };
      },
    } as unknown as AgentModule;
    const res = await executeAgent(w.env, mod, {}, null, "manual");
    expect(res.status).toBe("success");
    expect(runIds(w.core)).toEqual([]);
    expect(rowsOf(w.tel, "SELECT status, records_processed, completed_at IS NOT NULL AS done FROM agent_runs")[0])
      .toMatchObject({ status: "success", records_processed: 3, done: 1 });
    expect(rowsOf(w.tel, "SELECT agent_id FROM agent_configs").map((r) => r.agent_id)).toEqual(["b1c_probe"]);
    expect(rowsOf(w.core, "SELECT agent_id FROM agent_configs")).toEqual([]);
  });
});

describe.skipIf(!hasSqlite())("union reads", () => {
  it("route core (flag unset) is one core part with no split", async () => {
    const w = world(null);
    const parts = await historyParts(w.env, "agent_runs");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ source: "core", split: "", splitBinds: [] });
  });

  it("route telemetry reads telemetry first, then core; row reads dedupe a copied row", async () => {
    const w = world("telemetry");
    insertRun(w.core, "old", "sentinel", 30);
    insertRun(w.core, "shared", "sentinel", 26);
    insertRun(w.tel, "shared", "sentinel", 26); // backfilled copy
    insertRun(w.tel, "new", "sentinel", 1);
    const parts = await historyParts(w.env, "agent_runs");
    expect(parts.map((p) => p.source)).toEqual(["telemetry", "core"]);
    const latest = await getLatestRun(w.env, "sentinel");
    expect(latest?.id).toBe("new");
    const list = await listRunsForAgent(w.env, "sentinel", 10);
    expect(list.map((r) => r.id)).toEqual(["new", "shared", "old"]);
    const top2 = await listRunsForAgent(w.env, "sentinel", 2);
    expect(top2.map((r) => r.id)).toEqual(["new", "shared"]);
  });

  it("a finalized duplicate wins over a stale open copy", async () => {
    const w = world("telemetry");
    insertRun(w.tel, "r1", "analyst", 2, "partial", false);
    insertRun(w.core, "r1", "analyst", 2, "success", true);
    const rows = await unionRows<{ id: string; status: string; completed_at: string | null; started_at: string }>(
      await historyParts(w.env, "agent_runs"),
      () => ({ sql: "SELECT id, status, completed_at, started_at FROM agent_runs WHERE agent_id = 'analyst'", binds: [] }),
      { key: (r) => r.id, prefer: (a, b) => (a.completed_at === null && b.completed_at !== null ? b : a) },
    );
    expect(rows).toEqual([expect.objectContaining({ id: "r1", status: "success" })]);
  });

  it("aggregates never double-count backfilled rows (split from the backfill cursor)", async () => {
    const w = world("telemetry");
    for (let i = 0; i < 6; i++) insertRun(w.core, `c${i}`, "sentinel", 30 + i); // history, copyable
    insertRun(w.core, "c_recent", "sentinel", 2); // inside the 24 h horizon → stays core-only
    insertRun(w.tel, "t1", "sentinel", 1);
    const count = async (): Promise<number> => {
      const [row] = await unionGrouped<{ agent_id: string; n: number }>(
        await historyParts(w.env, "agent_runs"),
        () => ({ sql: "SELECT agent_id, COUNT(*) AS n FROM agent_runs WHERE agent_id = 'sentinel'/*split*/ GROUP BY agent_id", binds: [] }),
        { groupBy: ["agent_id"], sum: ["n"] },
      );
      return row?.n ?? 0;
    };
    expect(await count()).toBe(8);
    // Copy part of the history, then all of it: the total never changes.
    await backfillTelemetryHistory(w.env, { table: "agent_runs", days: 30, dryRun: false }, { pauseMs: 0, maxRows: 3, chunkRows: 2 });
    resetBackfillCursorCache();
    expect(rowsOf(w.tel, "SELECT COUNT(*) AS n FROM agent_runs")[0]!.n).toBe(4);
    expect(await count()).toBe(8);
    let guard = 0;
    while (!(await backfillTelemetryHistory(w.env, { table: "agent_runs", days: 30, dryRun: false }, { pauseMs: 0, maxRows: 3, chunkRows: 2 })).done && guard++ < 10) {
      resetBackfillCursorCache();
    }
    resetBackfillCursorCache();
    // days=30 window: c0..c5 are 30-35 h old → all inside [now-30d, now-24h).
    expect(rowsOf(w.tel, "SELECT COUNT(*) AS n FROM agent_runs")[0]!.n).toBe(7);
    expect(await count()).toBe(8);
  });

  it("applySplit splices the split binds at the marker position", () => {
    const q = applySplit(
      { split: " AND x <= ?", splitBinds: [9] },
      { sql: "SELECT 1 FROM t WHERE a = ? AND b = '?'/*split*/ AND c = ? LIMIT ?", binds: [1, 2, 3] },
    );
    expect(q.sql).toBe("SELECT 1 FROM t WHERE a = ? AND b = '?' AND x <= ? AND c = ? LIMIT ?");
    expect(q.binds).toEqual([1, 9, 2, 3]);
  });

  it("mergeGroupedRows keeps SQL semantics (SUM of NULLs, weighted AVG, MAX)", () => {
    const merged = mergeGroupedRows<{ k: string; n: number; s: number | null; a: number | null; w: number; m: string | null }>(
      [
        [{ k: "x", n: 2, s: null, a: 10, w: 2, m: "2026-01-01" }],
        [{ k: "x", n: 1, s: null, a: 40, w: 1, m: "2026-02-01" }, { k: "y", n: 1, s: 5, a: null, w: 0, m: null }],
      ],
      { groupBy: ["k"], sum: ["n", "s", "w"], max: ["m"], avg: [{ col: "a", weight: "w" }] },
    );
    expect(merged).toEqual([
      { k: "x", n: 3, s: null, a: 20, w: 3, m: "2026-02-01" },
      { k: "y", n: 1, s: 5, a: null, w: 0, m: null },
    ]);
    expect(byDesc<{ t: string }>("t")({ t: "a" }, { t: "b" })).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasSqlite())("Flight Control + reaper see both DBs", () => {
  it("getAgentHealth takes the newest run from either DB and tags its DB", async () => {
    const w = world("telemetry");
    insertRun(w.core, "s-old", "sentinel", 3);
    insertRun(w.tel, "s-new", "sentinel", 0.5);
    insertRun(w.core, "a-core", "analyst", 0.5);
    const health = await getAgentHealth(w.env.DB, w.kv, w.env);
    const sentinel = health.find((h) => h.agent_id === "sentinel")!;
    const analyst = health.find((h) => h.agent_id === "analyst")!;
    expect(sentinel.last_run_at).toBe(rowsOf(w.tel, "SELECT started_at FROM agent_runs WHERE id = 's-new'")[0]!.started_at);
    expect(sentinel.last_run_route).toBe("telemetry");
    expect(analyst.last_run_route).toBe("core");
    expect(analyst.is_stalled).toBe(false);
  });

  it("the orphan reaper sweeps core and telemetry", async () => {
    const w = world("telemetry");
    insertRun(w.core, "orphan-core", "sentinel", 5, "partial", false);
    insertRun(w.tel, "orphan-tel", "sentinel", 5, "running", false);
    insertRun(w.tel, "alive", "sentinel", 0.1, "running", false);
    expect(await reapOrphanAgentRuns(w.env)).toBe(2);
    expect(rowsOf(w.core, "SELECT status FROM agent_runs WHERE id = 'orphan-core'")[0]!.status).toBe("failed");
    expect(rowsOf(w.tel, "SELECT status FROM agent_runs WHERE id = 'orphan-tel'")[0]!.status).toBe("failed");
    expect(rowsOf(w.tel, "SELECT status FROM agent_runs WHERE id = 'alive'")[0]!.status).toBe("running");
  });
});

describe.skipIf(!hasSqlite())("agent_events consumer claims on the event's own DB", () => {
  it("drains a core event still pending at the flip and a telemetry event, each on its DB", async () => {
    const w = world("telemetry");
    const ins = "INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status, created_at) VALUES (?, 'feed_pulled', 'sentinel', NULL, '{}', 2, 'pending', ?)";
    w.core.prepare(ins).run("ev-core", sqliteTimestampHoursAgo(0.2));
    w.tel.prepare(ins).run("ev-tel", sqliteTimestampHoursAgo(0.1));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
    await processAgentEvents(w.env, ctx);
    await Promise.all(waits);
    expect(rowsOf(w.core, "SELECT id, status FROM agent_events")).toEqual([{ id: "ev-core", status: "done" }]);
    expect(rowsOf(w.tel, "SELECT id, status FROM agent_events ORDER BY id")).toEqual([{ id: "ev-tel", status: "done" }]);
    // The consumer's own activity row went to the routed store.
    expect(rowsOf(w.tel, "SELECT COUNT(*) AS n FROM agent_activity_log")[0]!.n).toBeGreaterThan(0);
    expect(rowsOf(w.core, "SELECT COUNT(*) AS n FROM agent_activity_log")[0]!.n).toBe(0);
  });
});

describe.skipIf(!hasSqlite())("cut-over tools", () => {
  it("copy-config is idempotent and never overwrites a telemetry row", async () => {
    const w = world(null);
    w.core.prepare("INSERT INTO agent_configs (agent_id, enabled, consecutive_failures) VALUES ('a', 0, 4), ('b', 1, 0)").run();
    w.core.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('a', 'approved', '2026-01-01'), ('b', 'pending', '2026-01-02')").run();
    w.tel.prepare("INSERT INTO agent_configs (agent_id, enabled, consecutive_failures) VALUES ('b', 1, 2)").run();

    const dry = await copyTelemetryConfig(w.env, { dryRun: true });
    expect(dry.tables.map((t) => [t.table, t.missing_on_target, t.inserted])).toEqual([["agent_configs", 1, 0], ["agent_approvals", 2, 0]]);
    expect(rowsOf(w.tel, "SELECT COUNT(*) AS n FROM agent_approvals")[0]!.n).toBe(0);

    const applied = await copyTelemetryConfig(w.env, { dryRun: false });
    expect(applied.tables.map((t) => [t.table, t.inserted])).toEqual([["agent_configs", 1], ["agent_approvals", 2]]);
    expect(rowsOf(w.tel, "SELECT agent_id, enabled, consecutive_failures FROM agent_configs ORDER BY agent_id")).toEqual([
      { agent_id: "a", enabled: 0, consecutive_failures: 4 },
      { agent_id: "b", enabled: 1, consecutive_failures: 2 }, // telemetry's own row kept
    ]);
    const again = await copyTelemetryConfig(w.env, { dryRun: false });
    expect(again.tables.every((t) => t.inserted === 0 && t.missing_on_target === 0)).toBe(true);
  });

  it("backfill: dry run writes nothing; apply is resumable and idempotent; recent rows are never copied", async () => {
    const w = world(null);
    for (let i = 0; i < 5; i++) {
      w.core.prepare("INSERT INTO agent_activity_log (id, agent_id, event_type, created_at) VALUES (?, 'nexus', 'batch_complete', ?)")
        .run(`act${i}`, sqliteTimestampHoursAgo(48 + i));
    }
    w.core.prepare("INSERT INTO agent_activity_log (id, agent_id, event_type, created_at) VALUES ('fresh', 'nexus', 'started', ?)").run(sqliteTimestampHoursAgo(1));
    const params = { table: "agent_activity_log" as const, days: 7, dryRun: true };
    const dry = await backfillTelemetryHistory(w.env, params, { pauseMs: 0 });
    expect(dry).toMatchObject({ dry_run: true, scanned: 5, inserted: 0, done: false });
    expect(rowsOf(w.tel, "SELECT COUNT(*) AS n FROM agent_activity_log")[0]!.n).toBe(0);

    const first = await backfillTelemetryHistory(w.env, { ...params, dryRun: false }, { pauseMs: 0, maxRows: 2, chunkRows: 2 });
    expect(first).toMatchObject({ scanned: 2, inserted: 2, done: false });
    let r = first;
    while (!r.done) r = await backfillTelemetryHistory(w.env, { ...params, dryRun: false }, { pauseMs: 0, maxRows: 2, chunkRows: 2 });
    expect(rowsOf(w.tel, "SELECT id FROM agent_activity_log ORDER BY id").map((x) => x.id)).toEqual(["act0", "act1", "act2", "act3", "act4"]);
    const after = await backfillTelemetryHistory(w.env, { ...params, dryRun: false }, { pauseMs: 0 });
    expect(after).toMatchObject({ done: true, inserted: 0, copied_total: 5 });
  });

  it("preflight blocks until config rows are copied, then passes", async () => {
    const w = world(null);
    w.core.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('a', 'approved', '2026-01-01')").run();
    const before = await telemetryPreflight(w.env);
    expect(before.ok).toBe(false);
    expect(before.blocking.join(" ")).toMatch(/agent_approvals: 1 core row/);
    expect(before.tables.every((t) => t.on_telemetry && t.columns_match)).toBe(true);
    await copyTelemetryConfig(w.env, { dryRun: false });
    const after = await telemetryPreflight(w.env);
    expect(after.blocking).toEqual([]);
    expect(after.ok).toBe(true);
  });

  it("preflight blocks when TELEMETRY_DB is not bound", async () => {
    const w = world(null);
    const env = { DB: w.env.DB, CACHE: w.kv } as unknown as Env;
    const r = await telemetryPreflight(env);
    expect(r.ok).toBe(false);
    expect(r.blocking).toEqual(["TELEMETRY_DB is not bound in this environment"]);
  });

  it("COPY_COLUMNS are exactly the telemetry schema's columns", () => {
    const tel = openTelemetryDb();
    for (const [table, cols] of Object.entries(COPY_COLUMNS)) {
      const actual = (tel.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(actual, table).toEqual([...cols]);
    }
  });
});

describe.skipIf(!hasSqlite())("review fixes (H1 / M1 / M2)", () => {
  it("H1: the backfill chunk seeks by rowid on every history table, with and without ANALYZE", () => {
    const db = openMigratedDb();
    const seed: Record<string, string> = {
      agent_runs: "INSERT INTO agent_runs (id, agent_id, started_at, status) VALUES (?, 'a', ?, 'success')",
      agent_events: "INSERT INTO agent_events (id, event_type, source_agent, created_at) VALUES (?, 'pivot_detected', 'nexus', ?)",
      agent_activity_log: "INSERT INTO agent_activity_log (id, agent_id, event_type, created_at) VALUES (?, 'nexus', 'started', ?)",
    };
    for (const [table, sql] of Object.entries(seed)) {
      for (let i = 0; i < 300; i++) db.prepare(sql).run(`${table}-${i}`, sqliteTimestampHoursAgo(i));
    }
    const planFor = (table: "agent_runs" | "agent_events" | "agent_activity_log"): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${backfillSelectSql(table)}`).all(10, "2000-01-01", "2100-01-01", 100) as Array<{ detail: string }>)
        .map((r) => r.detail).join(" | ");
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec("ANALYZE");
      for (const table of ["agent_runs", "agent_events", "agent_activity_log"] as const) {
        const plan = planFor(table);
        expect(plan, `${table} analyzed=${analyzed}`).toMatch(/SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid>\?\)/);
        expect(plan, `${table} analyzed=${analyzed}`).not.toMatch(/TEMP B-TREE|USING (COVERING )?INDEX/);
      }
    }
  });

  it("M1: reconcile overwrites differing rows when the source is newer; force overrides; dry run reports diffs", async () => {
    const w = world(null);
    w.core.prepare("INSERT INTO agent_configs (agent_id, enabled, paused_reason, updated_at) VALUES ('p', 0, 'manual', '2026-11-22 10:00:00'), ('q', 0, 'manual', '2026-11-22 09:00:00')").run();
    // p: telemetry stale (older); q: telemetry default seeded later (newer).
    w.tel.prepare("INSERT INTO agent_configs (agent_id, enabled, updated_at) VALUES ('p', 1, '2026-11-22 08:00:00'), ('q', 1, '2026-11-22 11:00:00')").run();
    const dry = await copyTelemetryConfig(w.env, { dryRun: true, mode: "reconcile" });
    const cfg = dry.tables.find((t) => t.table === "agent_configs")!;
    expect(cfg.differing).toBe(2);
    expect(cfg.diffs.find((d) => d.agent_id === "p")).toMatchObject({ action: "update", changed: { enabled: { target: 1, source: 0 } } });
    expect(cfg.diffs.find((d) => d.agent_id === "q")!.action).toBe("skip_target_newer");
    expect(rowsOf(w.tel, "SELECT enabled FROM agent_configs WHERE agent_id = 'p'")[0]!.enabled).toBe(1);

    const applied = await copyTelemetryConfig(w.env, { dryRun: false, mode: "reconcile" });
    expect(applied.tables.find((t) => t.table === "agent_configs")).toMatchObject({ updated: 1, skipped_target_newer: 1 });
    expect(rowsOf(w.tel, "SELECT agent_id, enabled FROM agent_configs ORDER BY agent_id")).toEqual([
      { agent_id: "p", enabled: 0 }, { agent_id: "q", enabled: 1 },
    ]);
    await copyTelemetryConfig(w.env, { dryRun: false, mode: "reconcile", force: true });
    expect(rowsOf(w.tel, "SELECT enabled, paused_reason FROM agent_configs WHERE agent_id = 'q'")[0]).toEqual({ enabled: 0, paused_reason: "manual" });
  });

  it("M1: direction=to_core reconciles telemetry's changes back to core", async () => {
    const w = world(null);
    w.core.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at, updated_at) VALUES ('n', 'pending', '2026-01-01', '2026-11-01 00:00:00')").run();
    w.tel.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at, updated_at) VALUES ('n', 'approved', '2026-01-01', '2026-11-20 00:00:00')").run();
    const r = await copyTelemetryConfig(w.env, { dryRun: false, mode: "reconcile", direction: "to_core" });
    expect(r.tables.find((t) => t.table === "agent_approvals")!.updated).toBe(1);
    expect(rowsOf(w.core, "SELECT state FROM agent_approvals WHERE agent_id = 'n'")[0]!.state).toBe("approved");
  });

  it("M1: preflight blocks on a content mismatch (pause state), not only on missing rows", async () => {
    const w = world(null);
    w.core.prepare("INSERT INTO agent_configs (agent_id, enabled, paused_reason) VALUES ('p', 0, 'manual')").run();
    w.tel.prepare("INSERT INTO agent_configs (agent_id, enabled) VALUES ('p', 1)").run();
    const r = await telemetryPreflight(w.env);
    expect(r.ok).toBe(false);
    expect(r.blocking.join(" ")).toMatch(/agent_configs: 1 row\(s\) differ from core/);
    expect(r.config.find((c) => c.table === "agent_configs")!.content_mismatch[0]).toMatchObject({ agent_id: "p" });
    await copyTelemetryConfig(w.env, { dryRun: false, mode: "reconcile", force: true });
    expect((await telemetryPreflight(w.env)).ok).toBe(true);
  });

  it("M1: a flip before copy-config cannot reset a manual pause or block an approved agent", async () => {
    const w = world("telemetry");
    w.core.prepare("INSERT INTO agent_configs (agent_id, enabled, paused_reason) VALUES ('b1c_paused', 0, 'manual')").run();
    w.core.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('b1c_paused', 'approved', '2026-01-01'), ('b1c_ok', 'approved', '2026-01-01')").run();
    const mod = (name: string) => ({
      name, displayName: name, description: "t", color: "#000", trigger: "manual", stallThresholdMinutes: 30,
      async execute() { return { itemsProcessed: 1, itemsCreated: 0, itemsUpdated: 0, output: {} }; },
    }) as unknown as AgentModule;
    const paused = await executeAgent(w.env, mod("b1c_paused"), {}, null, "manual");
    expect(paused.status).toBe("circuit_open");
    expect(rowsOf(w.tel, "SELECT enabled, paused_reason FROM agent_configs WHERE agent_id = 'b1c_paused'")[0]).toEqual({ enabled: 0, paused_reason: "manual" });
    const ok = await executeAgent(w.env, mod("b1c_ok"), {}, null, "manual");
    expect(ok.status).toBe("success");
    expect(rowsOf(w.tel, "SELECT state FROM agent_approvals WHERE agent_id = 'b1c_ok'")[0]!.state).toBe("approved");
  });

  it("M2: after the route was ever 'telemetry', a flip back to core still reads (and consumes from) both DBs", async () => {
    const w = world("telemetry");
    await historyParts(w.env, "agent_runs"); // resolves 'telemetry' → durable marker
    expect(w.kv.store.has(TELEMETRY_USED_KV_KEY)).toBe(true);
    insertRun(w.tel, "on-tel", "sentinel", 0.2);
    insertRun(w.core, "on-core", "sentinel", 1);
    w.tel.prepare("INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status, created_at) VALUES ('ev', 'feed_pulled', 'sentinel', NULL, '{}', 2, 'pending', ?)")
      .run(sqliteTimestampHoursAgo(0.1));
    w.route("core"); // flip back (also clears the in-isolate marker cache)
    expect((await historyParts(w.env, "agent_runs")).map((p) => p.source)).toEqual(["telemetry", "core"]);
    expect((await getLatestRun(w.env, "sentinel"))?.id).toBe("on-tel");
    const waits: Promise<unknown>[] = [];
    await processAgentEvents(w.env, { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext);
    await Promise.all(waits);
    expect(rowsOf(w.tel, "SELECT status FROM agent_events WHERE id = 'ev'")[0]!.status).toBe("done");
    // New writes go to core again.
    const run = await createAgentRun(w.env, "daily_snapshots");
    expect(run.route).toBe("core");
  });

  it("M2: without the marker, route core stays a single core read", async () => {
    const w = world(null);
    expect(w.kv.store.has(TELEMETRY_USED_KV_KEY)).toBe(false);
    expect(await historyParts(w.env, "agent_runs")).toHaveLength(1);
  });
});
