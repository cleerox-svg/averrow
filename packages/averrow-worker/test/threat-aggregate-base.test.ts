/**
 * threatAggregate — the unfiltered slice's whole-table numbers come from ONE
 * shared, cached base scan (+ threat_cube_status for new_24h).
 *
 * D1 spike 2026-11-09/10: every refill of the unfiltered Threats aggregate ran
 * five whole-table reads of `threats` (headline SUMs, GROUP BY severity /
 * status / threat_type / country_code; ~1.5–3.1M rows each), and cold-key
 * retries / degraded polling repeated the refill 4–9× in an hour (~178M
 * unmetered rows at 21:00Z). Pins:
 *   1. The unfiltered refill issues none of those per-dimension statements;
 *      it reads the base (one `NOT INDEXED` scan) and the cube.
 *   2. The base is shared: an outer refill with a fresh base re-scans nothing;
 *      concurrent cold callers scan once (single-flight).
 *   3. The reduced base equals what the former per-dimension SQL returned
 *      (NULL groups, the 'XX' exclusion, LIMIT 8 / LIMIT 10 included).
 *   4. A failing base scan degrades exactly the sections it feeds and caches
 *      no base.
 *   5. Plans: the base is a plain table scan (rows read = table rows, never an
 *      index walk + lookups like the old severity GROUP BY's ~2× read) and the
 *      cube read seeks idx_cube_status_hour.
 */

import { describe, it, expect, vi } from "vitest";
import { logger } from "../src/lib/logger";
import {
  hasSqlite,
  openDerivedDb,
  openMigratedDb,
  d1FromSqlite,
  fakeKv,
  sqliteTimestampHoursAgo,
  type StatementLogEntry,
  type SqliteDb,
} from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import {
  threatAggregate,
  threatAggregateBase,
  reduceThreatAggregateBase,
  THREAT_AGGREGATE_BASE_KEY,
  THREAT_AGGREGATE_BASE_SQL,
  THREAT_AGGREGATE_BASE_TTL_S,
  THREAT_AGGREGATE_NEW_24H_CUBE_SQL,
} from "../src/lib/threat-aggregates";

const TABLES = [
  "threats", "brands", "hosting_providers", "campaigns",
  "threat_actors", "threat_actor_infrastructure", "threat_cube_status",
];

const SEVERITIES = ["critical", "high", "medium", "low", null];
// status and threat_type are NOT NULL + CHECKed in the schema; severity is nullable.
const STATUSES = ["active", "active", "active", "down", "remediated"];
// All 10 schema types (> the LIMIT 8) and 13 countries incl. 'XX' and NULL (> the LIMIT 10).
const TYPES = ["phishing", "typosquatting", "impersonation", "malware_distribution", "credential_harvesting",
  "c2", "scanning", "malicious_ip", "botnet", "malicious_ssl"];
const COUNTRIES = ["US", "DE", "CN", "RU", "NL", "FR", "GB", "BR", "IN", "JP", "SG", "XX", null];

