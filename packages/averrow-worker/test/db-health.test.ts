/**
 * lib/db-health.ts — Databases page collector: status rules, growth fit,
 * label parsing, edge folding, fail-soft sections, composition.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildDatabasesBase,
  classifyStatus,
  composePayload,
  daysToCap,
  fetchEdges,
  fitGrowth,
  noteFor,
  parseDbWindow,
  parseEndpointLabel,
  getDatabasesPayload,
} from "../src/lib/db-health";
import { inventoryKey, sizeHistoryKey, type DbInventory } from "../src/lib/db-inventory";
import { D1_DB_CAP_BYTES } from "../src/lib/db-registry";
import type { Env } from "../src/types";

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

const GB = 1024 ** 3;

describe("fitGrowth / daysToCap", () => {
  it("needs at least 3 points", () => {
    expect(fitGrowth([])).toBeNull();
    expect(fitGrowth([{ date: "2026-11-01", bytes: 1 }, { date: "2026-11-02", bytes: 2 }])).toBeNull();
  });

  it("fits a linear slope in bytes/day from the dates, not the array index", () => {
    const h = [
      { date: "2026-11-01", bytes: 1000 },
      { date: "2026-11-03", bytes: 1200 }, // gap: still 100/day
      { date: "2026-11-04", bytes: 1300 },
    ];
    expect(fitGrowth(h)).toBe(100);
  });

  it("uses only the newest 14 points", () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, bytes: i < 6 ? 0 : 5000 }));
    expect(fitGrowth(flat)).toBe(0);
  });

  it("days to cap: null when not growing or unknown", () => {
    expect(daysToCap(5 * GB, 0, 10 * GB)).toBeNull();
    expect(daysToCap(5 * GB, -10, 10 * GB)).toBeNull();
    expect(daysToCap(null, 100, 10 * GB)).toBeNull();
    expect(daysToCap(5 * GB, GB / 10, 10 * GB)).toBe(50);
  });
});

describe("classifyStatus", () => {
  const base = { store: "core" as const, size_bytes: GB, cap_bytes: 10 * GB, days_to_cap: null, overloads_24h: 0, writes_cycle: 100 };
  it("healthy", () => {
    expect(classifyStatus(base)).toEqual({ status: "healthy", reasons: [] });
  });
  it("overloaded at >= 5 overloads, regardless of anything else", () => {
    expect(classifyStatus({ ...base, overloads_24h: 5, size_bytes: null }).status).toBe("overloaded");
  });
  it("warning on size >= 50% cap, days_to_cap < 180, 1..4 overloads, or zero writes on a write-expecting store", () => {
    expect(classifyStatus({ ...base, size_bytes: 5 * GB }).status).toBe("warning");
    expect(classifyStatus({ ...base, days_to_cap: 179 }).status).toBe("warning");
    expect(classifyStatus({ ...base, days_to_cap: 180 }).status).toBe("healthy");
    expect(classifyStatus({ ...base, overloads_24h: 1 }).status).toBe("warning");
    expect(classifyStatus({ ...base, overloads_24h: 4 }).status).toBe("warning");
    expect(classifyStatus({ ...base, store: "audit", writes_cycle: 0 }).reasons).toEqual(["No writes this billing cycle"]);
    // geo is written only on a MaxMind release — zero writes is fine.
    expect(classifyStatus({ ...base, store: "geo", writes_cycle: 0 }).status).toBe("healthy");
    // Unknown usage (null) is not "zero writes".
    expect(classifyStatus({ ...base, writes_cycle: null }).status).toBe("healthy");
  });
  it("unknown when size is null and nothing else warns", () => {
    expect(classifyStatus({ ...base, size_bytes: null, overloads_24h: null }).status).toBe("unknown");
  });
  it("audit note when the audit store had no writes", () => {
    expect(noteFor("audit", { writes_cycle: 0, size_bytes: 1, bound: true })).toBe("No writes this billing cycle — check the audit writer");
    expect(noteFor("geo", { writes_cycle: 0, size_bytes: 1, bound: false })).toBe("Not bound in this environment");
    expect(noteFor("core", { writes_cycle: 5, size_bytes: 1, bound: true })).toBeNull();
  });
});

describe("labels / window", () => {
  it("parses meter labels and folds :bg", () => {
    expect(parseEndpointLabel("agent:navigator")).toEqual({ kind: "agent", source: "navigator" });
    expect(parseEndpointLabel("agent:navigator:bg")).toEqual({ kind: "agent", source: "navigator" });
    expect(parseEndpointLabel("cron:7 * * * *:bg")).toEqual({ kind: "cron", source: "7 * * * *" });
    expect(parseEndpointLabel("feed:nrd_hagezi")).toEqual({ kind: "feed", source: "nrd_hagezi" });
    expect(parseEndpointLabel("workflow:nexus_run")).toEqual({ kind: "workflow", source: "nexus_run" });
    expect(parseEndpointLabel("observatory_nodes")).toEqual({ kind: "http", source: "observatory_nodes" });
  });
  it("window defaults to 24h and rejects unknown values", () => {
    expect(parseDbWindow(null)).toBe("24h");
    expect(parseDbWindow("cycle")).toBe("cycle");
    expect(parseDbWindow("7d")).toBeNull();
  });
});

describe("fetchEdges", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("folds :bg into its source per store and drops unknown stores", async () => {
    let body = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ data: [
        { endpoint: "agent:navigator", store: "core", rows_read: "100", rows_written: 1, queries: 3, overloads: 0 },
        { endpoint: "agent:navigator:bg", store: "core", rows_read: 50, rows_written: 0, queries: 1, overloads: 2 },
        { endpoint: "agent:navigator", store: "dnsq", rows_read: 7, rows_written: 7, queries: 1, overloads: 0 },
        { endpoint: "feed:x", store: "bogus", rows_read: 9, rows_written: 0, queries: 1, overloads: 0 },
      ] }), { status: 200 });
    }));
    const edges = await fetchEdges({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" } as unknown as Env, "1h", new Date("2026-11-22T10:30:00Z"));
    expect(body).toContain("toDateTime('2026-11-22 09:30:00')");
    expect(body).toContain("blob2 != ''");
    expect(edges).toEqual([
      { source: "navigator", kind: "agent", store: "core", rows_read: 150, rows_written: 1, queries: 4, overloads: 2 },
      { source: "navigator", kind: "agent", store: "dnsq", rows_read: 7, rows_written: 7, queries: 1, overloads: 0 },
    ]);
  });
});

describe("buildDatabasesBase — fail-soft", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function pragmaDb(pageCount: number): D1Database {
    return {
      prepare: (sql: string) => ({
        bind() { return this; },
        first: async () => {
          if (sql === "PRAGMA page_size") return { page_size: 4096 };
          if (sql === "PRAGMA page_count") return { page_count: pageCount };
          if (sql.includes("sqlite_master")) return { n: 12 };
          return null;
        },
        all: async () => ({ results: [] }),
      }),
    } as unknown as D1Database;
  }

  it("without CF credentials: sizes from PRAGMA, usage / overloads sections error, history + inventory from KV", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network expected"); }));
    const kv = new MockKV();
    kv.store.set(sizeHistoryKey("core"), JSON.stringify([
      { date: "2026-11-19", bytes: 1000 }, { date: "2026-11-20", bytes: 2000 }, { date: "2026-11-21", bytes: 3000 },
    ]));
    const inv: DbInventory = {
      store: "core", date: "2026-11-22", generated_at: "x", size_bytes: 1, size_source: "pragma", table_count: 2,
      tables: [
        { name: "threats", rows_estimate: 1_600_000, rows_exact: false, bytes: null, estimate_divergent: true },
        { name: "brands", rows_estimate: 114_000, rows_exact: false, bytes: null, estimate_divergent: false },
      ],
      dbstat: "skipped_large", read_errors: 0,
    };
    kv.store.set(inventoryKey("core"), JSON.stringify(inv));
    const env = { DB: pragmaDb(1000), AUDIT_DB: pragmaDb(10), CACHE: kv, ENVIRONMENT: "production" } as unknown as Env;
    const base = await buildDatabasesBase(env, new Date("2026-11-22T10:30:00Z"));

    expect(base.usage_6h_error).toMatch(/setup_required/);
    expect(base.usage_cycle_error).toMatch(/setup_required/);
    expect(base.hourly_error).toMatch(/setup_required/);
    expect(base.overloads_error).toMatch(/setup_required/);
    expect(base.sizes_error).toBeUndefined();

    const core = base.databases.find((d) => d.store === "core")!;
    expect(core.name).toBe("trust-radar-v2");
    expect(core.label).toBe("CORE");
    expect(core.size_bytes).toBe(4096 * 1000);
    expect(core.size_source).toBe("pragma");
    expect(core.cap_bytes).toBe(D1_DB_CAP_BYTES);
    expect(core.growth_bytes_per_day).toBe(1000);
    expect(core.size_history).toHaveLength(3);
    expect(core.reads_24h).toBeNull();
    expect(core.writes_cycle).toBeNull();
    expect(core.overloads_24h).toBeNull();
    expect(core.hourly).toEqual([]);
    expect(core.top_tables).toEqual([
      { name: "threats", rows_estimate: 1_600_000, bytes: null, estimate_divergent: true },
      { name: "brands", rows_estimate: 114_000, bytes: null },
    ]);
    expect(core.status).toBe("healthy");

    const geo = base.databases.find((d) => d.store === "geo")!;
    expect(geo.size_bytes).toBeNull();
    expect(geo.status).toBe("unknown");
    expect(geo.note).toBe("Not bound in this environment");

    expect(base.summary.live).toBe(4);
    expect(base.summary.proposed).toBe(2);
    expect(base.summary.total_bytes).toBe(4096 * 1010);
    expect(base.summary.overloads_24h).toBeNull();
    expect(base.summary.cycle_rows_read).toBeNull();
    expect(base.proposed.map((p) => p.name)).toEqual(["averrow-telemetry", "averrow-archive"]);
  });

  it("with CF data: per-database usage maps to stores, overloads drive status", async () => {
    const now = new Date("2026-11-22T10:30:00Z");
    const coreId = "a3776a5f-c07c-4e20-9f3b-8d7f8c7f90c6";
    const auditId = "55d58eff-47f3-4533-afa4-e52d494376e0";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (String(url).includes("/d1/database")) {
        return new Response(JSON.stringify({ success: true, result: [
          { uuid: coreId, file_size: 6 * GB, num_tables: 300 },
          { uuid: auditId, file_size: GB / 10, num_tables: 3 },
        ] }), { status: 200 });
      }
      if (String(url).includes("analytics_engine")) {
        return new Response(JSON.stringify({ data: [
          { hour: "2026-11-22 09:00:00", store: "core", overloads: 3 },
          { hour: "2026-11-22 10:00:00", store: "core", overloads: 3 },
        ] }), { status: 200 });
      }
      // GraphQL: hourly query groups by datetimeHour; the others by databaseId.
      const hourly = body.includes("datetimeHour databaseId");
      const groups = [coreId, auditId].map((id) => ({
        sum: { rowsRead: id === coreId ? 1000 : 0, rowsWritten: id === coreId ? 10 : 0, readQueries: 1, writeQueries: 1 },
        dimensions: hourly ? { datetimeHour: "2026-11-22T10:00:00Z", databaseId: id } : { databaseId: id },
      }));
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: groups }] } } }), { status: 200 });
    }));
    const env = {
      DB: pragmaDb(1), AUDIT_DB: pragmaDb(1), CACHE: new MockKV(), ENVIRONMENT: "production",
      CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a",
    } as unknown as Env;
    const base = await buildDatabasesBase(env, now);
    const core = base.databases.find((d) => d.store === "core")!;
    const audit = base.databases.find((d) => d.store === "audit")!;
    expect(core.size_source).toBe("cf_api");
    expect(core.reads_24h).toBe(1000);
    expect(core.writes_cycle).toBe(10);
    expect(core.overloads_24h).toBe(6);
    expect(core.status).toBe("overloaded");
    expect(core.hourly).toHaveLength(24);
    expect(core.hourly[23]).toEqual({ hour: "2026-11-22T10:00:00Z", rows_read: 1000, rows_written: 10, overloads: 3 });
    expect(audit.writes_cycle).toBe(0);
    expect(audit.overloads_24h).toBe(0);
    expect(audit.status).toBe("warning");
    expect(audit.note).toBe("No writes this billing cycle — check the audit writer");
    expect(base.summary.overloads_24h).toBe(6);
    expect(base.summary.largest_share_pct).toBeCloseTo(98.4, 1);
    expect(base.summary.cycle_rows_read).toBe(1000);
  });
});

describe("composePayload / getDatabasesPayload", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fills top_jobs per store (top 8) and reports an edges failure in-band", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const env = { DB: { prepare: () => ({ bind() { return this; }, first: async () => null, all: async () => ({ results: [] }) }) }, CACHE: new MockKV() } as unknown as Env;
    const p = await getDatabasesPayload(env, "1h");
    expect(p.window).toBe("1h");
    expect(p.edges).toEqual([]);
    expect(p.edges_error).toMatch(/setup_required/);
    expect(p.databases).toHaveLength(4);

    const edges = Array.from({ length: 10 }, (_, i) => ({
      source: `s${i}`, kind: "agent" as const, store: "core" as const, rows_read: i, rows_written: 0, queries: 1, overloads: 0,
    }));
    const composed = composePayload(p, "24h", edges);
    const core = composed.databases.find((d) => d.store === "core")!;
    expect(core.top_jobs.map((j) => j.source)).toEqual(["s9", "s8", "s7", "s6", "s5", "s4", "s3", "s2"]);
    expect(composed.databases.find((d) => d.store === "audit")!.top_jobs).toEqual([]);
    expect(composed.edges).toHaveLength(10);
  });
});
