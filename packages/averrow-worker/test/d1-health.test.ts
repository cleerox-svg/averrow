/**
 * handlers/d1-health.ts — v2 safety contract.
 *
 * v1 COUNT(*)-ed every table in one Promise.all (threats ~1.65M rows) and
 * benchmarked a threats ORDER BY, enough on its own to trip D1's overload
 * window. Pins: reads are strictly sequential (never two in flight), no
 * COUNT(*) on a table whose row upper bound is >= 100K, no threats scan,
 * and the response is KV-cached 10 min.
 */

import { describe, it, expect } from "vitest";
import {
  handleD1Health, computeD1Health, statLeadingRows, d1HealthTtlFor,
  EXACT_COUNT_MAX_ROWS, D1_HEALTH_MAX_READ_ERRORS, type D1HealthData,
} from "../src/handlers/d1-health";
import type { Env } from "../src/types";

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface FakeTable {
  name: string;
  sql: string;
  maxRowid: number | null;
  count: number;
}

const TABLES: FakeTable[] = [
  { name: "threats", sql: "CREATE TABLE threats (id TEXT PRIMARY KEY)", maxRowid: 1_650_000, count: 1_640_000 },
  { name: "brands", sql: "CREATE TABLE brands (id TEXT PRIMARY KEY)", maxRowid: 114_251, count: 114_251 },
  { name: "feed_configs", sql: "CREATE TABLE feed_configs (id TEXT)", maxRowid: 80, count: 75 },
  { name: "empty_t", sql: "CREATE TABLE empty_t (id TEXT)", maxRowid: null, count: 0 },
  { name: "kv_pairs", sql: "CREATE TABLE kv_pairs (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID", maxRowid: null, count: 12 },
  { name: "churny", sql: "CREATE TABLE churny (id INTEGER PRIMARY KEY AUTOINCREMENT)", maxRowid: 5_000_000, count: 40 },
];

/** sqlite_stat1: threats stale-low (ANALYZE'd long ago), kv_pairs present. */
const STAT1 = [
  { tbl: "threats", stat: "90000 3" },
  { tbl: "threats", stat: "45000 2" }, // partial index — fewer rows
  { tbl: "kv_pairs", stat: "12 1" },
];

function makeDb() {
  const log: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async <T>(sql: string, fn: () => T): Promise<T> => {
    log.push(sql);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 0));
    inFlight -= 1;
    return fn();
  };
  const firstFor = (sql: string): unknown => {
    if (sql === "PRAGMA page_size") return { page_size: 4096 };
    if (sql === "PRAGMA page_count") return { page_count: 1_323_894 };
    if (sql === "PRAGMA schema_version") return { schema_version: 900 };
    if (sql === "PRAGMA foreign_keys") return { foreign_keys: 1 };
    if (sql.includes("type = 'index'") && sql.includes("WHERE%")) return { n: 40 };
    if (sql.includes("type = 'index'")) return { n: 400 };
    const mr = /SELECT MAX\(rowid\) AS m FROM "(\w+)"/.exec(sql);
    if (mr) return { m: TABLES.find((t) => t.name === mr[1])?.maxRowid ?? null };
    const mc = /SELECT COUNT\(\*\) AS n FROM "(\w+)"/.exec(sql);
    if (mc) return { n: TABLES.find((t) => t.name === mc[1])?.count ?? 0 };
    if (sql.includes("COUNT(*) AS n FROM d1_migrations")) return { n: 340 };
    if (sql.includes("FROM d1_migrations")) return { name: "0337_site_script_watch.sql" };
    return null;
  };
  const allFor = (sql: string): unknown[] => {
    if (sql.includes("FROM sqlite_master WHERE type = 'table'")) return TABLES.map((t) => ({ name: t.name, sql: t.sql }));
    if (sql.includes("FROM sqlite_stat1")) return STAT1;
    if (sql === "PRAGMA foreign_key_check") return [];
    return [];
  };
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind: () => stmt,
        first: <T>() => run(sql, () => firstFor(sql) as T),
        all: <T>() => run(sql, () => ({ results: allFor(sql) as T[] })),
      };
      return stmt;
    },
  };
  return { db, log, maxInFlight: () => maxInFlight };
}

function envWith(db: unknown, kv: MockKV): Env {
  return { DB: { withSession: () => db }, CACHE: kv } as unknown as Env;
}

const req = (qs = "") => new Request(`https://averrow.com/api/internal/d1-health${qs}`);

