// Pins the 2026-11-08 Navigator/page-load D1 spend fixes on the brands
// table (~133K rows/scan) and the pipeline-status agent_runs read:
//
//   - dashboard overview (global): brand tiles come from the shared
//     `count.brands.total` / `count.brands.new_this_week` counters — a warm
//     KV answers with zero brands reads; scoped callers keep the raw count.
//   - brand list + admin brand list (unfiltered): total from
//     `count.brands.total`; filtered/scoped totals stay raw.
//   - brand composition aggregate: total = sum of tier groups, no second scan.
//   - pipeline-status: last-run-per-agent served from cachedValue.

import { describe, it, expect } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type StatementLogEntry } from "./sqlite-d1-harness";
import { cachedCount } from "../src/lib/cached-count";
import { cachedValue } from "../src/lib/cached-value";
import { handleDashboardOverview } from "../src/handlers/dashboard";
import { handleListBrands } from "../src/handlers/brands";
import { handleAdminListBrands } from "../src/handlers/admin/brands";
import { handlePipelineStatus } from "../src/handlers/admin/pipeline";
import { compositionAggregate } from "../src/lib/brand-aggregates";
import type { Env } from "../src/types";
import type { OrgScope } from "../src/middleware/auth";

function makeEnv() {
  const raw = openMigratedDb();
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log, swallow: () => true });
  // getReadSession → withSession(); attachBookmark → getBookmark().
  const dbWithSession = Object.assign(db, {
    withSession: () => Object.assign(Object.create(db), { getBookmark: () => null }),
  });
  const env = { DB: dbWithSession, CACHE: fakeKv() } as unknown as Env;
  const ins = raw.prepare(
    "INSERT INTO brands (id, name, canonical_domain, first_seen, tier) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run("b1", "Alpha", "alpha.com", new Date().toISOString().slice(0, 19).replace("T", " "), "tracked");
  ins.run("b2", "Beta", "beta.com", new Date().toISOString().slice(0, 19).replace("T", " "), "monitored");
  ins.run("b3", "Gamma", "gamma.com", "2020-01-01 00:00:00", "customer");
  return { env, raw, log };
}

const brandReads = (log: StatementLogEntry[]) => log.filter((e) => /FROM brands\b/.test(e.sql));
const bareBrandCounts = (log: StatementLogEntry[]) =>
  log.filter((e) => /SELECT COUNT\(\*\) AS n FROM brands\s*$/.test(e.sql.trim()) || /^SELECT COUNT\(\*\) AS (n|tracked)[\s\S]*FROM brands\s*$/.test(e.sql.trim()));

const req = (path: string) => new Request(`https://averrow.test${path}`);

describe.skipIf(!hasSqlite())("dashboard overview brand tiles", () => {
  it("cache miss: global path computes tracked/new_7d through the shared counters", async () => {
    const { env, raw, log } = makeEnv();
    // Same numbers the pre-fix single-scan query produced (migrations seed brands too).
    const legacy = raw.prepare(`
      SELECT COUNT(*) AS tracked,
             SUM(CASE WHEN first_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d
      FROM brands`).all()[0] as { tracked: number; new_7d: number };
    const res = await handleDashboardOverview(req("/api/dashboard/overview"), env, null);
    const body = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data.brands_tracked).toBe(legacy.tracked);
    expect(body.data.brands_new).toBe(legacy.new_7d);
    expect(legacy.new_7d).toBeGreaterThanOrEqual(2);
    expect(Object.keys(body.data).sort()).toEqual([
      "active_campaigns", "active_threats", "brands_new", "brands_tracked",
      "campaigns_new", "feed_health", "providers_tracked", "threats_24h",
    ]);
    // The old single COUNT+SUM(CASE first_seen) scan is gone on the global path.
    expect(log.some((e) => /SUM\(CASE WHEN first_seen/.test(e.sql) && /FROM brands/.test(e.sql))).toBe(false);
  });

  it("cache hit: warm shared counters answer with zero brands reads", async () => {
    const { env, log } = makeEnv();
    await cachedCount(env, "count.brands.total", 3600, async () => 999);
    await cachedCount(env, "count.brands.new_this_week", 1800, async () => 7);
    const body = await (await handleDashboardOverview(req("/api/dashboard/overview"), env, null)).json() as
      { data: { brands_tracked: number; brands_new: number } };
    expect(body.data.brands_tracked).toBe(999);
    expect(body.data.brands_new).toBe(7);
    expect(brandReads(log)).toHaveLength(0);
  });

  it("scoped caller keeps the raw bounded count (not the global counter)", async () => {
    const { env } = makeEnv();
    await cachedCount(env, "count.brands.total", 3600, async () => 999);
    const scope = { org_id: "o1", brand_ids: ["b1", "b3"] } as unknown as OrgScope;
    const body = await (await handleDashboardOverview(req("/api/dashboard/overview"), env, scope)).json() as
      { data: { brands_tracked: number; brands_new: number } };
    expect(body.data.brands_tracked).toBe(2);
    expect(body.data.brands_new).toBe(1);
  });
});

