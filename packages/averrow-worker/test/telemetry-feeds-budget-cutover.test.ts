/**
 * Track B1d — the FEEDS and BUDGET families on TELEMETRY_DB, each on its own
 * route flag (lib/db-route.ts), mirroring B1c's agent-runs family.
 *
 * Two real SQLite databases stand in for core (every migrations/ file) and
 * TELEMETRY_DB (every migrations-telemetry/ file). Pins:
 *   1. Deploy safety: with db_route:telemetry = 'telemetry' (agents, live in
 *      prod) and the feeds / budget flags UNSET, feeds and budget stay on core
 *      — one core part, every write on core — while agents still read both.
 *   2. A feed pull resolves the feeds family once: its pull row, finalize,
 *      breaker penalty / reset land on the DB it started on, even when the
 *      flag flips mid-pull (both ways); FeedContext.feedsDb is that DB.
 *   3. The feed-pull reaper sweeps every bound DB and penalizes on each
 *      reaped row's DB.
 *   4. Budget: the ledger + rollup batch lands on one DB (resolved once);
 *      the throttle / per-agent reads SUM the month across both DBs; a
 *      backfilled ledger row is never counted twice.
 *   5. copy-config / reconcile / preflight / backfill for feeds + budget are
 *      idempotent; reconcile never un-pauses a feed without force; the rollup
 *      backfill copies closed months only and refuses a conflicting row.
 *   6. The route flip endpoint refuses a failing preflight (and a stale core
 *      on a flip back) and writes only the family's own flag.
 *   7. The new backfill chunks seek by rowid, with and without ANALYZE.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";
import type { Env } from "../src/types";
import type { FeedConfigRow } from "../src/lib/feedRunner";
import type { FeedContext, FeedModule } from "../src/feeds/types";
import {
  FAMILY_ROUTE_KV_KEYS,
  FAMILY_USED_KV_KEYS,
  TELEMETRY_ROUTE_KV_KEY,
  familyRouteState,
  resetTelemetryRouteCache,
  type TelemetryFamily,
} from "../src/lib/db-route";
import { historyParts, resetBackfillCursorCache, unionAggregateFirst } from "../src/lib/telemetry-read";
import { runFeed, applyReapPenalty, dispatchEnrichmentFeed } from "../src/lib/feedRunner";
import { reapOrphanFeedPullHistory } from "../src/lib/feed-pull-reaper";
import { BudgetManager } from "../src/lib/budgetManager";
import { checkCostGuard } from "../src/lib/ai-throttle";
import {
  backfillSelectSql,
  backfillTelemetryHistory,
  copyTelemetryConfig,
  parseBackfillParams,
  parseSetRouteParams,
  setTelemetryRoute,
  telemetryPreflight,
  telemetryRoutes,
  BackfillConflictError,
} from "../src/lib/telemetry-cutover";

const FEED_TABLES = ["feed_pull_history", "feed_status", "feed_configs"];
const BUDGET_TABLES = ["budget_ledger", "agent_budget_rollups", "budget_config"];

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
  route(family: TelemetryFamily, r: "core" | "telemetry" | null): void;
}

let coreTemplate: SqliteDb | null = null;

function world(routes: Partial<Record<TelemetryFamily, "core" | "telemetry">> = {}): World {
  coreTemplate ??= openMigratedDb();
  const core = coreTemplate;
  for (const t of [...FEED_TABLES, ...BUDGET_TABLES, "agent_runs", "agent_activity_log", "notifications"]) core.exec(`DELETE FROM ${t}`);
  const tel = openTelemetryDb();
  const kv = fakeKv();
  const env = { DB: d1FromSqlite(core), TELEMETRY_DB: d1FromSqlite(tel), CACHE: kv } as unknown as Env;
  const w: World = {
    core, tel, kv, env,
    route(family, r) {
      if (r === null) kv.store.delete(FAMILY_ROUTE_KV_KEYS[family]);
      else kv.store.set(FAMILY_ROUTE_KV_KEYS[family], r);
      resetTelemetryRouteCache();
    },
  };
  for (const [f, r] of Object.entries(routes)) w.route(f as TelemetryFamily, r);
  resetTelemetryRouteCache();
  return w;
}

const rowsOf = (db: SqliteDb, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Array<Record<string, unknown>>;
const countOf = (db: SqliteDb, table: string): number => Number(rowsOf(db, `SELECT COUNT(*) AS n FROM ${table}`)[0]!.n);

function seedFeed(db: SqliteDb, name: string, opts: { enabled?: number; paused_reason?: string | null; updated_at?: string; threshold?: number } = {}): void {
  db.prepare(
    `INSERT INTO feed_configs (feed_name, display_name, schedule_cron, enabled, paused_reason, updated_at, consecutive_failure_threshold)
     VALUES (?, ?, '0 * * * *', ?, ?, ?, ?)`,
  ).run(name, name, opts.enabled ?? 1, opts.paused_reason ?? null, opts.updated_at ?? "2026-11-20 00:00:00", opts.threshold ?? null);
}

const configOf = (name: string): FeedConfigRow => ({
  feed_name: name, display_name: name, source_url: null, schedule_cron: "0 * * * *",
  rate_limit: 0, batch_size: 0, retry_count: 0, enabled: 1,
});

function okModule(onIngest?: (ctx: FeedContext) => void | Promise<void>): FeedModule {
  return {
    async ingest(ctx) {
      await onIngest?.(ctx);
      return { itemsFetched: 2, itemsNew: 2, itemsDuplicate: 0, itemsError: 0 };
    },
  };
}

function failingModule(onIngest?: () => void): FeedModule {
  return {
    async ingest() {
      onIngest?.();
      throw new Error("upstream HTTP 503");
    },
  };
}

beforeEach(() => {
  resetTelemetryRouteCache();
  resetBackfillCursorCache();
});

describe.skipIf(!hasSqlite())("deploy safety: per-family flags default to core", () => {
  it("agents on telemetry (prod today) does NOT move feeds or budget", async () => {
    const w = world({ agents: "telemetry" });
    w.kv.store.set(FAMILY_USED_KV_KEYS.agents, "2026-11-22T20:00:00.000Z");
    expect((await familyRouteState(w.env, "agents")).route).toBe("telemetry");
    expect((await familyRouteState(w.env, "feeds")).route).toBe("core");
    expect((await familyRouteState(w.env, "budget")).route).toBe("core");
    // Agents read both DBs; feeds / budget read exactly one core part.
    expect(await historyParts(w.env, "agent_runs")).toHaveLength(2);
    for (const t of ["feed_pull_history", "budget_ledger", "agent_budget_rollups"] as const) {
      const parts = await historyParts(w.env, t);
      expect(parts, t).toHaveLength(1);
      expect(parts[0]).toMatchObject({ source: "core", split: "", splitBinds: [] });
    }
    // No feeds / budget 'used' marker is written while their flags are unset.
    expect(w.kv.store.has(FAMILY_USED_KV_KEYS.feeds)).toBe(false);
    expect(w.kv.store.has(FAMILY_USED_KV_KEYS.budget)).toBe(false);
  });

  it("with the feeds / budget flags unset every feed and AI-ledger write stays on core", async () => {
    const w = world({ agents: "telemetry" });
    seedFeed(w.core, "b1d_feed");
    let seen: D1Database | undefined;
    await runFeed(w.env, configOf("b1d_feed"), okModule((ctx) => { seen = ctx.feedsDb; }));
    expect(seen).toBe(w.env.DB);
    expect(countOf(w.core, "feed_pull_history")).toBe(1);
    expect(countOf(w.core, "feed_status")).toBe(1);
    expect(countOf(w.tel, "feed_pull_history")).toBe(0);

    await (await BudgetManager.forEnv(w.env)).recordCost("observer", null, "claude-haiku-4-5-20251001", 1000, 100);
    expect(countOf(w.core, "budget_ledger")).toBe(1);
    expect(countOf(w.core, "agent_budget_rollups")).toBe(1);
    expect(countOf(w.tel, "budget_ledger")).toBe(0);
  });

  it("the family flags are independent keys; the agents key is unchanged", () => {
    expect(FAMILY_ROUTE_KV_KEYS).toEqual({
      agents: TELEMETRY_ROUTE_KV_KEY,
      feeds: "db_route:telemetry:feeds",
      budget: "db_route:telemetry:budget",
    });
    expect(TELEMETRY_ROUTE_KV_KEY).toBe("db_route:telemetry");
    expect(FAMILY_USED_KV_KEYS.agents).toBe("db_route:telemetry_used");
  });
});

describe.skipIf(!hasSqlite())("a feed pull carries its DB (resolve once)", () => {
  it("started on telemetry, finalized + breaker reset on telemetry after a flip back to core", async () => {
    const w = world({ feeds: "telemetry" });
    seedFeed(w.tel, "b1d_feed");
    w.tel.prepare("INSERT INTO feed_status (feed_name, health_status, consecutive_failures, next_retry_at) VALUES ('b1d_feed', 'degraded', 2, '2000-01-01 00:00:00')").run();
    let seen: D1Database | undefined;
    await runFeed(w.env, configOf("b1d_feed"), okModule((ctx) => { seen = ctx.feedsDb; w.route("feeds", "core"); }));
    expect(seen).toBe(w.env.TELEMETRY_DB);
    expect(countOf(w.core, "feed_pull_history")).toBe(0);
    expect(countOf(w.core, "feed_status")).toBe(0);
    expect(rowsOf(w.tel, "SELECT status, records_ingested FROM feed_pull_history")[0]).toEqual({ status: "success", records_ingested: 2 });
    expect(rowsOf(w.tel, "SELECT consecutive_failures, next_retry_at FROM feed_status")[0]).toEqual({ consecutive_failures: 0, next_retry_at: null });
  });

  it("started on core, failed + penalized on core after a flip to telemetry", async () => {
    const w = world();
    seedFeed(w.core, "b1d_feed");
    seedFeed(w.tel, "b1d_feed");
    await expect(runFeed(w.env, configOf("b1d_feed"), failingModule(() => w.route("feeds", "telemetry")), { overloadBackoff: false }))
      .rejects.toThrow(/Feed b1d_feed failed/);
    expect(countOf(w.tel, "feed_pull_history")).toBe(0);
    expect(countOf(w.tel, "feed_status")).toBe(0);
    expect(rowsOf(w.core, "SELECT status FROM feed_pull_history")[0]!.status).toBe("failed");
    const st = rowsOf(w.core, "SELECT consecutive_failures, health_status, next_retry_at FROM feed_status")[0]!;
    expect(st).toMatchObject({ consecutive_failures: 1, health_status: "degraded" });
    expect(st.next_retry_at).not.toBeNull();
  });

  it("the auto-pause on the threshold lands on the pull's DB", async () => {
    const w = world({ feeds: "telemetry" });
    seedFeed(w.tel, "b1d_feed", { threshold: 1 });
    seedFeed(w.core, "b1d_feed", { threshold: 1 });
    const cfg = { ...configOf("b1d_feed"), consecutive_failure_threshold: 1 };
    await expect(runFeed(w.env, cfg, failingModule(), { overloadBackoff: false })).rejects.toThrow();
    expect(rowsOf(w.tel, "SELECT enabled, paused_reason FROM feed_configs WHERE feed_name = 'b1d_feed'")[0]).toEqual({ enabled: 0, paused_reason: "auto:consecutive_failures" });
    expect(rowsOf(w.core, "SELECT enabled FROM feed_configs WHERE feed_name = 'b1d_feed'")[0]!.enabled).toBe(1);
  });

  it("the dedicated-cron dispatcher gates and runs on the same (routed) DB", async () => {
    const w = world({ feeds: "telemetry" });
    seedFeed(w.tel, "greynoise");
    seedFeed(w.core, "greynoise", { enabled: 0, paused_reason: "manual" });
    let ran = false;
    await dispatchEnrichmentFeed(w.env, "greynoise", okModule(() => { ran = true; }));
    expect(ran).toBe(true);
    expect(countOf(w.tel, "feed_pull_history")).toBe(1);
    expect(countOf(w.core, "feed_pull_history")).toBe(0);
  });

  it("applyReapPenalty with an explicit DB penalizes there only", async () => {
    const w = world({ feeds: "telemetry" });
    seedFeed(w.core, "b1d_feed");
    seedFeed(w.tel, "b1d_feed");
    await applyReapPenalty(w.env, "b1d_feed", "reaped", w.env.DB);
    expect(rowsOf(w.core, "SELECT consecutive_failures FROM feed_status")[0]!.consecutive_failures).toBe(1);
    expect(countOf(w.tel, "feed_status")).toBe(0);
  });
});

describe.skipIf(!hasSqlite())("feed-pull reaper", () => {
  it("sweeps both DBs and penalizes each reaped feed on its own DB", async () => {
    const w = world({ feeds: "telemetry" });
    seedFeed(w.core, "on_core");
    seedFeed(w.tel, "on_tel");
    const stale = sqliteTimestampHoursAgo(1);
    w.core.prepare("INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES ('c1', 'on_core', ?, 'partial')").run(stale);
    w.tel.prepare("INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES ('t1', 'on_tel', ?, 'partial')").run(stale);
    expect(await reapOrphanFeedPullHistory(w.env)).toBe(2);
    expect(rowsOf(w.core, "SELECT status FROM feed_pull_history")[0]!.status).toBe("failed");
    expect(rowsOf(w.tel, "SELECT status FROM feed_pull_history")[0]!.status).toBe("failed");
    expect(rowsOf(w.core, "SELECT feed_name, consecutive_failures FROM feed_status")).toEqual([{ feed_name: "on_core", consecutive_failures: 1 }]);
    expect(rowsOf(w.tel, "SELECT feed_name, consecutive_failures FROM feed_status")).toEqual([{ feed_name: "on_tel", consecutive_failures: 1 }]);
  });
});

describe.skipIf(!hasSqlite())("budget family", () => {
  const month = new Date().toISOString().slice(0, 7);

  it("recordCost writes ledger + rollup as one batch on the DB resolved at start (flip after resolve)", async () => {
    const w = world({ budget: "telemetry" });
    const mgr = await BudgetManager.forEnv(w.env);
    w.route("budget", "core");
    await mgr.recordCost("observer", "run-1", "claude-haiku-4-5-20251001", 1000, 100);
    expect(countOf(w.tel, "budget_ledger")).toBe(1);
    expect(countOf(w.tel, "agent_budget_rollups")).toBe(1);
    expect(countOf(w.core, "budget_ledger")).toBe(0);
    expect(countOf(w.core, "agent_budget_rollups")).toBe(0);
  });

  it("the month's spend and per-agent tokens are summed across both DBs (pre-flip core + post-flip telemetry)", async () => {
    const w = world({ budget: "telemetry" });
    w.core.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month, total_input_tokens, total_output_tokens, total_cost_usd, call_count) VALUES ('observer', ?, 600, 100, 30, 3)").run(month);
    w.tel.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month, total_input_tokens, total_output_tokens, total_cost_usd, call_count) VALUES ('observer', ?, 200, 100, 50, 2)").run(month);
    w.tel.prepare("INSERT INTO budget_config (id, monthly_limit_usd, soft_pct, hard_pct, emergency_pct) VALUES (1, 80, 80, 95, 99)").run();
    const mgr = await BudgetManager.forEnv(w.env);
    expect(await mgr.getMonthlySpend()).toBe(80);
    expect(await mgr.getAgentMonthlyTokens("observer")).toBe(1000);
    expect(await mgr.getSpendByAgent()).toEqual([{ agent_id: "observer", cost_usd: 80, calls: 5 }]);
    // 80 / 80 = 100% → the throttle trips on the COMBINED spend (neither DB alone would).
    expect(await checkCostGuard(w.env, false)).toMatch(/budget emergency throttle/);
  });

  it("budget_config is read from the routed store (core's stale ceiling is ignored)", async () => {
    const w = world({ budget: "telemetry" });
    w.core.prepare("INSERT INTO budget_config (id, monthly_limit_usd) VALUES (1, 10)").run();
    w.tel.prepare("INSERT INTO budget_config (id, monthly_limit_usd) VALUES (1, 80)").run();
    expect((await (await BudgetManager.forEnv(w.env)).getConfig()).monthly_limit_usd).toBe(80);
  });

  it("a backfilled ledger row is never counted twice by a union aggregate", async () => {
    const w = world({ budget: "telemetry" });
    for (let i = 0; i < 5; i++) {
      w.core.prepare("INSERT INTO budget_ledger (id, agent_id, model, cost_usd, created_at) VALUES (?, 'observer', 'm', 1, ?)").run(`old-${i}`, sqliteTimestampHoursAgo(48 + i));
    }
    w.tel.prepare("INSERT INTO budget_ledger (id, agent_id, model, cost_usd, created_at) VALUES ('new', 'observer', 'm', 1, ?)").run(sqliteTimestampHoursAgo(0.1));
    const total = async () => (await unionAggregateFirst<{ c: number }>(await historyParts(w.env, "budget_ledger"), () => ({
      sql: "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM budget_ledger WHERE created_at >= datetime('now', '-30 days')/*split*/",
      binds: [],
    }), { sum: ["c"] }))?.c;
    expect(await total()).toBe(6);
    const r = await backfillTelemetryHistory(w.env, { table: "budget_ledger", days: 30, dryRun: false }, { pauseMs: 0 });
    expect(r).toMatchObject({ family: "budget", inserted: 5, done: true });
    expect(countOf(w.tel, "budget_ledger")).toBe(6);
    expect(await total()).toBe(6);
    // Idempotent: a second call copies nothing and changes nothing.
    expect((await backfillTelemetryHistory(w.env, { table: "budget_ledger", days: 30, dryRun: false }, { pauseMs: 0 })).inserted).toBe(0);
    expect(await total()).toBe(6);
  });

  it("the rollup backfill copies closed months only, clamped to telemetry's oldest month", async () => {
    const w = world({ budget: "telemetry" });
    const now = Date.UTC(2026, 10, 22, 12); // 2026-11-22
    for (const ym of ["2026-08", "2026-09", "2026-10", "2026-11"]) {
      w.core.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month, total_cost_usd, call_count) VALUES ('observer', ?, 10, 1)").run(ym);
    }
    // Telemetry already wrote October (the flip happened in October).
    w.tel.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month, total_cost_usd, call_count) VALUES ('observer', '2026-10', 4, 1)").run();
    const r = await backfillTelemetryHistory(w.env, { table: "agent_budget_rollups", days: 90, dryRun: false }, { nowMs: now, pauseMs: 0 });
    expect(r).toMatchObject({ from: "2026-08", until: "2026-10", inserted: 2, done: true });
    expect(rowsOf(w.tel, "SELECT year_month, total_cost_usd FROM agent_budget_rollups ORDER BY year_month")).toEqual([
      { year_month: "2026-08", total_cost_usd: 10 },
      { year_month: "2026-09", total_cost_usd: 10 },
      { year_month: "2026-10", total_cost_usd: 4 },
    ]);
    // October = 10 (core) + 4 (telemetry); August is counted once although it is on both DBs now.
    const parts = await historyParts(w.env, "agent_budget_rollups");
    const sum = async (ym: string) => (await unionAggregateFirst<{ c: number }>(parts, () => ({
      sql: "SELECT COALESCE(SUM(total_cost_usd), 0) AS c FROM agent_budget_rollups WHERE year_month = ?/*split*/",
      binds: [ym],
    }), { sum: ["c"] }))?.c;
    expect(await sum("2026-10")).toBe(14);
    expect(await sum("2026-08")).toBe(10);
  });

  it("a conflicting rollup row stops the backfill instead of dropping core's spend", async () => {
    const w = world({ budget: "telemetry" });
    const now = Date.UTC(2026, 10, 22, 12);
    w.core.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month, total_cost_usd, call_count) VALUES ('observer', '2026-09', 10, 1)").run();
    // A September row on telemetry, but the window was fixed before it was written.
    const first = await backfillTelemetryHistory(w.env, { table: "agent_budget_rollups", days: 90, dryRun: false }, { nowMs: now, pauseMs: 0, maxRows: 1, chunkRows: 1 });
    expect(first.inserted).toBe(1);
    w.core.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month, total_cost_usd, call_count) VALUES ('sentinel', '2026-09', 3, 1)").run();
    w.tel.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month, total_cost_usd, call_count) VALUES ('sentinel', '2026-09', 99, 9)").run();
    await expect(backfillTelemetryHistory(w.env, { table: "agent_budget_rollups", days: 90, dryRun: false }, { nowMs: now, pauseMs: 0 }))
      .rejects.toBeInstanceOf(BackfillConflictError);
  });
});

