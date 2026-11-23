/**
 * Track B1 wave 2 — agent_outputs on TELEMETRY_DB as part of the AGENTS
 * family (flag `db_route:telemetry`, same 'used' marker).
 *
 * Two real SQLite databases stand in for core (every migrations/ file) and
 * TELEMETRY_DB (every migrations-telemetry/ file). Pins, per category:
 *   Writers  1. executeAgent persists result.agentOutputs on the DB the run
 *              resolved at start (even across a mid-run flip) and hands that
 *              route to the agent (ctx.telemetryRoute).
 *            2. A standalone write (feed diagnostic, feed insight) goes to the
 *              routed store at call time.
 *   Readers  3. Row lists read telemetry ∪ core, dedupe a backfilled copy by
 *              id, re-sort and re-limit (agents API, review bundle).
 *            4. Read-before-write dedupes see a row on either DB (Observer
 *              weekly check, EPSS digest guard).
 *            5. Aggregates merge per-part partials: Flight Control's AI-outage
 *              thresholds apply to the MERGED sums (no per-DB HAVING); a
 *              backfilled row never counts twice (split).
 *   Tooling  6. Backfill copies agent_outputs (rowid seek), preflight checks
 *              its schema and reports its history.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";
import type { Env } from "../src/types";
import type { AgentContext, AgentModule } from "../src/lib/agentRunner";
import { executeAgent } from "../src/lib/agentRunner";
import { FAMILY_TABLES, resetTelemetryRouteCache, TELEMETRY_ROUTE_KV_KEY } from "../src/lib/db-route";
import { historyParts, resetBackfillCursorCache, TELEMETRY_HISTORY_TABLES } from "../src/lib/telemetry-read";
import { backfillSelectSql, backfillTelemetryHistory, COPY_COLUMNS, telemetryPreflight } from "../src/lib/telemetry-cutover";
import { agentOutputsDbForRun, agentOutputsStore } from "../src/db/agent-outputs";
import { logFeedDiagnostic } from "../src/lib/feedDiagnostic";
import { handleAgentOutputs, handleAgentOutputsByName } from "../src/handlers/agents";
import { getReviewBundle } from "../src/lib/agent-approvals";
import { observerWeeklyExists } from "../src/agents/observer";
import { readAiFailingAgents } from "../src/agents/flightControl";
import { epss } from "../src/feeds/epss";

function openTelemetryDb(): SqliteDb {
  const nodeRequire = createRequire(import.meta.url);
  const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
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

let coreTemplate: SqliteDb | null = null;

function world(route: "core" | "telemetry" | null = "telemetry"): World {
  coreTemplate ??= openMigratedDb();
  const core = coreTemplate;
  for (const t of ["agent_runs", "agent_configs", "agent_events", "agent_activity_log", "agent_approvals", "agent_outputs"]) core.exec(`DELETE FROM ${t}`);
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
const outputIds = (db: SqliteDb) => rowsOf(db, "SELECT id FROM agent_outputs ORDER BY id").map((r) => r.id);

function insertOutput(
  db: SqliteDb,
  id: string,
  agent: string,
  hoursAgo: number,
  opts: { type?: string; summary?: string; severity?: string | null; details?: unknown } = {},
): void {
  db.prepare(
    `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, agent, opts.type ?? "diagnostic", opts.summary ?? `summary ${id}`, opts.severity ?? null,
    opts.details === undefined ? null : JSON.stringify(opts.details), sqliteTimestampHoursAgo(hoursAgo),
  );
}

const probeModule = (name: string, body: (ctx: AgentContext) => void, outputs = 2): AgentModule => ({
  name,
  displayName: "probe",
  description: "test",
  color: "#000",
  trigger: "manual",
  stallThresholdMinutes: 30,
  async execute(ctx: AgentContext) {
    body(ctx);
    return {
      itemsProcessed: 1, itemsCreated: 0, itemsUpdated: 0, output: {},
      agentOutputs: Array.from({ length: outputs }, (_, i) => ({ type: "diagnostic" as const, summary: `out ${i}`, severity: "info" as const })),
    };
  },
} as unknown as AgentModule);

beforeEach(() => {
  resetTelemetryRouteCache();
  resetBackfillCursorCache();
});

describe("agent_outputs is an agents-family history table", () => {
  it("is in FAMILY_TABLES.agents and the agents history set (batch isolation + backfill + preflight follow from it)", () => {
    expect(FAMILY_TABLES.agents).toContain("agent_outputs");
    expect(TELEMETRY_HISTORY_TABLES).toContain("agent_outputs");
  });
});

describe.skipIf(!hasSqlite())("writers go forward", () => {
  it("executeAgent persists outputs on the run's DB even after a mid-run flip, and passes the route to the agent", async () => {
    const w = world("telemetry");
    w.tel.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('w2_probe', 'approved', datetime('now'))").run();
    let seen: string | undefined;
    const res = await executeAgent(w.env, probeModule("w2_probe", (ctx) => { seen = ctx.telemetryRoute; w.route("core"); }), {}, null, "manual");
    expect(res.status).toBe("success");
    expect(seen).toBe("telemetry");
    expect(outputIds(w.core)).toEqual([]);
    expect(rowsOf(w.tel, "SELECT agent_id, summary FROM agent_outputs ORDER BY summary")).toEqual([
      { agent_id: "w2_probe", summary: "out 0" },
      { agent_id: "w2_probe", summary: "out 1" },
    ]);
    expect(rowsOf(w.tel, "SELECT outputs_generated FROM agent_runs")[0]).toEqual({ outputs_generated: 2 });
  });

  it("route core (flag unset): executeAgent keeps writing outputs on core, exactly as before", async () => {
    const w = world(null);
    w.core.prepare("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('w2_core', 'approved', datetime('now'))").run();
    let seen: string | undefined;
    await executeAgent(w.env, probeModule("w2_core", (ctx) => { seen = ctx.telemetryRoute; }, 1), {}, null, "manual");
    expect(seen).toBe("core");
    expect(rowsOf(w.core, "SELECT agent_id FROM agent_outputs")).toEqual([{ agent_id: "w2_core" }]);
    expect(outputIds(w.tel)).toEqual([]);
  });

  it("agentOutputsDbForRun uses the carried route; without one it resolves now", async () => {
    const w = world("core");
    expect(await agentOutputsDbForRun(w.env, "telemetry")).toBe(w.env.TELEMETRY_DB);
    expect(await agentOutputsDbForRun(w.env, undefined)).toBe(w.env.DB);
    w.route("telemetry");
    expect(await agentOutputsDbForRun(w.env, null)).toBe(w.env.TELEMETRY_DB);
    expect(await agentOutputsStore(w.env)).toBe(w.env.TELEMETRY_DB);
  });

  it("a standalone feed diagnostic lands on the routed store", async () => {
    const w = world("telemetry");
    await logFeedDiagnostic(w.env, { feedName: "f", url: "https://x", method: "GET", httpStatus: 200, bodyPreview: "", errorMessage: null });
    expect(rowsOf(w.tel, "SELECT agent_id, type FROM agent_outputs")).toEqual([{ agent_id: "feed_diagnostics", type: "diagnostic" }]);
    expect(outputIds(w.core)).toEqual([]);
  });

  it("a write carrying a core campaign id is accepted on telemetry (no FK to campaigns there)", async () => {
    const w = world("telemetry");
    const db = await agentOutputsStore(w.env);
    await db.prepare(
      "INSERT INTO agent_outputs (id, agent_id, type, summary, related_campaign_id) VALUES ('c1', 'strategist', 'insight', 's', 'camp_core_only')",
    ).run();
    expect(outputIds(w.tel)).toEqual(["c1"]);
  });
});

describe.skipIf(!hasSqlite())("row readers read the union", () => {
  it("route core, telemetry never used: one core part (today's single read)", async () => {
    const w = world(null);
    const parts = await historyParts(w.env, "agent_outputs");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ source: "core", split: "" });
  });

  it("GET /api/agents/:name/outputs merges both DBs, dedupes a backfilled copy and re-limits", async () => {
    const w = world("telemetry");
    insertOutput(w.core, "o_old", "sentinel", 30);
    insertOutput(w.core, "o_shared", "sentinel", 26);
    insertOutput(w.tel, "o_shared", "sentinel", 26); // backfilled copy
    insertOutput(w.tel, "o_new", "sentinel", 1);
    insertOutput(w.tel, "o_other", "analyst", 1);
    const all = await (await handleAgentOutputsByName(new Request("https://x/api/agents/sentinel/outputs?limit=10"), w.env, "sentinel")).json() as { data: Array<{ id: string }> };
    expect(all.data.map((r) => r.id)).toEqual(["o_new", "o_shared", "o_old"]);
    const top2 = await (await handleAgentOutputsByName(new Request("https://x/api/agents/sentinel/outputs?limit=2"), w.env, "sentinel")).json() as { data: Array<{ id: string }> };
    expect(top2.data.map((r) => r.id)).toEqual(["o_new", "o_shared"]);
  });

  it("GET /api/agents/outputs keeps its filters on both parts", async () => {
    const w = world("telemetry");
    insertOutput(w.core, "i_core", "observer", 5, { type: "insight" });
    insertOutput(w.tel, "i_tel", "observer", 1, { type: "insight" });
    insertOutput(w.tel, "d_tel", "observer", 1, { type: "diagnostic" });
    const res = await (await handleAgentOutputs(new Request("https://x/api/agents/outputs?type=insight&limit=5"), w.env)).json() as { data: Array<{ id: string }> };
    expect(res.data.map((r) => r.id)).toEqual(["i_tel", "i_core"]);
  });

  it("the approval review bundle shows recent outputs from both DBs", async () => {
    const w = world("telemetry");
    insertOutput(w.core, "r_core", "nexus", 3);
    insertOutput(w.tel, "r_tel", "nexus", 1);
    const bundle = await getReviewBundle(w.env.DB, "nexus", w.env);
    expect(bundle.recent_outputs.map((r) => r.id)).toEqual(["r_tel", "r_core"]);
  });

  it("after a flip back to core the 'used' marker keeps reading telemetry's rows", async () => {
    const w = world("telemetry");
    await historyParts(w.env, "agent_outputs"); // resolving 'telemetry' writes the marker
    insertOutput(w.tel, "t_only", "sentinel", 1);
    w.route("core");
    const parts = await historyParts(w.env, "agent_outputs");
    expect(parts.map((p) => p.source)).toEqual(["telemetry", "core"]);
    const res = await (await handleAgentOutputsByName(new Request("https://x/api/agents/sentinel/outputs"), w.env, "sentinel")).json() as { data: Array<{ id: string }> };
    expect(res.data.map((r) => r.id)).toEqual(["t_only"]);
  });
});

describe.skipIf(!hasSqlite())("read-before-write dedupes count a row on either DB", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Observer's weekly check finds last week's row on core while the route is telemetry (and vice versa)", async () => {
    const w = world("telemetry");
    expect(await observerWeeklyExists(w.env)).toBe(false);
    insertOutput(w.core, "wk_core", "observer", 30, { type: "trend_report" });
    expect(await observerWeeklyExists(w.env)).toBe(true);
    w.core.exec("DELETE FROM agent_outputs");
    insertOutput(w.tel, "wk_tel", "observer", 30, { type: "insight", details: { type: "weekly_intel" } });
    expect(await observerWeeklyExists(w.env)).toBe(true);
  });

  it("EPSS skips a scoring date already stored on core after the flip, and writes a new one to telemetry", async () => {
    const w = world("telemetry");
    insertOutput(w.core, "epss_old", "sentinel", 3, { type: "insight", summary: "EPSS Update (2026-11-22): top 1 CVEs" });
    const body = (date: string) => JSON.stringify({ status: "OK", data: [{ cve: "CVE-1", epss: "0.9", percentile: "0.99", date }] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body("2026-11-22"), { status: 200 })));
    const same = await epss.ingest({ env: w.env, feedName: "epss", feedUrl: "" });
    expect(same.itemsNew).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body("2026-11-23"), { status: 200 })));
    const fresh = await epss.ingest({ env: w.env, feedName: "epss", feedUrl: "" });
    expect(fresh.itemsNew).toBe(1);
    expect(rowsOf(w.tel, "SELECT agent_id FROM agent_outputs WHERE summary LIKE 'EPSS%'")).toEqual([{ agent_id: "sentinel" }]);
    expect(rowsOf(w.core, "SELECT id FROM agent_outputs WHERE summary LIKE 'EPSS%'")).toEqual([{ id: "epss_old" }]);
  });
});

describe.skipIf(!hasSqlite())("aggregates merge per-part partials", () => {
  const ai = (attempted: number, succeeded: number, error?: string) => ({
    aiCallsAttempted: attempted, aiCallsSucceeded: succeeded,
    ...(error ? { aiFirstFailureKind: "api_error", aiFirstError: error } : {}),
  });

  it("FC's AI-outage check applies the thresholds to the merged sums, not per DB", async () => {
    const w = world("telemetry");
    // narrator: 2 attempts on core + 2 on telemetry, 0 successes → 4 ≥ 3 → failing
    insertOutput(w.core, "n1", "narrator", 1.5, { details: ai(2, 0, "HTTP 400 old") });
    insertOutput(w.tel, "n2", "narrator", 0.5, { details: ai(2, 0, "HTTP 400 new") });
    // observer: failing on core, but a success on telemetry → not failing
    insertOutput(w.core, "o1", "observer", 1.5, { details: ai(3, 0, "HTTP 400") });
    insertOutput(w.tel, "o2", "observer", 0.5, { details: ai(1, 1) });
    // analyst: 2 attempts only → under the floor
    insertOutput(w.tel, "a1", "analyst", 0.5, { details: ai(2, 0, "x") });
    const failing = await readAiFailingAgents(w.env, w.env.DB, 2, 3);
    expect(failing.map((r) => [r.agent_id, r.attempted, r.succeeded])).toEqual([["narrator", 4, 0]]);
    // The newest failure across both DBs wins (created_at-prefixed MAX).
    expect(failing[0]!.newest_failure).toContain("HTTP 400 new");
  });

  it("route core: the single-part path keeps the old result", async () => {
    const w = world(null);
    insertOutput(w.core, "n1", "narrator", 0.5, { details: ai(4, 0, "boom") });
    insertOutput(w.core, "s1", "strategist", 0.5, { details: ai(5, 1) });
    const failing = await readAiFailingAgents(w.env, w.env.DB, 2, 3);
    expect(failing.map((r) => r.agent_id)).toEqual(["narrator"]);
  });

  it("a backfilled row is never counted twice (split from the backfill cursor)", async () => {
    const w = world("telemetry");
    for (let i = 0; i < 4; i++) insertOutput(w.core, `h${i}`, "narrator", 30 + i, { details: ai(1, 0, "e") });
    const sum = async () => (await readAiFailingAgents(w.env, w.env.DB, 48, 1))[0]?.attempted ?? 0;
    expect(await sum()).toBe(4);
    let r = await backfillTelemetryHistory(w.env, { table: "agent_outputs", days: 7, dryRun: false }, { pauseMs: 0, maxRows: 2, chunkRows: 1 });
    resetBackfillCursorCache();
    expect(outputIds(w.tel)).toHaveLength(2);
    expect(await sum()).toBe(4);
    let guard = 0;
    while (!r.done && guard++ < 10) {
      r = await backfillTelemetryHistory(w.env, { table: "agent_outputs", days: 7, dryRun: false }, { pauseMs: 0, maxRows: 2, chunkRows: 1 });
      resetBackfillCursorCache();
    }
    expect(outputIds(w.tel)).toHaveLength(4);
    expect(await sum()).toBe(4);
  });
});

describe.skipIf(!hasSqlite())("cut-over tooling", () => {
  it("backfill copies finished agent_outputs rows only, resumable and idempotent", async () => {
    const w = world("telemetry");
    for (let i = 0; i < 3; i++) insertOutput(w.core, `b${i}`, "cartographer", 48 + i, { details: { n: i } });
    insertOutput(w.core, "fresh", "cartographer", 1);
    const dry = await backfillTelemetryHistory(w.env, { table: "agent_outputs", days: 7, dryRun: true }, { pauseMs: 0 });
    expect(dry).toMatchObject({ family: "agents", dry_run: true, scanned: 3, inserted: 0 });
    let r = await backfillTelemetryHistory(w.env, { table: "agent_outputs", days: 7, dryRun: false }, { pauseMs: 0, maxRows: 2, chunkRows: 2 });
    while (!r.done) r = await backfillTelemetryHistory(w.env, { table: "agent_outputs", days: 7, dryRun: false }, { pauseMs: 0, maxRows: 2, chunkRows: 2 });
    expect(outputIds(w.tel)).toEqual(["b0", "b1", "b2"]);
    expect(rowsOf(w.tel, "SELECT details FROM agent_outputs WHERE id = 'b1'")[0]).toEqual({ details: JSON.stringify({ n: 1 }) });
    const again = await backfillTelemetryHistory(w.env, { table: "agent_outputs", days: 7, dryRun: false }, { pauseMs: 0 });
    expect(again).toMatchObject({ done: true, inserted: 0, copied_total: 3 });
  });

  it("the backfill chunk seeks by rowid, with and without ANALYZE", () => {
    const db = openMigratedDb();
    for (let i = 0; i < 300; i++) insertOutput(db, `p${i}`, "a", i);
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec("ANALYZE");
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${backfillSelectSql("agent_outputs")}`).all(10, "2000-01-01", "2100-01-01", 100) as Array<{ detail: string }>)
        .map((x) => x.detail).join(" | ");
      expect(plan, `analyzed=${analyzed}`).toMatch(/SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid>\?\)/);
      expect(plan, `analyzed=${analyzed}`).not.toMatch(/TEMP B-TREE|USING (COVERING )?INDEX/);
    }
  });

  it("COPY_COLUMNS.agent_outputs is exactly the telemetry schema", () => {
    const tel = openTelemetryDb();
    const cols = (tel.prepare("SELECT name FROM pragma_table_info('agent_outputs') ORDER BY cid").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual([...COPY_COLUMNS.agent_outputs]);
  });

  it("agents preflight checks agent_outputs' schema and reports its history", async () => {
    const w = world(null);
    const pf = await telemetryPreflight(w.env, "agents");
    const t = pf.tables.find((x) => x.table === "agent_outputs");
    expect(t).toMatchObject({ on_telemetry: true, columns_match: true, missing_indexes: [] });
    expect(pf.history.map((h) => h.table)).toContain("agent_outputs");
    expect(pf.ok).toBe(true);
  });
});