describe.skipIf(!hasSqlite())("brand list totals", () => {
  it("ops brand list (unscoped) reads the total from count.brands.total", async () => {
    const { env, log } = makeEnv();
    await cachedCount(env, "count.brands.total", 3600, async () => 4242);
    const res = await handleListBrands(req("/api/brands?limit=10"), env, null);
    const body = await res.json() as { success: boolean; total?: number };
    expect(body.success).toBe(true);
    expect(bareBrandCounts(log)).toHaveLength(0);
    expect(JSON.stringify(body)).toContain("4242");
  });

  it("admin brand list: unfiltered total from the counter, filtered total stays raw", async () => {
    const { env, log } = makeEnv();
    await cachedCount(env, "count.brands.total", 3600, async () => 4242);
    const unf = await (await handleAdminListBrands(req("/api/admin/brands"), env)).json() as { total: number };
    expect(unf.total).toBe(4242);
    expect(log.some((e) => /SELECT COUNT\(\*\) AS n FROM brands b/.test(e.sql))).toBe(false);

    const filt = await (await handleAdminListBrands(req("/api/admin/brands?q=alp"), env)).json() as { total: number };
    expect(filt.total).toBe(1);
  });
});

describe.skipIf(!hasSqlite())("brand composition aggregate", () => {
  it("total equals the sum of tier groups and no bare COUNT(*) runs", async () => {
    const { env, raw, log } = makeEnv();
    const agg = await compositionAggregate(env);
    expect(agg.total).toBe((raw.prepare("SELECT COUNT(*) AS n FROM brands").all()[0] as { n: number }).n);
    expect(agg.total).toBe(agg.tier_mix.reduce((a, r) => a + r.count, 0));
    expect(log.some((e) => /^SELECT COUNT\(\*\) AS n FROM brands$/.test(e.sql.trim()))).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("pipeline-status agent last runs", () => {
  it("cache hit: last-run-per-agent comes from cachedValue with no agent_runs read", async () => {
    const { env, log } = makeEnv();
    await cachedValue(env, "pipeline.agent_last_runs_24h", 300, async () => [
      { agent_id: "cartographer", last_run_at: "2026-11-08 11:59:00", records_processed: 17, duration_ms: 5, status: "success" },
    ]);
    const res = await handlePipelineStatus(req("/api/admin/pipeline-status"), env);
    const body = await res.json() as { success: boolean; data: { pipelines: Array<Record<string, unknown>> } | Array<Record<string, unknown>> };
    expect(log.some((e) => /FROM agent_runs/.test(e.sql))).toBe(false);
    expect(JSON.stringify(body)).toContain("2026-11-08 11:59:00");
  });

  it("cache miss: computes from agent_runs and returns the same row shape", async () => {
    const { env, raw, log } = makeEnv();
    raw.prepare(
      "INSERT INTO agent_runs (id, agent_id, started_at, completed_at, status, records_processed, duration_ms) VALUES ('x', 'cartographer', datetime('now','-2 hours'), datetime('now','-1 hours'), 'success', 9, 100)",
    ).run();
    const res = await handlePipelineStatus(req("/api/admin/pipeline-status"), env);
    expect(res.status).toBe(200);
    expect(log.some((e) => /FROM agent_runs/.test(e.sql) && /GROUP BY \+agent_id/.test(e.sql))).toBe(true);
    const cached = await cachedValue<Array<{ agent_id: string; records_processed: number }>>(
      env, "pipeline.agent_last_runs_24h", 300, async () => { throw new Error("should be cached"); });
    expect(cached).toEqual([expect.objectContaining({ agent_id: "cartographer", records_processed: 9, status: "success" })]);
  });
});