describe.skipIf(!hasSqlite())("copy-config / preflight for feeds + budget", () => {
  it("feeds: insert copies feed_configs + feed_status, is idempotent, and preflight then passes", async () => {
    const w = world();
    seedFeed(w.core, "a");
    seedFeed(w.core, "b", { enabled: 0, paused_reason: "manual" });
    w.core.prepare("INSERT INTO feed_status (feed_name, health_status, consecutive_failures, next_retry_at) VALUES ('a', 'degraded', 3, '2026-11-22 21:00:00')").run();
    const before = await telemetryPreflight(w.env, "feeds");
    expect(before.ok).toBe(false);
    expect(before.blocking.join(" ")).toMatch(/feed_configs: 2 core row\(s\) not copied.*family=feeds/);
    const dry = await copyTelemetryConfig(w.env, { family: "feeds", dryRun: true });
    expect(dry.tables.map((t) => [t.table, t.missing_on_target, t.inserted])).toEqual([["feed_configs", 2, 0], ["feed_status", 1, 0]]);
    expect(countOf(w.tel, "feed_configs")).toBe(0);
    const applied = await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false });
    expect(applied.tables.map((t) => [t.table, t.inserted])).toEqual([["feed_configs", 2], ["feed_status", 1]]);
    expect((await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false })).tables.map((t) => t.inserted)).toEqual([0, 0]);
    expect(rowsOf(w.tel, "SELECT feed_name, enabled, paused_reason FROM feed_configs ORDER BY feed_name")).toEqual([
      { feed_name: "a", enabled: 1, paused_reason: null }, { feed_name: "b", enabled: 0, paused_reason: "manual" },
    ]);
    expect((await telemetryPreflight(w.env, "feeds")).ok).toBe(true);
  });

  it("feeds: reconcile never re-enables a paused feed without force; feed_status follows the newer last_* event", async () => {
    const w = world();
    // Core enabled + NEWER; telemetry paused (paused there after the flip).
    seedFeed(w.core, "p", { enabled: 1, updated_at: "2026-11-22 12:00:00" });
    seedFeed(w.tel, "p", { enabled: 0, paused_reason: "manual", updated_at: "2026-11-22 10:00:00" });
    // feed_status: core failed at 12:00 (newer) — telemetry succeeded at 11:00.
    w.core.prepare("INSERT INTO feed_status (feed_name, health_status, consecutive_failures, last_failure, last_successful_pull) VALUES ('p', 'degraded', 2, '2026-11-22 12:00:00', '2026-11-22 09:00:00')").run();
    w.tel.prepare("INSERT INTO feed_status (feed_name, health_status, consecutive_failures, last_successful_pull) VALUES ('p', 'healthy', 0, '2026-11-22 11:00:00')").run();
    const r = await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false, mode: "reconcile" });
    const cfg = r.tables.find((t) => t.table === "feed_configs")!;
    expect(cfg).toMatchObject({ updated: 0, skipped_unpause_needs_force: 1 });
    expect(cfg.diffs[0]).toMatchObject({ key: "p", action: "skip_unpause_needs_force" });
    expect(cfg.diffs[0]).not.toHaveProperty("agent_id");
    expect(rowsOf(w.tel, "SELECT enabled, paused_reason FROM feed_configs")[0]).toEqual({ enabled: 0, paused_reason: "manual" });
    expect(r.tables.find((t) => t.table === "feed_status")!.updated).toBe(1);
    expect(rowsOf(w.tel, "SELECT consecutive_failures FROM feed_status")[0]!.consecutive_failures).toBe(2);
    // An older core breaker state does not overwrite telemetry's.
    w.tel.prepare("UPDATE feed_status SET consecutive_failures = 0, last_successful_pull = '2026-11-22 13:00:00'").run();
    const again = await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false, mode: "reconcile" });
    expect(again.tables.find((t) => t.table === "feed_status")).toMatchObject({ updated: 0, skipped_target_newer: 1 });
    await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false, mode: "reconcile", force: true });
    expect(rowsOf(w.tel, "SELECT enabled FROM feed_configs")[0]!.enabled).toBe(1);
  });

  it("budget: preflight blocks until budget_config id=1 is on telemetry and matches core", async () => {
    const w = world();
    const empty = await telemetryPreflight(w.env, "budget");
    expect(empty.blocking.join(" ")).toMatch(/budget_config: the id=1 row .* missing on TELEMETRY_DB/);
    w.core.prepare("INSERT INTO budget_config (id, monthly_limit_usd, soft_pct, hard_pct, emergency_pct) VALUES (1, 80, 80, 95, 99)").run();
    expect((await telemetryPreflight(w.env, "budget")).blocking.join(" ")).toMatch(/budget_config: 1 core row\(s\) not copied/);
    await copyTelemetryConfig(w.env, { family: "budget", dryRun: false });
    expect((await telemetryPreflight(w.env, "budget")).ok).toBe(true);
    w.core.prepare("UPDATE budget_config SET monthly_limit_usd = 100").run();
    const drift = await telemetryPreflight(w.env, "budget");
    expect(drift.ok).toBe(false);
    expect(drift.config[0]!.content_mismatch[0]).toMatchObject({ key: "1", changed: { monthly_limit_usd: { target: 80, source: 100 } } });
  });

  it("agents keeps its B1c defaults (family omitted)", async () => {
    const w = world();
    const r = await copyTelemetryConfig(w.env, { dryRun: true });
    expect(r.family).toBe("agents");
    expect(r.tables.map((t) => t.table)).toEqual(["agent_configs", "agent_approvals"]);
    expect((await telemetryPreflight(w.env)).family).toBe("agents");
  });

  it("parseBackfillParams infers the family from the table and rejects a mismatch", () => {
    expect(parseBackfillParams(new URLSearchParams("table=feed_pull_history"))).toMatchObject({ ok: true, params: { table: "feed_pull_history", dryRun: true } });
    expect(parseBackfillParams(new URLSearchParams("table=budget_ledger&family=feeds"))).toMatchObject({ ok: false });
    expect(parseBackfillParams(new URLSearchParams("table=agent_budget_rollups&family=budget&dry_run=0"))).toMatchObject({ ok: true, params: { dryRun: false } });
  });

  it("feeds backfill copies finished pulls only (FK-safe after copy-config) and resumes", async () => {
    const w = world({ feeds: "telemetry" });
    seedFeed(w.core, "a");
    for (let i = 0; i < 7; i++) {
      w.core.prepare("INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES (?, 'a', ?, 'success')").run(`p${i}`, sqliteTimestampHoursAgo(30 + i));
    }
    w.core.prepare("INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES ('fresh', 'a', ?, 'partial')").run(sqliteTimestampHoursAgo(1));
    await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false });
    const first = await backfillTelemetryHistory(w.env, { table: "feed_pull_history", days: 30, dryRun: false }, { pauseMs: 0, maxRows: 4, chunkRows: 2 });
    expect(first).toMatchObject({ family: "feeds", scanned: 4, inserted: 4, done: false });
    const second = await backfillTelemetryHistory(w.env, { table: "feed_pull_history", days: 30, dryRun: false }, { pauseMs: 0 });
    expect(second.done).toBe(true);
    expect(rowsOf(w.tel, "SELECT id FROM feed_pull_history ORDER BY id").map((r) => r.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6"]);
    // Union count: 8 core rows (7 copied + the fresh one), never 15.
    const n = (await unionAggregateFirst<{ n: number }>(await historyParts(w.env, "feed_pull_history"), () => ({
      sql: "SELECT COUNT(*) AS n FROM feed_pull_history WHERE 1 = 1/*split*/", binds: [],
    }), { sum: ["n"] }))?.n;
    expect(n).toBe(8);
  });
});

