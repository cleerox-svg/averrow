/**
 * threatAggregate — unfiltered slice reads pre-computed leaderboards.
 *
 * 2026-11-08 D1 overload follow-up. For the unfiltered, unscoped slice
 * (`where` empty, no actor_id) top_providers reads
 * hosting_providers.total_threat_count and top_brands reads
 * brands.threat_count instead of a ~1.84M-row GROUP BY over threats. Every
 * filtered / scoped slice keeps the exact GROUP BY. The counters are seeded
 * DIFFERENT from the raw rows here so the test can tell which source a
 * slice used. Also pins: reads go through the passed read session, and the
 * unfiltered refill takes the single-flight lock.
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
} from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import {
  threatAggregate,
  THREAT_AGGREGATE_DEGRADED_TTL_S,
  THREAT_AGGREGATE_UNFILTERED_TTL_S,
} from "../src/lib/threat-aggregates";

const TABLES = [
  "threats", "brands", "hosting_providers", "campaigns",
  "threat_actors", "threat_actor_infrastructure", "threat_cube_status",
];

function seed() {
  const db = openDerivedDb(TABLES, { indexes: ["idx_threats_created_brand"] });
  // Raw rows: b1×2 / b2×1, p1×2 / p2×1. Counters say otherwise on purpose.
  db.exec(`INSERT INTO brands (id, name, canonical_domain, logo_url, threat_count) VALUES
             ('b1', 'Brand One', 'b1.example', NULL, 500),
             ('b2', 'Brand Two', 'b2.example', 'https://logo/b2.png', 900),
             ('b3', 'Brand Zero', 'b3.example', NULL, 0)`);
  db.exec(`INSERT INTO hosting_providers (id, name, asn, total_threat_count) VALUES
             ('p1', 'Prov One', 'AS100', 40),
             ('p2', 'Prov Two', 'AS200', 70),
             ('p3', 'Prov Zero', 'AS300', 0)`);
  const ins = db.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, target_brand_id,
                          hosting_provider_id, status, severity, created_at, first_seen)
     VALUES (?, 'feedA', 'phishing', ?, ?, ?, ?, 'high', ?, ?)`,
  );
  const ts = sqliteTimestampHoursAgo(2);
  ins.run("t1", "a.com", "b1", "p1", "active", ts, ts);
  ins.run("t2", "b.com", "b1", "p1", "down", ts, ts);
  ins.run("t3", "c.com", "b2", "p2", "active", ts, ts);
  return db;
}

const byKey = <T,>(rows: T[], k: (r: T) => string, v: (r: T) => unknown) =>
  Object.fromEntries(rows.map((r) => [k(r), v(r)]));

describe.skipIf(!hasSqlite())("threatAggregate unfiltered slice — pre-computed leaderboards", () => {
  it("unfiltered top_providers / top_brands come from the pre-computed columns, same shape", async () => {
    const env = { DB: d1FromSqlite(seed()), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {});
    expect(agg.top_providers).toEqual([
      { provider_id: "p2", name: "Prov Two", asn: "AS200", count: 70 },
      { provider_id: "p1", name: "Prov One", asn: "AS100", count: 40 },
    ]);
    expect(agg.top_brands).toEqual([
      { brand_id: "b2", brand_name: "Brand Two", canonical_domain: "b2.example", logo_url: "https://logo/b2.png", count: 900 },
      { brand_id: "b1", brand_name: "Brand One", canonical_domain: "b1.example", logo_url: null, count: 500 },
    ]);
    // Everything without an exact pre-computed source still reads threats.
    expect(agg.total).toBe(3);
    expect(byKey(agg.by_status, (r) => r.status, (r) => r.count)).toEqual({ active: 2, down: 1 });
  });

  it("unfiltered slice runs no GROUP BY for the provider / brand leaderboards", async () => {
    const log: StatementLogEntry[] = [];
    const env = { DB: d1FromSqlite(seed(), { log }), CACHE: fakeKv() } as unknown as Env;
    await threatAggregate(env, {});
    const sqls = log.map((e) => e.sql.replace(/\s+/g, " "));
    expect(sqls.some((q) => /GROUP BY t\.hosting_provider_id, hp\.name, hp\.asn ORDER BY count DESC/.test(q))).toBe(false);
    expect(sqls.some((q) => /GROUP BY t\.target_brand_id, b\.name/.test(q))).toBe(false);
    expect(sqls.some((q) => /FROM hosting_providers hp WHERE hp\.total_threat_count > 0/.test(q))).toBe(true);
  });

  for (const [name, filters, scope] of [
    ["status filter", { status: "active" }, null],
    ["actor filter", { actor_id: "ta-none" }, null],
    ["org scope", {}, { org_id: 1, brand_ids: ["b1", "b2"] }],
  ] as const) {
    it(`${name}: keeps the exact GROUP BY over the slice`, async () => {
      const env = { DB: d1FromSqlite(seed()), CACHE: fakeKv() } as unknown as Env;
      const agg = await threatAggregate(env, { ...filters }, scope ? { ...scope, brand_ids: [...scope.brand_ids] } : null);
      if (name === "status filter") {
        expect(byKey(agg.top_providers, (r) => r.provider_id, (r) => r.count)).toEqual({ p1: 1, p2: 1 });
        expect(byKey(agg.top_brands, (r) => r.brand_id, (r) => r.count)).toEqual({ b1: 1, b2: 1 });
      } else if (name === "org scope") {
        expect(byKey(agg.top_providers, (r) => r.provider_id, (r) => r.count)).toEqual({ p1: 2, p2: 1 });
        expect(byKey(agg.top_brands, (r) => r.brand_id, (r) => r.count)).toEqual({ b1: 2, b2: 1 });
      } else {
        expect(agg.top_providers).toEqual([]);   // no actor infra → empty slice
        expect(agg.top_brands).toEqual([]);
      }
    });
  }

  it("reads go through the passed read session, never env.DB", async () => {
    const throwing = new Proxy({}, { get() { throw new Error("env.DB must not be read"); } });
    const env = { DB: throwing, CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {}, null, d1FromSqlite(seed()));
    expect(agg.total).toBe(3);
    const filtered = await threatAggregate(env, { status: "down" }, null, d1FromSqlite(seed()));
    expect(filtered.total).toBe(1);
  });

  it("unfiltered refill takes and releases the single-flight lock; filtered slices don't", async () => {
    const kv = fakeKv();
    const puts: string[] = [];
    const origPut = kv.put.bind(kv);
    kv.put = (async (k: string, v: string) => { puts.push(k); return origPut(k, v); }) as typeof kv.put;
    const env = { DB: d1FromSqlite(seed()), CACHE: kv } as unknown as Env;

    await threatAggregate(env, {});
    expect(puts.some((k) => k.startsWith("cvlock:threat-agg:global"))).toBe(true);
    expect([...kv.store.keys()].some((k) => k.startsWith("cvlock:"))).toBe(false); // released

    puts.length = 0;
    await threatAggregate(env, { status: "active" });
    expect(puts.some((k) => k.startsWith("cvlock:"))).toBe(false);
  });
});

// ─── Fail-soft sections + surge index pin (2026-11-09) ────────────────
//
// Prod: while D1 threw `D1 DB is overloaded`, any one of nine un-caught
// reads rejected the whole compute, so nothing was cached and every page
// view / Retry re-ran the full ~15-read refill. Now each read is a
// softSection: one failure degrades that section only, is listed in
// `degraded_sections`. A degraded result never replaces a complete cached
// entry (that one is kept and re-stamped for the 60s back-off); with no
// complete entry (cold key) the degraded result is cached for that short TTL.

/** A D1 whose prepare() throws for any SQL matching `fail`. */
function failingDb(base: D1Database, fail: (sql: string) => boolean): D1Database {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (fail(sql)) throw new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window");
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Age (s) the cached entry is stamped with — cachedValue stamps a short-TTL entry as pre-aged. */
function cachedAgeSeconds(kv: { store: Map<string, string> }): number {
  const raw = [...kv.store.entries()].find(([k]) => k.startsWith("cv:threat-agg:"))?.[1];
  if (!raw) throw new Error("no cached threat-agg entry");
  const entry = JSON.parse(raw) as { t: number };
  return (Date.now() - entry.t) / 1000;
}

const isByType = (sql: string) => /GROUP BY t\.threat_type ORDER BY count DESC LIMIT 8/.test(sql.replace(/\s+/g, " "));
/** surging_types — a section the unfiltered slice still reads per refill (by_type comes from the base scan there). */
const isSurgeTypes = (sql: string) => sql.includes("t.threat_type AS label");

describe.skipIf(!hasSqlite())("threatAggregate fail-soft sections", () => {
  it("healthy compute: degraded_sections is empty and the entry gets the full slice TTL", async () => {
    const kv = fakeKv();
    const env = { DB: d1FromSqlite(seed()), CACHE: kv } as unknown as Env;
    const agg = await threatAggregate(env, {});
    expect(agg.degraded_sections).toEqual([]);
    expect(cachedAgeSeconds(kv)).toBeLessThan(5);
  });

  it("one failing section → partial result, degraded_sections names it, cached for the short TTL", async () => {
    const kv = fakeKv();
    const env = { DB: failingDb(d1FromSqlite(seed()), isSurgeTypes), CACHE: kv } as unknown as Env;
    const agg = await threatAggregate(env, {});
    expect(agg.degraded_sections).toEqual(["surging_types"]);
    expect(agg.surging_signals).toEqual([]);
    // Every other section still has its real data.
    expect(agg.total).toBe(3);
    expect(agg.by_type).toEqual([{ type: "phishing", count: 3 }]);
    expect(byKey(agg.by_status, (r) => r.status, (r) => r.count)).toEqual({ active: 2, down: 1 });
    expect(agg.top_providers.length).toBe(2);
    // Stamped as written (unfiltered TTL − degraded TTL) ago → expires after ~60s.
    const age = cachedAgeSeconds(kv);
    const expected = THREAT_AGGREGATE_UNFILTERED_TTL_S - THREAT_AGGREGATE_DEGRADED_TTL_S;
    expect(age).toBeGreaterThanOrEqual(expected - 1);
    expect(age).toBeLessThan(expected + 5);
  });

  it("a failing headline degrades to zeros without failing the response", async () => {
    const env = {
      DB: failingDb(d1FromSqlite(seed()), (sql) => sql.includes("AS correlated_by_campaign")),
      CACHE: fakeKv(),
    } as unknown as Env;
    const agg = await threatAggregate(env, { status: "active" });
    expect(agg.degraded_sections).toEqual(["headline"]);
    expect(agg.total).toBe(0);
    expect(byKey(agg.by_status, (r) => r.status, (r) => r.count)).toEqual({ active: 2 });
  });

  it("section error messages are logged (warn), never returned in the response", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const env = { DB: failingDb(d1FromSqlite(seed()), isByType), CACHE: fakeKv() } as unknown as Env;
      const agg = await threatAggregate(env, { status: "active" });
      expect(warn).toHaveBeenCalledWith("threat_aggregate_sections_degraded", expect.objectContaining({
        sections: ["by_type"],
        errors: { by_type_error: expect.stringContaining("D1 DB is overloaded") },
      }));
      expect(JSON.stringify(agg)).not.toContain("overloaded");
    } finally {
      warn.mockRestore();
    }
  });

  it("every section failing logs at error level", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const env = { DB: failingDb(d1FromSqlite(seed()), () => true), CACHE: fakeKv() } as unknown as Env;
      await expect(threatAggregate(env, {})).rejects.toThrow(/every section failed/);
      expect(error).toHaveBeenCalledWith("threat_aggregate_sections_degraded", expect.any(Object));
    } finally {
      error.mockRestore();
    }
  });

  it("unfiltered: a degraded refill keeps a 4h-old good entry and backs off 60s (next request is a cache hit)", async () => {
    const kv = fakeKv();
    const good = await threatAggregate({ DB: d1FromSqlite(seed()), CACHE: kv } as unknown as Env, {});
    expect(good.degraded_sections).toEqual([]);
    const [key, raw] = [...kv.store.entries()].find(([k]) => k.startsWith("cv:threat-agg:"))!;
    const writtenAt = Date.now() - 4 * 3600 * 1000;
    kv.store.set(key, JSON.stringify({ ...JSON.parse(raw), t: writtenAt }));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      let prepares = 0;
      const counting = failingDb(d1FromSqlite(seed()), (sql) => { prepares++; return isSurgeTypes(sql); });
      const env = { DB: counting, CACHE: kv } as unknown as Env;
      const agg = await threatAggregate(env, {});
      expect(agg.degraded_sections).toEqual([]);
      expect(agg.surging_signals).toEqual(good.surging_signals);
      expect(good.surging_signals.length).toBeGreaterThan(0);
      expect(prepares).toBeGreaterThan(0);
      // Kept value re-stamped fresh for the degraded back-off; original write time in `w`.
      const kept = JSON.parse(kv.store.get(key)!) as { v: { by_type: unknown }; t: number; w: number };
      expect(kept.v.by_type).toEqual(good.by_type);
      expect(kept.w).toBe(writtenAt);
      const age = (Date.now() - kept.t) / 1000;
      expect(age).toBeGreaterThanOrEqual(THREAT_AGGREGATE_UNFILTERED_TTL_S - THREAT_AGGREGATE_DEGRADED_TTL_S - 1);
      expect(age).toBeLessThan(THREAT_AGGREGATE_UNFILTERED_TTL_S - THREAT_AGGREGATE_DEGRADED_TTL_S + 5);
      // The next request inside the back-off is served from KV: zero D1 reads.
      prepares = 0;
      const again = await threatAggregate(env, {});
      expect(again.by_type).toEqual(good.by_type);
      expect(prepares).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("filtered slice: a degraded refill keeps an expired good entry instead of caching zeros", async () => {
    const kv = fakeKv();
    const filters = { status: "active" };
    const good = await threatAggregate({ DB: d1FromSqlite(seed()), CACHE: kv } as unknown as Env, filters);
    const [key, raw] = [...kv.store.entries()].find(([k]) => k.startsWith("cv:threat-agg:"))!;
    kv.store.set(key, JSON.stringify({ ...JSON.parse(raw), t: Date.now() - 45 * 60 * 1000 })); // past the 30 min TTL
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const env = { DB: failingDb(d1FromSqlite(seed()), isByType), CACHE: kv } as unknown as Env;
      const agg = await threatAggregate(env, filters);
      expect(agg.degraded_sections).toEqual([]);
      expect(agg.by_type).toEqual(good.by_type);
      expect((JSON.parse(kv.store.get(key)!) as { v: { degraded_sections: string[] } }).v.degraded_sections).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("every section failing throws and caches nothing", async () => {
    const kv = fakeKv();
    const env = { DB: failingDb(d1FromSqlite(seed()), () => true), CACHE: kv } as unknown as Env;
    await expect(threatAggregate(env, {})).rejects.toThrow(/every section failed/);
    expect([...kv.store.keys()].some((k) => k.startsWith("cv:threat-agg:"))).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("threatAggregate surge queries pin idx_threats_created_brand", () => {
  const surgeSqls = async (): Promise<string[]> => {
    const log: StatementLogEntry[] = [];
    const env = { DB: d1FromSqlite(seed(), { log }), CACHE: fakeKv() } as unknown as Env;
    const agg = await threatAggregate(env, {});
    expect(agg.degraded_sections).toEqual([]);   // pinned SQL is valid against the schema
    return log.map((e) => e.sql).filter((q) => q.includes("AS previous_7d"));
  };

  it("surging_types and surging_campaigns SQL carry INDEXED BY idx_threats_created_brand", async () => {
    const sqls = await surgeSqls();
    expect(sqls.length).toBe(2);
    for (const q of sqls) {
      expect(q.replace(/\s+/g, " ")).toContain("FROM threats t INDEXED BY idx_threats_created_brand");
    }
  });

  it("the pinned index exists in the migrations and gives a created_at range SEARCH", async () => {
    const db = openMigratedDb();
    for (const q of await surgeSqls()) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as Array<{ detail: string }>;
      const details = plan.map((r) => r.detail).join(" | ");
      expect(details).toMatch(/SEARCH t USING (COVERING )?INDEX idx_threats_created_brand \(created_at>\?\)/);
      expect(details).not.toMatch(/idx_threats_type/);
    }
  });
});
