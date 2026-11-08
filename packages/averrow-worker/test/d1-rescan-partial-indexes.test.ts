// Pins for the 2026-11-08 repeated full-table reads (migration 0322 + the
// query rewrites that go with it). Every plan is checked on the
// migration-replayed schema (openMigratedDb), every rewrite against the
// query it replaced on the same fixture.
//
//   1. FC latest run per agent      — LATEST_RUN_PER_AGENT_SQL, seeks idx_agent_runs_agent per agent
//   2. FC backlog.total_no_geo      — bounded probe on idx_threats_active_no_geo
//   3. Cartographer without_provider — idx_threats_ip_no_provider
//   4. SURBL feed SELECT + FC count  — idx_threats_surbl_pending (shared WHERE)
//   5. Cartographer top_countries   — KV-cached per period + provider set
//   6. Dark web / app store totals  — count.monitored_brands.joined (monitored_brands-driven)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import {
  ACTIVE_NO_GEO_SQL,
  IP_NO_PROVIDER_SQL,
  SURBL_PENDING_SQL,
  NO_GEO_PROBE_CAP,
  TOTAL_NO_GEO_PROBE_SQL,
  SURBL_BACKLOG_COUNT_SQL,
  SURBL_WORK_SELECT_SQL,
  THREATS_WITHOUT_PROVIDER_COUNT_SQL,
  noGeoProbeLabel,
} from "../src/lib/threat-rescan-predicates";
import { LATEST_RUN_PER_AGENT_SQL } from "../src/agents/flightControl";
import {
  providerCountriesForPeriod,
  providerCountriesCacheKey,
  PROVIDER_COUNTRIES_TTL_S,
} from "../src/agents/cartographer";
import {
  MONITORED_BRANDS_JOINED_COUNT_SQL,
  MONITORED_BRANDS_JOINED_KEY,
  countMonitoredBrandRows,
} from "../src/lib/monitored-brands-count";
import { stripIndexedBy, withIndexHintFallback } from "../src/lib/indexed-by-fallback";
import type { Env } from "../src/types";

const MIGRATION = "0322_d1_rescan_partial_indexes.sql";
const SRC = resolve(__dirname, "..", "src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const plan = (raw: SqliteDb, sql: string, ...binds: unknown[]): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");

const count = (raw: SqliteDb, sql: string): number => {
  const row = raw.prepare(sql).get() as Record<string, number>;
  return Number(Object.values(row)[0]);
};

// ── Legacy queries, verbatim from master before this change ─────────────
const LEGACY_NO_GEO = `SELECT COUNT(*) as count FROM threats
      WHERE (lat IS NULL OR lng IS NULL)
      AND status = 'active'`;
const LEGACY_NO_PROVIDER = "SELECT COUNT(*) as n FROM threats WHERE hosting_provider_id IS NULL AND ip_address IS NOT NULL";
const LEGACY_SURBL_SELECT = `SELECT DISTINCT malicious_domain FROM threats
      WHERE surbl_checked = 0
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND created_at > datetime('now', '-7 days')
      LIMIT 200`;
const LEGACY_LATEST_RUN = `SELECT agent_id, status as last_run_status, started_at as last_run_at,
        completed_at as last_completed_at, duration_ms
      FROM agent_runs ar1
      WHERE started_at = (SELECT MAX(started_at) FROM agent_runs ar2 WHERE ar2.agent_id = ar1.agent_id)
      AND agent_id IN (?, ?, ?, ?)`;
const LEGACY_MONITORED_JOIN = "SELECT COUNT(*) AS n FROM brands b INNER JOIN monitored_brands mb ON mb.brand_id = b.id";

