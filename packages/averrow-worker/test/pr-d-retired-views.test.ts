// PR-D (2026-10): retire the three Home views removed in #1756 and keep
// their two unique pieces.
//
//   1. GET /api/providers/{movers,worst,improving}, /api/intel/hotlist and
//      /api/insights/latest are gone — each answers 404 through the real
//      route registrations (dashboard + threats + the public catch-all, in
//      index.ts order). The three provider slugs would otherwise fall into
//      /api/providers/:id as a phantom provider and answer 200.
//   2. /api/providers/v2?sort=cooling lists providers whose last-7d inflow
//      (hosting_providers.trend_7d) ran below their 30-day weekly average
//      (trend_30d * 7/30), most negative delta first; the cache key carries
//      the sort.
//   3. GET /api/intel/multi-feed-consensus — the hotlist's >= 4-feed lane on
//      its own, staff-only, cachedValue 6h.
//
// SQL runs for real against node:sqlite with the migration-derived schema
// (test/sqlite-d1-harness.ts), so a column typo fails here, not in prod.

import { describe, it, expect, beforeEach } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { registerThreatRoutes } from "../src/routes/threats";
import { registerPublicRoutes } from "../src/routes/public";
import { signJWT } from "../src/lib/jwt";
import {
  MULTI_FEED_CONSENSUS_CACHE_KEY,
  MULTI_FEED_CONSENSUS_TTL_SECONDS,
} from "../src/handlers/intel";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  sqliteTimestampHoursAgo,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import type { Env, UserRole } from "../src/types";

const SECRET = "test-secret-pr-d-retired-views";

interface Harness {
  env: Env;
  raw: SqliteDb;
  kv: ReturnType<typeof fakeKv>;
  /** SQL of every non-auth statement prepared, in order. */
  queries: string[];
  /** Harness statement log — carries SQLite's error text on failure. */
  log: StatementLogEntry[];
}

// The SQLite D1 plus two shims: requireAuth's `SELECT status FROM users`
// answers "active" (only the role check is under test), and withSession
// (getReadSession) returns the same DB.
function makeHarness(): Harness {
  // hosting_providers.is_bulletproof (read by /api/providers/v2) comes from
  // migrations/0078 — see hosting-providers-bulletproof-schema.test.ts.
  const raw = openDerivedDb(["threats", "hosting_providers", "threat_cube_provider"]);
  const log: StatementLogEntry[] = [];
  const d1 = d1FromSqlite(raw, { log });
  const queries: string[] = [];
  const db: Record<string, unknown> = {
    prepare(sql: string) {
      if (/\busers\b/.test(sql)) {
        return {
          bind: () => ({
            first: async () => ({ status: "active" }),
            run: async () => ({ success: true }),
          }),
        };
      }
      queries.push(sql);
      return d1.prepare(sql);
    },
    batch: d1.batch.bind(d1),
  };
  db.withSession = () => db;
  const kv = fakeKv();
  const env = { JWT_SECRET: SECRET, DB: db, CACHE: kv } as unknown as Env;
  return { env, raw, kv, queries, log };
}

function buildRouter(): RouterType<IRequest> {
  const router = Router();
  registerDashboardRoutes(router);
  registerThreatRoutes(router);
  registerPublicRoutes(router);
  return router;
}

async function getAs(role: UserRole, path: string): Promise<Request> {
  const token = await signJWT({ sub: `user_${role}`, email: `${role}@averrow.local`, role }, SECRET, 300);
  return new Request(`https://averrow.com${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function call(h: Harness, role: UserRole, path: string): Promise<Response> {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return (await buildRouter().fetch(await getAs(role, path), h.env, ctx)) as Response;
}

function insertProvider(raw: SqliteDb, id: string, trend7d: number, trend30d: number, active = 1): void {
  raw.prepare(
    `INSERT INTO hosting_providers (id, name, active_threat_count, total_threat_count, trend_7d, trend_30d)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `Provider ${id}`, active, trend30d, trend7d, trend30d);
}