describe.skipIf(!hasSqlite())("route flip endpoint", () => {
  it("refuses to=telemetry on a failing preflight, writes nothing on a dry run, flips only its own flag", async () => {
    const w = world({ agents: "telemetry" });
    seedFeed(w.core, "a");
    const refused = await setTelemetryRoute(w.env, { family: "feeds", to: "telemetry", dryRun: false, force: false });
    expect(refused.allowed).toBe(false);
    expect(refused.written).toBe(false);
    expect(refused.refused_reasons.join(" ")).toMatch(/preflight: feed_configs: 1 core row/);
    expect(w.kv.store.has(FAMILY_ROUTE_KV_KEYS.feeds)).toBe(false);

    await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false });
    const dry = await setTelemetryRoute(w.env, { family: "feeds", to: "telemetry", dryRun: true, force: false });
    expect(dry).toMatchObject({ allowed: true, written: false, dry_run: true });
    expect(w.kv.store.has(FAMILY_ROUTE_KV_KEYS.feeds)).toBe(false);

    const flipped = await setTelemetryRoute(w.env, { family: "feeds", to: "telemetry", dryRun: false, force: false });
    expect(flipped).toMatchObject({ allowed: true, written: true, from: null, to: "telemetry" });
    expect(w.kv.store.get(FAMILY_ROUTE_KV_KEYS.feeds)).toBe("telemetry");
    expect(w.kv.store.has(FAMILY_ROUTE_KV_KEYS.budget)).toBe(false);
    expect(w.kv.store.get(TELEMETRY_ROUTE_KV_KEY)).toBe("telemetry");
  });

  it("refuses a flip back to core while core's config is stale, unless force=1", async () => {
    const w = world({ feeds: "telemetry" });
    seedFeed(w.core, "a");
    seedFeed(w.tel, "a", { enabled: 0, paused_reason: "manual" }); // paused after the flip
    const r = await setTelemetryRoute(w.env, { family: "feeds", to: "core", dryRun: false, force: false });
    expect(r.allowed).toBe(false);
    expect(r.refused_reasons[0]).toMatch(/copy-config\?family=feeds&mode=reconcile&direction=to_core/);
    expect(w.kv.store.get(FAMILY_ROUTE_KV_KEYS.feeds)).toBe("telemetry");
    await copyTelemetryConfig(w.env, { family: "feeds", dryRun: false, mode: "reconcile", direction: "to_core", force: true });
    expect((await setTelemetryRoute(w.env, { family: "feeds", to: "core", dryRun: false, force: false })).written).toBe(true);
    expect(w.kv.store.get(FAMILY_ROUTE_KV_KEYS.feeds)).toBe("core");
  });

  it("GET lists every family; the param parser requires family + to", async () => {
    const w = world({ agents: "telemetry" });
    const routes = await telemetryRoutes(w.env);
    expect(routes.map((r) => [r.family, r.flag, r.route])).toEqual([["agents", "telemetry", "telemetry"], ["feeds", null, "core"], ["budget", null, "core"]]);
    expect(parseSetRouteParams(new URLSearchParams("to=telemetry"))).toMatchObject({ ok: false });
    expect(parseSetRouteParams(new URLSearchParams("family=feeds&to=nope"))).toMatchObject({ ok: false });
    expect(parseSetRouteParams(new URLSearchParams("family=budget&to=telemetry"))).toMatchObject({ ok: true, params: { family: "budget", to: "telemetry", dryRun: true } });
  });
});