describe("d1-health v2 — bounded, sequential reads", () => {
  it("never has two reads in flight", async () => {
    const f = makeDb();
    await computeD1Health(f.db as unknown as D1Database, true);
    expect(f.maxInFlight()).toBe(1);
  });

  it("issues no COUNT(*) on a table with a >= 100K upper bound, and no threats scan", async () => {
    const f = makeDb();
    const data = await computeD1Health(f.db as unknown as D1Database, false);
    const counted = f.log
      .map((s) => /SELECT COUNT\(\*\) AS n FROM "(\w+)"/.exec(s)?.[1])
      .filter((n): n is string => n != null);
    for (const name of counted) {
      const t = TABLES.find((x) => x.name === name);
      expect(t?.maxRowid ?? 0).toBeLessThan(EXACT_COUNT_MAX_ROWS);
    }
    expect(counted).not.toContain("threats");
    expect(counted).not.toContain("brands");
    expect(counted).not.toContain("churny");
    // Only PK probes touch threats beyond MAX(rowid).
    const threatsSql = f.log.filter((s) => /\bthreats\b/.test(s));
    expect(threatsSql.every((s) => s.includes("MAX(rowid)") || s.includes("WHERE id = ?"))).toBe(true);
    expect(f.log.some((s) => s.includes("ORDER BY created_at"))).toBe(false);
    expect(f.log.some((s) => s.includes("COUNT(*) AS n FROM brands"))).toBe(false);

    const byName = new Map(data.inventory.top_tables_by_rows.map((t) => [t.name, t]));
    // A stale stat1 (90K) must not hide MAX(rowid) (1.65M): the larger wins,
    // both are kept, and the gap is flagged.
    expect(byName.get("threats")).toMatchObject({
      rows: 1_650_000, rows_estimate: 1_650_000, rows_exact: false, estimate_source: "max_rowid",
      stat_rows: 90_000, max_rowid: 1_650_000, estimate_divergent: true,
    });
    expect(byName.get("brands")).toMatchObject({
      rows: 114_251, rows_exact: false, estimate_source: "max_rowid", stat_rows: null, estimate_divergent: false,
    });
    expect(data.inventory.top_tables_by_rows[0]?.name).toBe("churny"); // MAX(rowid) overshoot, sorted on it
    expect(data.read_errors).toBe(0);
    expect(data._meta.cache_ttl_seconds).toBe(600);
    expect(byName.get("feed_configs")).toMatchObject({ rows: 75, rows_exact: true, estimate_source: "count" });
    expect(byName.get("empty_t")).toMatchObject({ rows: 0, rows_exact: true });
    // WITHOUT ROWID: no MAX(rowid); a small stat permits the exact count.
    expect(f.log.some((s) => s.includes('MAX(rowid) AS m FROM "kv_pairs"'))).toBe(false);
    expect(byName.get("kv_pairs")).toMatchObject({ rows: 12, rows_exact: true, max_rowid: null, stat_rows: 12 });
    expect(data.database.size_bytes).toBe(4096 * 1_323_894);
    expect(data.query_latency.brands_count_ms).toBeNull();
    expect(data.query_latency.threats_recent_10_ms).toBeNull();
  });

  it("caps the WITHOUT ROWID exact count far below the rowid cap", async () => {
    const f = makeDb();
    STAT1.push({ tbl: "kv_pairs", stat: "50000 1" });
    try {
      const data = await computeD1Health(f.db as unknown as D1Database, false);
      const kvp = data.inventory.top_tables_by_rows.find((t) => t.name === "kv_pairs");
      expect(kvp).toMatchObject({ rows: 50_000, rows_exact: false, estimate_source: "sqlite_stat1" });
      expect(f.log.some((s) => s.includes('COUNT(*) AS n FROM "kv_pairs"'))).toBe(false);
    } finally {
      STAT1.pop();
    }
  });

  it("parses the leading number of a stat1 string", () => {
    expect(statLeadingRows("1234 5 1")).toBe(1234);
    expect(statLeadingRows("x")).toBeNull();
    expect(statLeadingRows(null)).toBeNull();
  });
});

describe("handleD1Health — 10-min KV cache", () => {
  it("serves the second call from KV (no D1 reads) and slices top_n from the cached list", async () => {
    const kv = new MockKV();
    const f = makeDb();
    const first = await handleD1Health(req("?top_n=2"), envWith(f.db, kv));
    const firstBody = (await first.json()) as { success: boolean; data: { inventory: { top_tables_by_rows: unknown[]; table_count: number } } };
    expect(firstBody.success).toBe(true);
    expect(firstBody.data.inventory.top_tables_by_rows).toHaveLength(2);
    expect(firstBody.data.inventory.table_count).toBe(TABLES.length);
    expect(kv.store.has("cv:d1_health.v2.fk0")).toBe(true);

    const throwing = { prepare(): never { throw new Error("unexpected D1 read on warm cache"); } };
    const second = await handleD1Health(req("?top_n=5"), envWith(throwing, kv));
    const secondBody = (await second.json()) as { success: boolean; data: { inventory: { top_tables_by_rows: unknown[] } } };
    expect(secondBody.success).toBe(true);
    expect(secondBody.data.inventory.top_tables_by_rows).toHaveLength(5);
  });

  it("does not cache a snapshot whose reads all failed (empty table list)", async () => {
    const kv = new MockKV();
    const failing = { prepare() { return { bind() { return this; }, async first(): Promise<never> { throw new Error("D1 DB is overloaded"); }, async all(): Promise<never> { throw new Error("D1 DB is overloaded"); } }; } };
    const res = await handleD1Health(req(), envWith(failing, kv));
    const body = (await res.json()) as { success: boolean; data: D1HealthData };
    expect(body.success).toBe(true);
    expect(body.data.read_errors).toBeGreaterThan(D1_HEALTH_MAX_READ_ERRORS);
    expect(body.data.query_latency.trivial_select_1_ms).toBeNull();
    expect(body.data._meta.cache_ttl_seconds).toBe(0);
    expect(kv.store.has("cv:d1_health.v2.fk0")).toBe(false);
  });

  it("caches a degraded snapshot (size PRAGMAs null or > N read errors) for 60 s only", async () => {
    const data = await computeD1Health(makeDb().db as unknown as D1Database, false);
    expect(d1HealthTtlFor(data)).toBe(600);
    expect(d1HealthTtlFor({ ...data, database: { ...data.database, size_bytes: null } })).toBe(60);
    expect(d1HealthTtlFor({ ...data, read_errors: D1_HEALTH_MAX_READ_ERRORS + 1 })).toBe(60);
    expect(d1HealthTtlFor({ ...data, read_errors: D1_HEALTH_MAX_READ_ERRORS })).toBe(600);
  });

  it("keys check_fk separately", async () => {
    const kv = new MockKV();
    await handleD1Health(req("?check_fk=true"), envWith(makeDb().db, kv));
    expect(kv.store.has("cv:d1_health.v2.fk1")).toBe(true);
    expect(kv.store.has("cv:d1_health.v2.fk0")).toBe(false);
  });
});