let threatSeq = 0;
function insertThreat(
  raw: SqliteDb,
  ip: string,
  feed: string,
  opts: { status?: string; brand?: string | null; firstSeenHoursAgo?: number } = {},
): void {
  threatSeq += 1;
  raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_url, malicious_domain, ip_address,
                          target_brand_id, status, first_seen)
     VALUES (?, ?, 'phishing', ?, ?, ?, ?, ?, ?)`,
  ).run(
    `thr_${threatSeq}`,
    feed,
    `https://evil${threatSeq}.test/`,
    `evil${threatSeq}.test`,
    ip,
    opts.brand === undefined ? "brand_a" : opts.brand,
    opts.status ?? "active",
    sqliteTimestampHoursAgo(opts.firstSeenHoursAgo ?? 1),
  );
}

describe.skipIf(!hasSqlite())("PR-D — retired view endpoints 404 through the real router", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  const RETIRED = [
    "/api/providers/movers",
    "/api/providers/worst",
    "/api/providers/improving",
    "/api/intel/hotlist",
    "/api/insights/latest",
  ];
  for (const path of RETIRED) {
    it(`GET ${path} → 404 for staff`, async () => {
      const res = await call(h, "super_admin", path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, error: "Not found" });
      // Nothing reached a handler: no D1 statement beyond the auth check.
      expect(h.queries).toEqual([]);
    });
  }

  it("GET /api/providers/:id still reaches the detail handler for a real id", async () => {
    insertProvider(h.raw, "prov_live", 3, 30);
    const res = await call(h, "analyst", "/api/providers/prov_live");
    // Detail handler joins tables outside this harness's schema, so it
    // 500s here — the point is that it was routed (not 404'd).
    expect(res.status).not.toBe(404);
    expect(h.queries.some((q) => q.includes("FROM hosting_providers WHERE id = ?"))).toBe(true);
  });
});

describe.skipIf(!hasSqlite())("PR-D — /api/providers/v2?sort=cooling", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    // 30d weekly average = trend_30d * 7/30.
    insertProvider(h.raw, "p_big_drop", 10, 300);   // avg 70 → delta -60
    insertProvider(h.raw, "p_small_drop", 5, 30);   // avg 7  → delta -2
    insertProvider(h.raw, "p_steady", 7, 30);       // avg 7  → delta  0 (excluded)
    insertProvider(h.raw, "p_heating", 50, 60);     // avg 14 → delta +36 (excluded)
    insertProvider(h.raw, "p_dormant", 0, 0, 0);    // no 30d history (excluded)
  });

  it("returns only providers below their 30-day weekly average, most negative first", async () => {
    const res = await call(h, "analyst", "/api/providers/v2?sort=cooling&limit=10");
    expect(h.log.filter((e) => e.error)).toEqual([]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ id: string; trend_7d: number; trend_30d: number; cooling_delta_7d: number; threat_history: number[] }>;
      meta: { total: number; limit: number; offset: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.map((r) => r.id)).toEqual(["p_big_drop", "p_small_drop"]);
    expect(body.data[0]!.cooling_delta_7d).toBe(-60);
    expect(body.data[1]!.cooling_delta_7d).toBe(-2);
    expect(body.data.every((r) => r.cooling_delta_7d < 0)).toBe(true);
    expect(body.meta.total).toBe(2);
  });

  it("the cache key encodes the cooling sort (no collision with the default sort)", async () => {
    await call(h, "analyst", "/api/providers/v2?sort=cooling&limit=10");
    await call(h, "analyst", "/api/providers/v2?limit=10");
    const keys = [...h.kv.store.keys()].filter((k) => k.startsWith("providers_v2:"));
    expect(keys).toContain("providers_v2:v2:::cooling:10");
    expect(keys).toContain("providers_v2:v2:::active_threats:10");

    // Default sort is unfiltered — all five providers.
    const res = await call(h, "analyst", "/api/providers/v2?limit=10");
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(5);
  });

  it("a cached cooling response is served from KV without touching D1", async () => {
    await call(h, "analyst", "/api/providers/v2?sort=cooling&limit=10");
    const before = h.queries.length;
    const res = await call(h, "analyst", "/api/providers/v2?sort=cooling&limit=10");
    expect(res.status).toBe(200);
    expect(h.queries.length).toBe(before);
  });

  it("unknown sort values collapse to the default sort and its cache key", async () => {
    await call(h, "analyst", "/api/providers/v2?sort=bogus&limit=10");
    const keys = [...h.kv.store.keys()].filter((k) => k.startsWith("providers_v2:"));
    expect(keys).toEqual(["providers_v2:v2:::active_threats:10"]);
  });
});