function seed(): SqliteDb {
  const db = openDerivedDb(TABLES, { indexes: ["idx_threats_created_brand", "idx_cube_status_hour"] });
  const ins = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, status, severity,
                          country_code, confidence_score, campaign_id, created_at, first_seen)
     VALUES (?, 'feedA', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Deterministic skewed mix so every ranking has a clear order.
  for (let i = 0; i < 400; i++) {
    const ts = sqliteTimestampHoursAgo(i % 72);
    ins.run(
      `t${i}`,
      TYPES[(i * i) % TYPES.length],
      `d${i}.example`,
      STATUSES[i % STATUSES.length],
      SEVERITIES[(i * 7) % SEVERITIES.length] ?? null,
      COUNTRIES[(i * i * 3) % COUNTRIES.length] ?? null,
      (i * 13) % 100,
      i % 3 === 0 ? `c${i % 5}` : null,
      ts, ts,
    );
  }
  // Cube: 3 buckets inside the last 24h, 1 outside.
  const cube = db.prepare(
    `INSERT INTO threat_cube_status (hour_bucket, threat_type, severity, source_feed, status, threat_count)
     VALUES (strftime('%Y-%m-%d %H:00:00', 'now', ?), 'phishing', 'high', 'feedA', 'active', ?)`,
  );
  cube.run("-1 hours", 5);
  cube.run("-5 hours", 7);
  cube.run("-23 hours", 11);
  cube.run("-30 hours", 1000);
  return db;
}

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** The former per-refill whole-table statements (2026-11-09 D1 top queries). */
const FORMER_SHAPES = [
  /SELECT t\.severity AS severity, COUNT\(\*\) AS count FROM threats t GROUP BY t\.severity/,
  /SELECT t\.status AS status, COUNT\(\*\) AS count FROM threats t GROUP BY t\.status/,
  /SELECT t\.threat_type AS type, COUNT\(\*\) AS count FROM threats t GROUP BY t\.threat_type/,
  /SELECT t\.country_code AS country, COUNT\(\*\) AS count FROM threats t WHERE t\.country_code IS NOT NULL/,
  /COUNT\(\*\) AS total, SUM\(CASE WHEN t\.confidence_score >= 70/,
];

const isBase = (sql: string) => norm(sql).includes("FROM threats t NOT INDEXED");

describe.skipIf(!hasSqlite())("threatAggregate unfiltered base scan", () => {
  it("the unfiltered refill runs none of the former whole-table statements: one base scan + the cube", async () => {
    const log: StatementLogEntry[] = [];
    const env = { DB: d1FromSqlite(seed(), { log }), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {});
    expect(agg.degraded_sections).toEqual([]);
    const sqls = log.map((e) => norm(e.sql));
    for (const shape of FORMER_SHAPES) expect(sqls.filter((q) => shape.test(q))).toEqual([]);
    expect(sqls.filter(isBase).length).toBe(1);
    expect(sqls.filter((q) => q.includes("FROM threat_cube_status")).length).toBe(1);
  });

  it("filtered and org-scoped slices keep their own GROUP BYs and never read the base", async () => {
    for (const [filters, scope] of [[{ status: "active" }, null], [{}, { org_id: 1, brand_ids: ["b1"] }]] as const) {
      const log: StatementLogEntry[] = [];
      const env = { DB: d1FromSqlite(seed(), { log }), CACHE: fakeKv() } as unknown as Env;
      await threatAggregate(env, { ...filters }, scope ? { ...scope, brand_ids: [...scope.brand_ids] } : null);
      const sqls = log.map((e) => e.sql);
      expect(sqls.some(isBase)).toBe(false);
      expect(sqls.some((q) => q.includes("threat_cube_status"))).toBe(false);
      expect(sqls.some((q) => /GROUP BY t\.severity/.test(q))).toBe(true);
    }
  });

  it("matches the former per-dimension SQL exactly (NULL groups, 'XX' exclusion, LIMIT 8 / 10)", async () => {
    const db = seed();
    const env = { DB: d1FromSqlite(db), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {});

    type C = { count: number };
    const q = <T,>(sql: string) => db.prepare(sql).all() as unknown as T[];
    const sortRows = <T extends C>(rows: T[], k: keyof T) =>
      [...rows].sort((a, b) => b.count - a.count || String(a[k]).localeCompare(String(b[k])));

    expect(agg.by_severity).toEqual(sortRows(q<{ severity: string } & C>(
      "SELECT t.severity AS severity, COUNT(*) AS count FROM threats t GROUP BY t.severity"), "severity"));
    expect(agg.by_status).toEqual(sortRows(q<{ status: string } & C>(
      "SELECT t.status AS status, COUNT(*) AS count FROM threats t GROUP BY t.status"), "status"));
    expect(agg.by_type).toEqual(sortRows(q<{ type: string } & C>(
      "SELECT t.threat_type AS type, COUNT(*) AS count FROM threats t GROUP BY t.threat_type"), "type").slice(0, 8));
    expect(agg.top_countries).toEqual(sortRows(q<{ country: string } & C>(
      `SELECT t.country_code AS country, COUNT(*) AS count FROM threats t
        WHERE t.country_code IS NOT NULL AND t.country_code != 'XX' GROUP BY t.country_code`), "country").slice(0, 10));
    expect(agg.by_severity.some((r) => r.severity === null)).toBe(true); // NULL group kept, as before
    expect(agg.top_countries.some((r) => r.country === "XX" || r.country === null)).toBe(false);

    const h = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN confidence_score >= 70 THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN campaign_id IS NOT NULL THEN 1 ELSE 0 END) AS correlated,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status IN ('down','remediated') THEN 1 ELSE 0 END) AS addressed
      FROM threats`).get() as { total: number; confirmed: number; correlated: number; active: number; addressed: number };
    expect(agg.total).toBe(h.total);
    expect(agg.confirmed).toBe(h.confirmed);
    expect(agg.correlated).toBe(h.correlated);   // no actor infra seeded → attributed 0
    expect(agg.active).toBe(h.active);
    expect(agg.addressed).toBe(h.addressed);
    expect(agg.remediation_rate).toBeCloseTo(h.addressed / h.total);
  });

  it("new_24h comes from threat_cube_status (hour buckets in the last 24h), not threats", async () => {
    const env = { DB: d1FromSqlite(seed()), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {});
    expect(agg.new_24h).toBe(5 + 7 + 11);
  });

  it("an outer refill with a fresh base re-scans nothing; the base is cached for 7h", async () => {
    const kv = fakeKv();
    const log: StatementLogEntry[] = [];
    const env = { DB: d1FromSqlite(seed(), { log }), CACHE: kv } as unknown as Env;
    const first = await threatAggregate(env, {});
    const raw = kv.store.get(`cv:${THREAT_AGGREGATE_BASE_KEY}`);
    expect(raw).toBeDefined();
    // Drop the OUTER entry only (simulates its 3h TTL lapsing before the base's 6h).
    for (const k of [...kv.store.keys()]) if (k.startsWith("cv:threat-agg:")) kv.store.delete(k);
    log.length = 0;
    const second = await threatAggregate(env, {});
    expect(log.map((e) => e.sql).filter(isBase)).toEqual([]);
    expect(second.by_severity).toEqual(first.by_severity);
    expect(second.total).toBe(first.total);
    expect(THREAT_AGGREGATE_BASE_TTL_S).toBe(25200);
  });

  it("single-flight: a cold caller that finds the base lock held waits for the holder's write instead of scanning", async () => {
    const log: StatementLogEntry[] = [];
    const kv = fakeKv();
    const env = { DB: d1FromSqlite(seed(), { log }), CACHE: kv } as unknown as Env;
    const holder = await threatAggregateBase(
      { DB: d1FromSqlite(seed()), CACHE: fakeKv() } as unknown as Env, d1FromSqlite(seed()));
    // Another isolate is mid-refill: its lock is in KV, its entry not yet.
    kv.store.set(`cvlock:${THREAT_AGGREGATE_BASE_KEY}`, String(Date.now()));
    const waiting = threatAggregateBase(env, env.DB);
    setTimeout(() => {
      kv.store.set(`cv:${THREAT_AGGREGATE_BASE_KEY}`, JSON.stringify({ v: holder, t: Date.now() }));
    }, 200);
    const got = await waiting;
    expect(got).toEqual(holder);
    expect(log.map((e) => e.sql).filter(isBase)).toEqual([]);
  });

  it("a failing base scan degrades exactly the sections it feeds and caches no base", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const base = d1FromSqlite(seed());
      const failing = new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (isBase(sql)) throw new Error("D1 DB is overloaded");
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const kv = fakeKv();
      const agg = await threatAggregate({ DB: failing, CACHE: kv } as unknown as Env, {});
      expect([...(agg.degraded_sections ?? [])].sort()).toEqual(
        ["by_severity", "by_status", "by_type", "headline", "top_countries"]);
      expect(agg.total).toBe(0);
      expect(agg.by_severity).toEqual([]);
      expect(agg.top_countries).toEqual([]);
      // Sections with their own reads are intact.
      expect(agg.surging_signals.length).toBeGreaterThan(0);
      expect(kv.store.has(`cv:${THREAT_AGGREGATE_BASE_KEY}`)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("reduceThreatAggregateBase on no rows is all zeros / empty", () => {
    expect(reduceThreatAggregateBase([])).toEqual({
      total: 0, confirmed: 0, correlated_by_campaign: 0, active: 0, addressed: 0,
      by_severity: [], by_type: [], by_status: [], top_countries: [],
    });
  });

  it("plans: the base is a plain table scan; the cube read seeks idx_cube_status_hour", () => {
    const db = openMigratedDb();
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    const basePlan = plan(THREAT_AGGREGATE_BASE_SQL);
    expect(basePlan).toMatch(/SCAN t\b/);
    expect(basePlan).not.toMatch(/INDEX/);
    expect(plan(THREAT_AGGREGATE_NEW_24H_CUBE_SQL)).toMatch(/SEARCH threat_cube_status USING (COVERING )?INDEX idx_cube_status_hour \(hour_bucket>\?\)/);
  });
});
