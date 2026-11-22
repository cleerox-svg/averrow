/**
 * lib/db-inventory.ts — the daily DB inventory: hour-only gate, budget /
 * stamp / claim skips, agent_runs + agent_events bookkeeping, KV outputs,
 * size history append, dbstat refusal memo.
 */

import { describe, it, expect } from "vitest";
import {
  appendSizePoint,
  DB_INVENTORY_CLAIM_KEY,
  inventoryKey,
  inventoryStampKey,
  isDbInventoryHour,
  parseSizeHistory,
  runDbInventory,
  sizeHistoryKey,
  DB_SIZE_HISTORY_MAX_POINTS,
} from "../src/lib/db-inventory";
import type { Env } from "../src/types";

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

const HOUR4 = Date.parse("2026-11-22T04:05:00Z");

function fakeDb(opts: { dbstat?: "denied" | "ok"; tables?: string[] } = {}) {
  const log: Array<{ sql: string; binds: unknown[] }> = [];
  const tables = opts.tables ?? ["threats", "brands"];
  const first = (sql: string): unknown => {
    if (sql === "PRAGMA page_size") return { page_size: 4096 };
    if (sql === "PRAGMA page_count") return { page_count: 100 };
    if (sql.includes("COUNT(*) AS n FROM sqlite_master")) return { n: tables.length };
    const mr = /MAX\(rowid\) AS m FROM "(\w+)"/.exec(sql);
    if (mr) return { m: mr[1] === "threats" ? 1_600_000 : 50 };
    if (/COUNT\(\*\) AS n FROM "/.test(sql)) return { n: 50 };
    return null;
  };
  const all = (sql: string): unknown[] => {
    if (sql.includes("FROM sqlite_master WHERE type = 'table'")) return tables.map((name) => ({ name, sql: `CREATE TABLE ${name} (id TEXT)` }));
    if (sql.includes("sqlite_stat1")) return [];
    if (sql.includes("FROM dbstat LIMIT 1")) {
      if (opts.dbstat === "denied") throw new Error("D1_ERROR: not authorized: SQLITE_AUTH");
      return [{ name: "threats" }];
    }
    if (sql.includes("FROM dbstat AS d")) return [
      { name: "threats", tbl: "threats", bytes: 8000 },
      { name: "idx_threats_x", tbl: "threats", bytes: 2000 },
      { name: "brands", tbl: "brands", bytes: 500 },
    ];
    return [];
  };
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind: (...b: unknown[]) => { binds = b; return stmt; },
        first: async () => { log.push({ sql, binds }); return first(sql); },
        all: async () => { log.push({ sql, binds }); return { results: all(sql) }; },
        run: async () => { log.push({ sql, binds }); return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
  };
  return { db, log };
}

const envOf = (db: unknown, kv: MockKV, extra: Record<string, unknown> = {}) =>
  ({ DB: db, CACHE: kv, ENVIRONMENT: "production", ...extra } as unknown as Env);

describe("gate", () => {
  it("runs only in UTC hour 4 (hour-only, any minute)", () => {
    expect(isDbInventoryHour(Date.parse("2026-11-22T04:00:00Z"))).toBe(true);
    expect(isDbInventoryHour(Date.parse("2026-11-22T04:55:00Z"))).toBe(true);
    expect(isDbInventoryHour(Date.parse("2026-11-22T03:59:00Z"))).toBe(false);
    expect(isDbInventoryHour(Date.parse("2026-11-22T05:00:00Z"))).toBe(false);
  });

  it("skips outside the hour, over budget, when stamped today, and when claimed — without touching D1", async () => {
    const { db, log } = fakeDb();
    const kv = new MockKV();
    const env = envOf(db, kv);
    expect(await runDbInventory({ env, nowMs: Date.parse("2026-11-22T05:00:00Z") })).toEqual({ ran: false, reason: "not_inventory_hour" });
    expect(await runDbInventory({ env, nowMs: HOUR4, overBudget: true })).toEqual({ ran: false, reason: "over_budget" });
    kv.store.set(inventoryStampKey("2026-11-22"), "x");
    expect(await runDbInventory({ env, nowMs: HOUR4 })).toEqual({ ran: false, reason: "done_today" });
    kv.store.clear();
    kv.store.set(DB_INVENTORY_CLAIM_KEY, "x");
    expect(await runDbInventory({ env, nowMs: HOUR4 })).toEqual({ ran: false, reason: "claimed" });
    expect(log).toEqual([]);
  });
});

describe("run", () => {
  it("inventories bound stores, writes KV, agent_runs start + finalize and a telemetry agent_events row, stamps the day", async () => {
    const { db, log } = fakeDb({ dbstat: "ok" });
    const kv = new MockKV();
    const r = await runDbInventory({ env: envOf(db, kv, { AUDIT_DB: db }), nowMs: HOUR4, finalizeBackoffMs: [0], overloadBaseMs: 0 });
    expect(r).toMatchObject({ ran: true, status: "success", stores: ["core", "audit"], failed: [] });

    const inv = JSON.parse(kv.store.get(inventoryKey("core"))!);
    expect(inv.size_bytes).toBe(409600);
    expect(inv.size_source).toBe("pragma");
    expect(inv.dbstat).toBe("ok");
    expect(inv.tables[0]).toMatchObject({ name: "threats", rows_estimate: 1_600_000, rows_exact: false, bytes: 10000 });
    expect(inv.tables[1]).toMatchObject({ name: "brands", rows_estimate: 50, rows_exact: true, bytes: 500 });
    expect(parseSizeHistory(kv.store.get(sizeHistoryKey("core"))!)).toEqual([{ date: "2026-11-22", bytes: 409600 }]);
    expect(kv.store.get(inventoryStampKey("2026-11-22"))).toBeTruthy();

    const sqls = log.map((l) => l.sql);
    expect(sqls.some((s) => s.startsWith("INSERT INTO agent_runs"))).toBe(true);
    const runInsert = log.find((l) => l.sql.startsWith("INSERT INTO agent_runs"))!;
    expect(runInsert.binds[1]).toBe("db_inventory");
    expect(sqls.some((s) => /UPDATE agent_runs SET\s+status = \?/.test(s))).toBe(true);
    const ev = log.find((l) => l.sql.includes("INSERT INTO agent_events"))!;
    expect(ev.sql).toContain("'db_inventory_complete'");
    expect(ev.sql).toContain("NULL");
    expect(ev.sql).toContain("ON CONFLICT DO NOTHING");
    expect(ev.sql).not.toMatch(/OR IGNORE/);
    // Never a full scan of a large table.
    expect(sqls.some((s) => s.includes('COUNT(*) AS n FROM "threats"'))).toBe(false);
  });

  it("remembers a dbstat refusal (bytes null) and does not probe again", async () => {
    const kv = new MockKV();
    const a = fakeDb({ dbstat: "denied" });
    await runDbInventory({ env: envOf(a.db, kv), nowMs: HOUR4, finalizeBackoffMs: [0], overloadBaseMs: 0 });
    const inv = JSON.parse(kv.store.get(inventoryKey("core"))!);
    expect(inv.dbstat).toBe("denied");
    expect(inv.tables.every((t: { bytes: unknown }) => t.bytes === null)).toBe(true);

    kv.store.delete(inventoryStampKey("2026-11-22"));
    kv.store.delete(DB_INVENTORY_CLAIM_KEY);
    const b = fakeDb({ dbstat: "denied" });
    await runDbInventory({ env: envOf(b.db, kv), nowMs: HOUR4 + 600_000, finalizeBackoffMs: [0], overloadBaseMs: 0 });
    expect(b.log.some((l) => l.sql.includes("dbstat"))).toBe(false);
    expect(JSON.parse(kv.store.get(inventoryKey("core"))!).dbstat).toBe("skipped_denied_recently");
  });

  it("a store whose table list is unreadable fails the run partially and leaves the day unstamped", async () => {
    const kv = new MockKV();
    const good = fakeDb();
    const broken = {
      prepare: () => {
        const s = { bind: () => s, first: async () => { throw new Error("overloaded"); }, all: async () => { throw new Error("overloaded"); }, run: async () => ({}) };
        return s;
      },
    };
    const r = await runDbInventory({ env: envOf(good.db, kv, { AUDIT_DB: broken }), nowMs: HOUR4, finalizeBackoffMs: [0], overloadBaseMs: 0 });
    expect(r).toMatchObject({ ran: true, status: "partial", stores: ["core"], failed: ["audit"] });
    expect(kv.store.get(inventoryStampKey("2026-11-22"))).toBeUndefined();
    const fin = good.log.find((l) => /UPDATE agent_runs SET\s+status = \?/.test(l.sql))!;
    expect(fin.binds[0]).toBe("partial");
  });
});

describe("size history", () => {
  it("replaces the same date, keeps order, caps at 90", () => {
    let h = appendSizePoint([], { date: "2026-11-02", bytes: 2 });
    h = appendSizePoint(h, { date: "2026-11-01", bytes: 1 });
    h = appendSizePoint(h, { date: "2026-11-02", bytes: 3 });
    expect(h).toEqual([{ date: "2026-11-01", bytes: 1 }, { date: "2026-11-02", bytes: 3 }]);
    let long: Array<{ date: string; bytes: number }> = [];
    for (let i = 0; i < 100; i++) {
      long = appendSizePoint(long, { date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), bytes: i });
    }
    expect(long).toHaveLength(DB_SIZE_HISTORY_MAX_POINTS);
    expect(long[0]!.bytes).toBe(10);
  });

  it("parses defensively", () => {
    expect(parseSizeHistory(null)).toEqual([]);
    expect(parseSizeHistory("nope")).toEqual([]);
    expect(parseSizeHistory(JSON.stringify([{ date: "d", bytes: "x" }, { date: "e", bytes: 1 }]))).toEqual([{ date: "e", bytes: 1 }]);
  });
});