describe.skipIf(!hasSqlite())("PR-D — GET /api/intel/multi-feed-consensus", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    // 5 feeds, 2 brands, 6 threats.
    for (const f of ["openphish", "phishtank", "urlhaus", "threatfox", "otx"]) insertThreat(h.raw, "1.1.1.1", f);
    insertThreat(h.raw, "1.1.1.1", "otx", { brand: "brand_b", firstSeenHoursAgo: 0 });
    // Exactly 4 feeds.
    for (const f of ["openphish", "phishtank", "urlhaus", "threatfox"]) insertThreat(h.raw, "2.2.2.2", f, { brand: null });
    // 3 feeds — below threshold.
    for (const f of ["openphish", "phishtank", "urlhaus"]) insertThreat(h.raw, "3.3.3.3", f);
    // 4 feeds but one is inactive → only 3 active feeds.
    for (const f of ["openphish", "phishtank", "urlhaus"]) insertThreat(h.raw, "4.4.4.4", f);
    insertThreat(h.raw, "4.4.4.4", "threatfox", { status: "remediated" });
    // Placeholder IP with many feeds — excluded.
    for (const f of ["openphish", "phishtank", "urlhaus", "threatfox"]) insertThreat(h.raw, "0.0.0.0", f);
  });

  it("returns IPs with >= 4 distinct active feeds in the documented shape", async () => {
    const res = await call(h, "analyst", "/api/intel/multi-feed-consensus");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      total: number;
      data: Array<{
        ip_address: string;
        feed_count: number;
        feeds: string[];
        threat_count: number;
        brand_count: number;
        last_seen: string | null;
      }>;
    };
    expect(body.success).toBe(true);
    expect(body.total).toBe(2);
    expect(body.data.map((r) => r.ip_address)).toEqual(["1.1.1.1", "2.2.2.2"]);
    const top = body.data[0]!;
    expect(Object.keys(top).sort()).toEqual(
      ["brand_count", "feed_count", "feeds", "ip_address", "last_seen", "threat_count"],
    );
    expect(top.feed_count).toBe(5);
    expect(top.feeds).toEqual(["openphish", "otx", "phishtank", "threatfox", "urlhaus"]);
    expect(top.threat_count).toBe(6);
    expect(top.brand_count).toBe(2);
    expect(typeof top.last_seen).toBe("string");
    expect(body.data[1]!.brand_count).toBe(0);
  });

  it("second call is served by cachedValue (6h TTL) with no D1 query", async () => {
    await call(h, "analyst", "/api/intel/multi-feed-consensus");
    const threatQueries = () => h.queries.filter((q) => q.includes("FROM threats")).length;
    expect(threatQueries()).toBe(1);
    expect(h.kv.store.has(`cv:${MULTI_FEED_CONSENSUS_CACHE_KEY}`)).toBe(true);
    expect(MULTI_FEED_CONSENSUS_TTL_SECONDS).toBe(6 * 60 * 60);

    const res = await call(h, "super_admin", "/api/intel/multi-feed-consensus");
    expect(res.status).toBe(200);
    expect(threatQueries()).toBe(1);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(2);
  });

  it("is staff-only: client gets 403 and nothing is queried", async () => {
    const res = await call(h, "client", "/api/intel/multi-feed-consensus");
    expect(res.status).toBe(403);
    expect(h.queries).toEqual([]);
  });

  it("auditor (read-only global seat) is admitted", async () => {
    const res = await call(h, "auditor", "/api/intel/multi-feed-consensus");
    expect(res.status).toBe(200);
  });
});
