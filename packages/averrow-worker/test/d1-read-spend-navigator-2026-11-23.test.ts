/**
 * D1 read spend — Navigator + diagnostics (2026-11-23).
 *
 * Prod evidence (diagnostics d1_attribution / sampled top queries,
 * 2026-11-23): `agent:navigator` read ~134M rows/24h (~483K per tick), most
 * of it in its page-load warms; diagnostics sections after the velocity
 * GROUP BY (~3.3M rows) kept failing "D1 DB is overloaded". Pins:
 *
 *   1. threat_cube_brand window reads group/count `+target_brand_id`, so the
 *      planner seeks the hour range on idx_cube_brand_hour instead of
 *      walking all of idx_cube_brand_id_hour (the whole cube, ~123K rows).
 *   2. Slow-moving brand aggregates got longer TTLs / their own caches.
 *   3. Navigator meters each warm phase under its own D1-meter label.
 *   4. The velocity block is computed off-request in rowid chunks and only
 *      read from KV by diagnostics; diagnostics retries an overload once.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, sqlContaining, type SqliteDb } from "./sqlite-d1-harness";
import {
  mergeVelocityGroups,
  computeVelocityGroupsChunked,
  runVelocityDiagRecount,
  readVelocityDiag,
  isVelocityDiagHour,
  foldVelocityDistribution,
  VELOCITY_DIAG_CACHE_KEY,
  VELOCITY_DIAG_CLAIM_KEY,
  VELOCITY_DIAG_TTL_S,
} from "../src/lib/velocity-diag";
import { diagOverloadRetrier, DIAG_OVERLOAD_RETRIES } from "../src/handlers/diagnostics";
import { navigatorWarmMeterLabel, runMeteredWarmPhase } from "../src/cron/navigator";
import { withD1Meter } from "../src/lib/d1-meter";
import { peekValue, seedValue } from "../src/lib/cached-value";
import { BRAND_AGGREGATE_TTL_S, BRAND_SLOW_AGGREGATE_TTL_S, BRAND_TYPOSQUAT_PRESSURE_TTL_S } from "../src/lib/brand-aggregates";
import {
  BRAND_SECTOR_MIX_TTL_S,
  BRAND_SECTOR_MIX_CACHE_KEY,
  BRANDS_UNDER_ATTACK_COUNT_KEY,
  BRANDS_UNDER_ATTACK_TTL_S,
} from "../src/handlers/brands";
import { THREATS_WEEK_TTL_S } from "../src/handlers/admin/health";
import type { Env } from "../src/types";

const read = (rel: string) => readFileSync(resolve(__dirname, "..", "src", rel), "utf8");

function plan(raw: SqliteDb, sql: string, binds: unknown[]): string {
  return (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");
}

// ─── 1. Brand-cube window plans ──────────────────────────────────────
describe("threat_cube_brand window reads seek the hour range", () => {
  it("every brand-cube window GROUP BY uses +target_brand_id", () => {
    const brands = read("handlers/brands.ts");
    // movers (14d), brand_stats top brand (1d), top-targeted (${since})
    expect(brands.match(/FROM threat_cube_brand\s+WHERE hour_bucket >= [^\n]+\n(?:\s*--[^\n]*\n)?\s*GROUP BY \+target_brand_id/g)?.length).toBe(3);
    expect(brands).not.toMatch(/FROM threat_cube_brand\s+WHERE hour_bucket >= [^\n]+\n\s*GROUP BY target_brand_id/);
    expect(read("handlers/trends.ts")).toMatch(/FROM threat_cube_brand\s+WHERE hour_bucket >= datetime\('now','-14 days'\)\s+GROUP BY \+target_brand_id/);
    // brand_stats top brand: a count tie is broken by id.
    expect(brands).toMatch(/GROUP BY \+target_brand_id\s+ORDER BY cnt DESC, target_brand_id\s+LIMIT 1/);
  });

  it("observatory stats' unfiltered brand DISTINCT counts +target_brand_id", () => {
    expect(read("handlers/observatory.ts"))
      .toContain('`SELECT COUNT(DISTINCT ${byBrand ? "" : "+"}target_brand_id) AS n FROM threat_cube_brand${');
  });

  describe.skipIf(!hasSqlite())("on the migrated schema", () => {
    let raw: SqliteDb;
    beforeAll(() => {
      raw = openMigratedDb();
      // ~300 days × 24 h of cube rows: the whole-index walk is ~25× the
      // 14-day window, as in prod.
      raw.exec("BEGIN");
      const s = raw.prepare(`INSERT INTO threat_cube_brand
        (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count, updated_at)
        VALUES (?, ?, 'phishing', 'high', 'phishtank', ?, datetime('now'))`);
      const base = Date.parse("2026-11-23T00:00:00Z");
      for (let h = 0; h < 300 * 24; h++) {
        const hb = `${new Date(base - h * 3_600_000).toISOString().slice(0, 13).replace("T", " ")}:00:00`;
        for (let b = 0; b < 3; b++) s.run(hb, `b${(h * 7 + b) % 400}`, 1 + (h % 3));
      }
      raw.exec("COMMIT");
      raw.exec("ANALYZE");
    }, 120_000);

    it("the movers CTE seeks idx_cube_brand_hour, the bare form walks idx_cube_brand_id_hour", () => {
      const movers = sqlContaining(read("handlers/brands.ts"), ["WITH inflow AS", "GROUP BY +target_brand_id", "AS today_count"]);
      expect(plan(raw, movers, [])).toMatch(/SEARCH threat_cube_brand USING INDEX idx_cube_brand_hour \(hour_bucket>\?\)/);
      const bare = movers.replace("GROUP BY +target_brand_id", "GROUP BY target_brand_id");
      expect(plan(raw, bare, [])).toMatch(/idx_cube_brand_id_hour/);
    });

    it("+target_brand_id returns the same groups as the bare column", () => {
      const sql = (g: string) => `SELECT target_brand_id, SUM(threat_count) AS cnt FROM threat_cube_brand
        WHERE hour_bucket >= '2026-11-09 00:00:00' GROUP BY ${g} ORDER BY target_brand_id`;
      expect(raw.prepare(sql("+target_brand_id")).all()).toEqual(raw.prepare(sql("target_brand_id")).all());
      const d = (x: string) => raw.prepare(`SELECT COUNT(DISTINCT ${x}) AS n FROM threat_cube_brand WHERE hour_bucket >= '2026-11-16 00:00:00'`).get();
      expect(d("+target_brand_id")).toEqual(d("target_brand_id"));
      // An hour-range seek (idx_cube_brand_hour in prod, or the
      // hour_bucket-leading PK index here) — never the whole-cube walk.
      const p = plan(raw, "SELECT COUNT(DISTINCT +target_brand_id) AS n FROM threat_cube_brand WHERE hour_bucket >= ?", ["2026-11-16 00:00:00"]);
      expect(p).toMatch(/SEARCH threat_cube_brand USING (COVERING )?INDEX \w+ \(hour_bucket>\?\)/);
      expect(p).not.toMatch(/idx_cube_brand_id_hour/);
    });
  });
});

// ─── 2. Slow-moving aggregates ───────────────────────────────────────
describe("brand aggregate / counter TTLs", () => {
  it("pressure 3h (below the 6h typosquat slice), composition/posture 6h", () => {
    expect(BRAND_AGGREGATE_TTL_S).toBe(10_800);
    expect(BRAND_TYPOSQUAT_PRESSURE_TTL_S).toBeGreaterThan(BRAND_AGGREGATE_TTL_S);
    expect(BRAND_SLOW_AGGREGATE_TTL_S).toBe(21_600);
  });

  it("brand_stats' sector mix is its own 6h cachedValue", () => {
    expect(BRAND_SECTOR_MIX_TTL_S).toBe(21_600);
    expect(read("handlers/brands.ts")).toMatch(
      /cachedValue<Array<\{ sector: string; count: number \}>>\(\s*env, BRAND_SECTOR_MIX_CACHE_KEY, BRAND_SECTOR_MIX_TTL_S,/,
    );
    expect(BRAND_SECTOR_MIX_CACHE_KEY).toBe("brand_stats.sector_mix");
  });

  it("brand_list's unscoped under_attack count is a 1h counter; scoped stays raw", () => {
    expect(BRANDS_UNDER_ATTACK_COUNT_KEY).toBe("count.brands.under_attack");
    expect(BRANDS_UNDER_ATTACK_TTL_S).toBe(3600);
    const src = read("handlers/brands.ts");
    expect(src).toMatch(/scopeFilter\.params\.length === 0\s+\? cachedCount\(env, BRANDS_UNDER_ATTACK_COUNT_KEY, BRANDS_UNDER_ATTACK_TTL_S,/);
    expect(src).toContain("AND target_brand_id IS NOT NULL ${scopeFilter.clause}");
  });

  it("system health's 7-day threat count lives 30 min", () => {
    expect(THREATS_WEEK_TTL_S).toBe(1800);
    expect(read("handlers/admin/health.ts")).toContain('cachedCount(env, "count.threats.week", THREATS_WEEK_TTL_S,');
  });

  it("platform_totals reads brands from the shared count.brands.total counter", () => {
    const diag = read("handlers/diagnostics.ts");
    expect(diag).toMatch(/const brands = await cachedCount\(env, 'count\.brands\.total', 3600,/);
    expect(diag).not.toContain("(SELECT COUNT(*) FROM brands) AS brands");
  });
});

// ─── 3. Navigator warm metering ──────────────────────────────────────
describe("Navigator meters each warm phase separately", () => {
  it("labels", () => {
    expect(navigatorWarmMeterLabel("A")).toBe("agent:navigator:warm_A");
    expect(navigatorWarmMeterLabel("D")).toBe("agent:navigator:warm_D");
  });
  it("an abandoned Phase D call's late reads land once, in warm_D:bg", async () => {
    // AE stub: rows_read per endpoint label.
    const rowsByLabel = new Map<string, number>();
    const AE = {
      writeDataPoint: (p: { blobs?: string[]; doubles?: number[] }) => {
        const label = String(p.blobs?.[0]);
        rowsByLabel.set(label, (rowsByLabel.get(label) ?? 0) + (p.doubles?.[0] ?? 0));
      },
    };
    const stmt = {
      bind: () => stmt,
      all: async () => ({ results: [], meta: { rows_read: 7, rows_written: 0 } }),
    };
    const DB = { prepare: () => stmt, batch: async () => [] };
    const env = { DB, AE, CACHE: fakeKv() } as unknown as Env;

    // The invocation ctx (what the cron runtime gives executeAgent).
    const pending: Promise<unknown>[] = [];
    const rootCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;

    // A warm that outlives its 20 ms timeout, then issues a metered read.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let lateReadDone = false;
    const target = {
      phase: "D" as const,
      path: "/api/brands/stats",
      consumer: "test",
      handler: async (_req: Request, e: Env) => {
        await gate;
        await e.DB.prepare("SELECT 1").all();
        lateReadDone = true;
        return new Response("{}");
      },
    };

    // executeAgent's layer around Navigator.
    const result = await withD1Meter(env, "agent:navigator", (navEnv, navCtx) =>
      runMeteredWarmPhase(navEnv, "D", [target], false,
        { callTimeoutMs: 20, budgetMs: 10_000, minRemainingMs: 0 }, navCtx!), rootCtx);
    expect(result.timedOut).toEqual(["/api/brands/stats"]);
    expect(lateReadDone).toBe(false);

    // The call finishes after the phase returned.
    release();
    for (let seen = 0; seen < pending.length;) {
      const batch = pending.slice(seen);
      seen = pending.length;
      await Promise.allSettled(batch);
    }
    expect(lateReadDone).toBe(true);
    expect(rowsByLabel.get("agent:navigator:warm_D:bg")).toBe(7);
    expect(rowsByLabel.get("agent:navigator:warm_D") ?? 0).toBe(0);
    expect(rowsByLabel.get("agent:navigator") ?? 0).toBe(0);
    expect(rowsByLabel.get("agent:navigator:bg") ?? 0).toBe(0);
  });
});

// ─── 4. velocity block off the request path ──────────────────────────
type Row = { flag: string | null; has_reg: number; n: number };
const sortRows = (r: Row[]) => [...r].sort((a, b) => `${a.flag}|${a.has_reg}`.localeCompare(`${b.flag}|${b.has_reg}`));

describe("velocity diagnostics block", () => {
  it("mergeVelocityGroups sums per (flag, has_reg), NULL distinct from any string", () => {
    expect(sortRows(mergeVelocityGroups([
      { flag: null, has_reg: 0, n: 5 }, { flag: "fast", has_reg: 1, n: 2 },
      { flag: null, has_reg: 0, n: 3 }, { flag: "fast", has_reg: 1, n: 1 }, { flag: null, has_reg: 1, n: 4 },
    ]))).toEqual(sortRows([
      { flag: null, has_reg: 0, n: 8 }, { flag: "fast", has_reg: 1, n: 3 }, { flag: null, has_reg: 1, n: 4 },
    ]));
  });

  it("isVelocityDiagHour: UTC 05 and 17 only", () => {
    expect(isVelocityDiagHour(Date.parse("2026-11-23T05:00:00Z"))).toBe(true);
    expect(isVelocityDiagHour(Date.parse("2026-11-23T17:55:00Z"))).toBe(true);
    expect(isVelocityDiagHour(Date.parse("2026-11-23T04:59:00Z"))).toBe(false);
  });

  it("diagnostics no longer runs the GROUP BY; it reads KV", () => {
    const diag = read("handlers/diagnostics.ts");
    expect(diag).not.toMatch(/GROUP BY weaponization_flag/);
    expect(diag).toMatch(/const entry = await readVelocityDiag\(env\);\s+if \(!entry\) throw new Error\(VELOCITY_DIAG_PENDING_ERROR\);/);
    const nav = read("cron/navigator.ts");
    expect(nav).toMatch(/if \(isVelocityDiagHour\(scheduledTime\.getTime\(\)\)\) \{\s+_ctx\.waitUntil\(\s+runVelocityDiagRecount\(\{ env, nowMs: scheduledTime\.getTime\(\), overBudget: skipNonEssential \}\)/);
  });

  describe.skipIf(!hasSqlite())("chunked walk on the migrated schema", () => {
    let raw: SqliteDb;
    beforeAll(() => {
      raw = openMigratedDb();
      raw.exec("BEGIN");
      const s = raw.prepare(`INSERT INTO threats (id, created_at, first_seen, status, severity, threat_type, source_feed,
          malicious_domain, weaponization_flag, domain_created_at)
        VALUES (?, '2026-11-01 00:00:00', '2026-11-01 00:00:00', 'active', 'high', 'phishing', 'x', ?, ?, ?)`);
      const flags = [null, "very_fast", "fast", "normal", null, null];
      for (let i = 0; i < 1_234; i++) {
        s.run(`t${i}`, `h${i}.example`, flags[i % flags.length] ?? null, i % 4 === 0 ? null : "2026-10-30 00:00:00");
      }
      raw.exec("COMMIT");
    }, 120_000);

    it("equals the single GROUP BY for any chunk size", async () => {
      const single = raw.prepare(`SELECT weaponization_flag AS flag,
          CASE WHEN domain_created_at IS NULL THEN 0 ELSE 1 END AS has_reg, COUNT(*) AS n
        FROM threats GROUP BY weaponization_flag, has_reg`).all() as Row[];
      const db = d1FromSqlite(raw);
      for (const chunkRows of [1, 97, 500, 10_000]) {
        const chunked = await computeVelocityGroupsChunked(db, { chunkRows, pauseMs: 0 });
        expect(sortRows(chunked)).toEqual(sortRows(single));
      }
    });

    it("runVelocityDiagRecount gates, claims, seeds; readVelocityDiag reads it back", async () => {
      const kv = fakeKv();
      const env = { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env;
      const at5 = Date.parse("2026-11-23T05:00:00Z");
      expect(await runVelocityDiagRecount({ env, nowMs: Date.parse("2026-11-23T06:00:00Z") })).toEqual({ ran: false, reason: "not_recount_hour" });
      expect(await runVelocityDiagRecount({ env, nowMs: at5, overBudget: true })).toEqual({ ran: false, reason: "over_budget" });
      expect(await readVelocityDiag(env)).toBeNull();

      const r = await runVelocityDiagRecount({ env, nowMs: at5, pauseMs: 0, chunkRows: 300 });
      expect(r).toMatchObject({ ran: true, total: 1_234 });
      expect(kv.store.has(VELOCITY_DIAG_CLAIM_KEY)).toBe(true);
      const stored = await readVelocityDiag(env);
      expect(stored?.value.total).toBe(1_234);
      expect(stored?.value.coverage.candidates_total).toBe(1_234 - Math.ceil(1_234 / 4));

      // A fresh block is not recomputed.
      expect(await runVelocityDiagRecount({ env, nowMs: at5 })).toEqual({ ran: false, reason: "fresh" });
    });

    it("another tick's claim stops a second walk", async () => {
      const kv = fakeKv({ [VELOCITY_DIAG_CLAIM_KEY]: "x" });
      const env = { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env;
      expect(await runVelocityDiagRecount({ env, nowMs: Date.parse("2026-11-23T17:05:00Z") })).toEqual({ ran: false, reason: "claimed" });
    });

    it("a D1 error stores nothing and never throws", async () => {
      const kv = fakeKv();
      const env = {
        DB: { prepare: () => { throw new Error("D1_ERROR: D1 DB is overloaded."); } },
        CACHE: kv,
      } as unknown as Env;
      const r = await runVelocityDiagRecount({ env, nowMs: Date.parse("2026-11-23T05:00:00Z") });
      expect(r).toMatchObject({ ran: false, reason: "error" });
      expect(await readVelocityDiag(env)).toBeNull();
    });
  });

  it("readVelocityDiag honours the 26h servable window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-11-23T05:00:00Z"));
      const env = { CACHE: fakeKv() };
      await seedValue(env, VELOCITY_DIAG_CACHE_KEY, foldVelocityDistribution([{ flag: "fast", has_reg: 1, n: 2 }]), VELOCITY_DIAG_TTL_S);
      vi.setSystemTime(Date.parse("2026-11-23T05:00:00Z") + (VELOCITY_DIAG_TTL_S - 60) * 1000);
      expect((await readVelocityDiag(env))?.value.total).toBe(2);
      vi.setSystemTime(Date.parse("2026-11-23T05:00:00Z") + (VELOCITY_DIAG_TTL_S + 60) * 1000);
      expect(await readVelocityDiag(env)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("peekValue", () => {
  it("never computes; null for absent / malformed", async () => {
    const env = { CACHE: fakeKv({ "cv:bad": "{not json", "cv:nov": JSON.stringify({ t: Date.now() }) }) };
    expect(await peekValue(env, "absent", 60)).toBeNull();
    expect(await peekValue(env, "bad", 60)).toBeNull();
    expect(await peekValue(env, "nov", 60)).toBeNull();
    await seedValue(env, "ok", { a: 1 }, 60);
    expect((await peekValue<{ a: number }>(env, "ok", 60))?.v).toEqual({ a: 1 });
    expect(await peekValue(env, "ok", 0)).toBeNull();
  });
});

// ─── 5. diagnostics overload retry ──────────────────────────────────
describe("diagOverloadRetrier", () => {
  const overload = () => new Error("D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.");

  it("retries an overload once after the delay, sharing the per-request budget", async () => {
    const waits: number[] = [];
    const retry = diagOverloadRetrier(2, 10_500, async (ms) => { waits.push(ms); });
    let calls = 0;
    const flaky = async () => { calls++; if (calls % 2 === 1) throw overload(); return "ok"; };
    expect(await retry(flaky)).toBe("ok");
    expect(await retry(flaky)).toBe("ok");
    // Budget spent: the third overload surfaces.
    await expect(retry(async () => { throw overload(); })).rejects.toThrow(/overloaded/);
    expect(waits).toEqual([10_500, 10_500]);
  });

  it("does not retry other errors, nor a second overload of the same call", async () => {
    const waits: number[] = [];
    const retry = diagOverloadRetrier(DIAG_OVERLOAD_RETRIES, 1, async (ms) => { waits.push(ms); });
    await expect(retry(async () => { throw new Error("no such table: x"); })).rejects.toThrow(/no such table/);
    expect(waits).toEqual([]);
    let n = 0;
    await expect(retry(async () => { n++; throw overload(); })).rejects.toThrow(/overloaded/);
    expect(n).toBe(2);
  });

  it("wraps every diagnostics section", () => {
    expect(read("handlers/diagnostics.ts"))
      .toContain("softSection(sectionErrors, section, fallback, () => overloadRetry(fn));");
  });
});

// ─── 6. hosting_providers count sync (orchestrator hour % 4 === 0) ───
import { PROVIDER_COUNTS_UPSERT_SQL, PROVIDER_COUNTS_ZERO_SQL, syncHostingProviderCounts } from "../src/lib/provider-counts";

const OLD_PROVIDER_SYNC_SQL = `UPDATE hosting_providers SET
       active_threat_count = (SELECT COUNT(*) FROM threats WHERE threats.hosting_provider_id = hosting_providers.id AND threats.status = 'active'),
       total_threat_count = (SELECT COUNT(*) FROM threats WHERE threats.hosting_provider_id = hosting_providers.id)
     WHERE active_threat_count IS NOT (SELECT COUNT(*) FROM threats WHERE threats.hosting_provider_id = hosting_providers.id AND threats.status = 'active')
       OR total_threat_count IS NOT (SELECT COUNT(*) FROM threats WHERE threats.hosting_provider_id = hosting_providers.id)`;

describe.skipIf(!hasSqlite())("syncHostingProviderCounts — one grouped pass, same values", () => {
  function seeded(): SqliteDb {
    const raw = openMigratedDb();
    raw.exec("BEGIN");
    const p = raw.prepare("INSERT INTO hosting_providers (id, name, active_threat_count, total_threat_count) VALUES (?, ?, ?, ?)");
    // p0..p5 have threats; p6/p7 stale non-zero, p8 already 0 — the last three have none.
    const stored: Array<[number, number]> = [[0, 0], [5, 5], [2, 2], [1, 9], [3, 3], [0, 4], [7, 7], [0, 3], [0, 0]];
    stored.forEach(([a, t], i) => p.run(`p${i}`, `Provider ${i}`, a, t));
    const t = raw.prepare(`INSERT INTO threats (id, created_at, first_seen, status, severity, threat_type, source_feed, malicious_domain, hosting_provider_id)
      VALUES (?, '2026-11-01 00:00:00', '2026-11-01 00:00:00', ?, 'high', 'phishing', 'x', ?, ?)`);
    for (let i = 0; i < 600; i++) {
      t.run(`t${i}`, i % 3 === 0 ? "remediated" : "active", `h${i}.example`, i % 10 < 6 ? `p${i % 6}` : null);
    }
    raw.exec("COMMIT");
    return raw;
  }
  const snapshot = (raw: SqliteDb) => raw.prepare("SELECT id, active_threat_count, total_threat_count FROM hosting_providers ORDER BY id").all();

  it("writes exactly what the correlated-subquery form wrote", async () => {
    const oldDb = seeded();
    const oldChanges = (oldDb.prepare(OLD_PROVIDER_SYNC_SQL).run() as { changes: number | bigint }).changes;
    const newDb = seeded();
    const n = await syncHostingProviderCounts({ DB: d1FromSqlite(newDb) } as unknown as Env);
    expect(snapshot(newDb)).toEqual(snapshot(oldDb));
    expect(n).toBe(Number(oldChanges));
    // Idempotent: a second run changes nothing.
    expect(await syncHostingProviderCounts({ DB: d1FromSqlite(newDb) } as unknown as Env)).toBe(0);
  });

  it("the grouped pass reads threats once through a provider index", () => {
    const raw = seeded();
    const p = plan(raw, PROVIDER_COUNTS_UPSERT_SQL, []);
    expect(p).toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_provider\w* \(hosting_provider_id>\?\)/);
    expect(p).not.toMatch(/CORRELATED SCALAR SUBQUERY/);
    expect(plan(raw, PROVIDER_COUNTS_ZERO_SQL, [])).toMatch(/idx_threats_provider/);
  });
});