/** Mixed threats fixture covering every branch of the three predicates. */
function seedThreats(raw: SqliteDb): void {
  const ins = raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, ip_address, hosting_provider_id,
       lat, lng, status, surbl_checked, created_at, first_seen)
     VALUES (?, 'feed', 'phishing', ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`,
  );
  let n = 0;
  for (const domain of ["a.example", "b.example", "", null]) {
    for (const ip of ["203.0.113.5", null]) {
      for (const provider of ["prov1", null]) {
        for (const [lat, lng] of [[1.5, 2.5], [null, 2.5], [1.5, null], [null, null]] as const) {
          for (const status of ["active", "down"]) {
            for (const surbl of [0, 1]) {
              for (const age of ["-1 hours", "-6 days", "-8 days"]) {
                ins.run(`t${n++}`, domain, ip, provider, lat, lng, status, surbl, age, age);
              }
            }
          }
        }
      }
    }
  }
}

describe.skipIf(!hasSqlite())("migration 0322 partial indexes", () => {
  const ddl = liveIndexDdl("threats");

  it("each index WHERE is the shared predicate constant, verbatim", () => {
    for (const [name, pred] of [
      ["idx_threats_active_no_geo", ACTIVE_NO_GEO_SQL],
      ["idx_threats_ip_no_provider", IP_NO_PROVIDER_SQL],
      ["idx_threats_surbl_pending", SURBL_PENDING_SQL],
    ] as const) {
      const def = ddl.get(name);
      expect(def, name).toBeDefined();
      expect(norm(def!)).toMatch(new RegExp(`ON threats\\(created_at\\) WHERE ${pred.replace(/[()]/g, "\\$&")}$`));
    }
  });

  it("FC no-geo probe seeks idx_threats_active_no_geo (unhinted it walks every active threat)", () => {
    const raw = openMigratedDb();
    expect(plan(raw, TOTAL_NO_GEO_PROBE_SQL)).toMatch(/SCAN threats USING INDEX idx_threats_active_no_geo/);
    expect(plan(raw, stripIndexedBy(TOTAL_NO_GEO_PROBE_SQL))).toMatch(/idx_threats_status_created/);
  });

  it("Cartographer without-provider count reads idx_threats_ip_no_provider, not idx_threats_provider", () => {
    const raw = openMigratedDb();
    const p = plan(raw, THREATS_WITHOUT_PROVIDER_COUNT_SQL);
    expect(p).toMatch(/SCAN threats USING INDEX idx_threats_ip_no_provider/);
    expect(p).not.toMatch(/idx_threats_provider\b/);
    expect(plan(raw, LEGACY_NO_PROVIDER)).toMatch(/idx_threats_provider \(hosting_provider_id=\?\)/);
  });

  it("SURBL feed SELECT and FC count both seek idx_threats_surbl_pending on created_at", () => {
    const raw = openMigratedDb();
    for (const sql of [SURBL_WORK_SELECT_SQL, SURBL_BACKLOG_COUNT_SQL]) {
      const p = plan(raw, sql);
      expect(p).toMatch(/SEARCH threats USING INDEX idx_threats_surbl_pending \(created_at>\?\)/);
      expect(p).not.toMatch(/SCAN threats/);
    }
    expect(plan(raw, LEGACY_SURBL_SELECT)).toMatch(/idx_threats_domain/);
  });

  it("call sites use the shared SQL, not a private copy", () => {
    expect(read("feeds/surbl.ts")).toMatch(/withIndexHintFallback\(SURBL_WORK_SELECT_SQL,/);
    expect(read("agents/cartographer.ts")).toMatch(/withIndexHintFallback\(THREATS_WITHOUT_PROVIDER_COUNT_SQL,/);
    const fc = read("agents/flightControl.ts");
    expect(fc).toMatch(/cacheCount\('backlog\.total_no_geo\.probe', BACKLOG_TTL_MONITORING_S, TOTAL_NO_GEO_PROBE_SQL\)/);
    expect(fc).toMatch(/cacheCount\('backlog\.surbl\.pending', BACKLOG_TTL_MONITORING_S, SURBL_BACKLOG_COUNT_SQL\)/);
  });

  it("results match the legacy queries on a mixed fixture", () => {
    const raw = openMigratedDb();
    seedThreats(raw);
    expect(count(raw, THREATS_WITHOUT_PROVIDER_COUNT_SQL)).toBe(count(raw, LEGACY_NO_PROVIDER));
    expect(count(raw, THREATS_WITHOUT_PROVIDER_COUNT_SQL)).toBeGreaterThan(0);

    // Probe = min(exact, cap); the fixture is far below the cap.
    const exactNoGeo = count(raw, LEGACY_NO_GEO);
    expect(exactNoGeo).toBeGreaterThan(0);
    expect(count(raw, TOTAL_NO_GEO_PROBE_SQL)).toBe(Math.min(exactNoGeo, NO_GEO_PROBE_CAP));

    const domains = (sql: string) =>
      (raw.prepare(sql).all() as Array<{ malicious_domain: string }>).map((r) => r.malicious_domain).sort();
    expect(domains(SURBL_WORK_SELECT_SQL)).toEqual(domains(LEGACY_SURBL_SELECT));
    expect(domains(SURBL_WORK_SELECT_SQL)).toEqual(["a.example", "b.example"]);

    // FC's count is now exactly the rows the feed's SELECT draws from.
    const feedRows = count(raw, `SELECT COUNT(*) FROM threats WHERE ${LEGACY_SURBL_SELECT.split("WHERE")[1]!.split("LIMIT")[0]}`);
    expect(count(raw, SURBL_BACKLOG_COUNT_SQL)).toBe(feedRows);
  });

  it("no-geo probe stops at the cap", () => {
    const raw = openMigratedDb();
    const ins = raw.prepare("INSERT INTO threats (id, source_feed, threat_type, status) VALUES (?, 'feed', 'phishing', 'active')");
    for (let i = 0; i < NO_GEO_PROBE_CAP + 25; i++) ins.run(`g${i}`);
    expect(count(raw, TOTAL_NO_GEO_PROBE_SQL)).toBe(NO_GEO_PROBE_CAP);
    expect(noGeoProbeLabel(NO_GEO_PROBE_CAP)).toBe(">5000");
    expect(noGeoProbeLabel(42)).toBe("42");
  });

  it("without the 0322 indexes the hinted queries fall back to the unhinted (correct) query", async () => {
    const raw = openMigratedDb({ exclude: [MIGRATION] });
    seedThreats(raw);
    const db = d1FromSqlite(raw);
    for (const sql of [TOTAL_NO_GEO_PROBE_SQL, THREATS_WITHOUT_PROVIDER_COUNT_SQL, SURBL_BACKLOG_COUNT_SQL]) {
      await expect(db.prepare(sql).first()).rejects.toThrow(/no such index/);
      const r = await withIndexHintFallback(sql, (q) => db.prepare(q).first<Record<string, number>>());
      expect(Number(Object.values(r!)[0])).toBe(count(raw, stripIndexedBy(sql)));
    }
  });
});

describe.skipIf(!hasSqlite())("FC latest run per agent", () => {
  const AGENTS = ["sentinel", "analyst", "navigator", "never_ran"];

  it("seeks idx_agent_runs_agent per agent, never walks agent_runs", () => {
    const p = plan(openMigratedDb(), LATEST_RUN_PER_AGENT_SQL, JSON.stringify(AGENTS));
    expect(p).toMatch(/^SCAN ids VIRTUAL TABLE/);
    expect(p).toMatch(/SEARCH ar USING INDEX idx_agent_runs_agent \(agent_id=\? AND started_at=\?\)/);
    expect(p).toMatch(/SEARCH r USING COVERING INDEX idx_agent_runs_agent \(agent_id=\?\)/);
    expect(p).not.toMatch(/SCAN (ar|r|agent_runs)\b/);
    // The legacy form evaluated MAX() once per run row of every agent.
    expect(plan(openMigratedDb(), LEGACY_LATEST_RUN, ...AGENTS)).toMatch(/SEARCH ar1 USING INDEX idx_agent_runs_agent \(agent_id=\?\)/);
  });

  it("returns the legacy rows (ties at MAX included, unmonitored agents excluded)", () => {
    const raw = openMigratedDb();
    const ins = raw.prepare(
      "INSERT INTO agent_runs (id, agent_id, started_at, completed_at, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
    );
    ins.run("s1", "sentinel", "2026-11-08 10:00:00", "2026-11-08 10:01:00", "success", 60000);
    ins.run("s2", "sentinel", "2026-11-08 11:00:00", null, "partial", null);
    ins.run("a1", "analyst", "2026-11-08 09:00:00", "2026-11-08 09:05:00", "failed", 300000);
    ins.run("a2", "analyst", "2026-11-08 09:00:00", "2026-11-08 09:02:00", "success", 120000); // tie
    ins.run("n1", "navigator", "2026-11-07T23:55:00.000Z", "2026-11-07T23:56:00.000Z", "success", 1000);
    ins.run("x1", "other_agent", "2026-11-08 12:00:00", null, "running", null);

    const sortRows = (rows: unknown[]) =>
      (rows as Array<Record<string, unknown>>).map((r) => JSON.stringify(r)).sort();
    const now = raw.prepare(LATEST_RUN_PER_AGENT_SQL).all(JSON.stringify(AGENTS));
    const legacy = raw.prepare(LEGACY_LATEST_RUN).all(...AGENTS);
    expect(sortRows(now)).toEqual(sortRows(legacy));
    expect(now).toHaveLength(4); // sentinel s2, analyst tie ×2, navigator
  });

  it("getAgentHealth binds the agent list as one JSON parameter", () => {
    expect(read("agents/flightControl.ts")).toMatch(/db\.prepare\(LATEST_RUN_PER_AGENT_SQL\)\s*\.bind\(JSON\.stringify\(agentIds\)\)/);
  });
});

describe.skipIf(!hasSqlite())("Cartographer provider top_countries cache", () => {
  function envWith(raw: SqliteDb, log: Array<{ sql: string }>): Env {
    return { DB: d1FromSqlite(raw, { log }), CACHE: fakeKv() } as unknown as Env;
  }

  function seed(raw: SqliteDb): void {
    const ins = raw.prepare(
      "INSERT INTO threats (id, source_feed, threat_type, hosting_provider_id, country_code, created_at) VALUES (?, 'feed', 'phishing', ?, ?, datetime('now', ?))",
    );
    let n = 0;
    for (const [p, cc, age] of [
      ["p1", "US", "-1 hours"], ["p1", "DE", "-1 hours"], ["p1", "US", "-2 hours"], ["p1", "FR", "-40 days"],
      ["p2", "NL", "-3 days"], ["p2", null, "-1 hours"], ["p3", "CN", "-1 hours"],
    ] as const) ins.run(`c${n++}`, p, cc, age);
  }

  const legacy = (raw: SqliteDb, where: string, ids: string[]): Record<string, string[]> => {
    const rows = raw.prepare(`
      SELECT hosting_provider_id, GROUP_CONCAT(DISTINCT country_code) as countries
      FROM threats WHERE hosting_provider_id IN (${ids.map(() => "?").join(",")})
        AND country_code IS NOT NULL AND ${where}
      GROUP BY hosting_provider_id`).all(...ids) as Array<{ hosting_provider_id: string; countries: string }>;
    return Object.fromEntries(rows.map((r) => [r.hosting_provider_id, r.countries.split(",").sort()]));
  };
  const sorted = (m: Record<string, string>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.split(",").sort()]));

  it("returns the legacy country lists, then serves the same period + provider set from KV", async () => {
    const raw = openMigratedDb();
    seed(raw);
    const log: Array<{ sql: string }> = [];
    const env = envWith(raw, log);
    const ids = ["p1", "p2", "p3"];
    for (const [period, where] of [
      ["30d", "created_at >= date('now', '-30 days')"],
      ["all", "1=1"],
    ] as const) {
      const first = await providerCountriesForPeriod(env, period, where, ids);
      expect(sorted(first)).toEqual(legacy(raw, where, ids));
      const reads = log.length;
      const again = await providerCountriesForPeriod(env, period, where, [...ids].reverse());
      expect(again).toEqual(first);
      expect(log.length).toBe(reads); // order-insensitive key, served from KV
    }
    expect(PROVIDER_COUNTRIES_TTL_S["all"]).toBe(86400);
    expect(PROVIDER_COUNTRIES_TTL_S["30d"]).toBe(86400);
    expect(PROVIDER_COUNTRIES_TTL_S["today"]).toBe(3600);
  });

  it("keys on period, provider set and (for today) the UTC day", async () => {
    const d1 = new Date("2026-11-08T23:00:00Z");
    const d2 = new Date("2026-11-09T00:30:00Z");
    expect(await providerCountriesCacheKey("all", ["a", "b"], d1)).toBe(await providerCountriesCacheKey("all", ["b", "a"], d2));
    expect(await providerCountriesCacheKey("all", ["a", "b"])).not.toBe(await providerCountriesCacheKey("all", ["a", "c"]));
    expect(await providerCountriesCacheKey("all", ["a"])).not.toBe(await providerCountriesCacheKey("30d", ["a"]));
    expect(await providerCountriesCacheKey("today", ["a"], d1)).not.toBe(await providerCountriesCacheKey("today", ["a"], d2));
    expect((await providerCountriesCacheKey("today", ["a"], d1)).length).toBeLessThan(512); // KV key limit
  });

  it("empty provider list reads nothing", async () => {
    const log: Array<{ sql: string }> = [];
    expect(await providerCountriesForPeriod(envWith(openMigratedDb(), log), "all", "1=1", [])).toEqual({});
    expect(log).toHaveLength(0);
  });
});

describe.skipIf(!hasSqlite())("monitored-brands total (dark web / app store overviews)", () => {
  function seed(raw: SqliteDb): void {
    raw.exec(`
      INSERT INTO brands (id, name, canonical_domain) VALUES
        ('b1', 'One', 'one.example'), ('b2', 'Two', 'two.example'), ('b3', 'Three', 'three.example');
      INSERT INTO monitored_brands (brand_id, tenant_id, added_by) VALUES
        ('b1', '__internal__', 'seed'), ('b1', 'tenant-x', 'seed'), ('b2', '__internal__', 'seed'),
        ('gone', '__internal__', 'seed');
    `);
  }

  it("drives from monitored_brands with a PK probe into brands", () => {
    const p = plan(openMigratedDb(), MONITORED_BRANDS_JOINED_COUNT_SQL);
    expect(p).toMatch(/^SCAN mb USING COVERING INDEX sqlite_autoindex_monitored_brands_1/);
    expect(p).toMatch(/SEARCH b .*USING COVERING INDEX sqlite_autoindex_brands_1 \(id=\?\)/);
    expect(p).not.toMatch(/SCAN b\b/);
  });

  it("equals the legacy join count (per-tenant duplicates counted, orphans not)", async () => {
    const raw = openMigratedDb();
    const before = count(raw, MONITORED_BRANDS_JOINED_COUNT_SQL); // migrations seed some rows
    seed(raw);
    const total = count(raw, MONITORED_BRANDS_JOINED_COUNT_SQL);
    expect(total).toBe(count(raw, LEGACY_MONITORED_JOIN));
    expect(total - before).toBe(3);

    const log: Array<{ sql: string }> = [];
    const cache = fakeKv();
    const env = { DB: d1FromSqlite(raw, { log }), CACHE: cache } as unknown as Env;
    expect(await countMonitoredBrandRows(env, env.DB)).toBe(total);
    expect(await countMonitoredBrandRows(env, env.DB)).toBe(total);
    expect(log.filter((l) => l.sql === MONITORED_BRANDS_JOINED_COUNT_SQL)).toHaveLength(1);
    expect(MONITORED_BRANDS_JOINED_KEY.startsWith("count.")).toBe(true);
  });

  it("both overview handlers use the counter only on the global path", () => {
    for (const f of ["handlers/darkWebMonitor.ts", "handlers/appStoreMonitor.ts"]) {
      expect(read(f)).toMatch(/isGlobal\s*\?\s*countMonitoredBrandRows\(env, session\)/);
    }
  });
});