describe.skipIf(!hasSqlite())("backfill plans", () => {
  it("the feeds / budget backfill chunks seek by rowid, with and without ANALYZE", () => {
    const db = openMigratedDb();
    db.prepare("INSERT OR IGNORE INTO feed_configs (feed_name, display_name, schedule_cron) VALUES ('a', 'a', '0 * * * *')").run();
    for (let i = 0; i < 300; i++) {
      const ts = sqliteTimestampHoursAgo(i);
      db.prepare("INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES (?, 'a', ?, 'success')").run(`p${i}`, ts);
      db.prepare("INSERT INTO budget_ledger (id, agent_id, model, created_at) VALUES (?, 'x', 'm', ?)").run(`l${i}`, ts);
      db.prepare("INSERT INTO agent_budget_rollups (agent_id, year_month) VALUES (?, ?)").run(`a${i % 30}`, `20${10 + Math.floor(i / 30)}-01`);
    }
    const tables = ["feed_pull_history", "budget_ledger", "agent_budget_rollups"] as const;
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec("ANALYZE");
      for (const table of tables) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${backfillSelectSql(table)}`).all(10, "2000-01-01", "2100-01-01", 100) as Array<{ detail: string }>)
          .map((r) => r.detail).join(" | ");
        expect(plan, `${table} analyzed=${analyzed}`).toMatch(/SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid>\?\)/);
        expect(plan, `${table} analyzed=${analyzed}`).not.toMatch(/TEMP B-TREE|USING (COVERING )?INDEX/);
      }
    }
  });
});
