/**
 * Tests for GET /api/bot-traffic (handlers/botTraffic.ts) and its route
 * wiring in routes/dashboard.ts (requireStaff).
 */

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { handleBotTraffic, parseBotTrafficDays, pivotBotShare, toIsoUtc } from "../src/handlers/botTraffic";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { botTrafficCacheKey } from "../src/feeds/cf_radar_bots";
import { signJWT } from "../src/lib/jwt";
import type { Env, JWTPayload, UserRole } from "../src/types";

const SECRET = "test-secret-bot-traffic";

interface Rows {
  series?: unknown[];
  latest?: unknown[];
  top_location?: unknown[];
  top_asn?: unknown[];
  bot_category?: unknown[];
  attack_origin?: unknown[];
  attack_target?: unknown[];
  bot_density?: unknown[];
  /** bot_share rows for the bot_density snapshot date. */
  densityShare?: unknown[];
  feedStatus?: unknown;
  pull?: unknown;
}

interface Harness {
  env: Env;
  cacheGets: string[];
  cachePuts: Array<{ key: string; value: string; opts: unknown }>;
  dbPrepares: number;
  seriesBinds: unknown[][];
  /** metric bound to each radar_country_snapshots query. */
  countryMetrics: unknown[];
  /** SQL of the bot_share-on-density-date query (null until run). */
  densityShareSql: string | null;
}

function makeHarness(rows: Rows = {}, opts: { cached?: Record<string, string>; dbThrows?: boolean } = {}): Harness {
  const h: Harness = { env: {} as Env, cacheGets: [], cachePuts: [], dbPrepares: 0, seriesBinds: [], countryMetrics: [], densityShareSql: null };

  const stmt = (sql: string) => {
    h.dbPrepares++;
    const make = (args: unknown[]) => ({
      async run() { return { success: true, meta: {} }; },
      async all<T>(): Promise<{ results: T[] }> {
        if (opts.dbThrows) throw new Error("d1 down");
        if (/snapshot_date > date\('now'/.test(sql)) {
          h.seriesBinds.push(args);
          return { results: (rows.series ?? []) as T[] };
        }
        if (/MAX\(snapshot_date\)[\s\S]*metric = 'bot_share'\)/.test(sql)) {
          return { results: (rows.latest ?? []) as T[] };
        }
        if (/FROM radar_country_snapshots WHERE metric = 'bot_density'\)/.test(sql)) {
          h.densityShareSql = sql;
          return { results: (rows.densityShare ?? []) as T[] };
        }
        if (/FROM radar_country_snapshots/.test(sql)) h.countryMetrics.push(args[0]);
        if (/metric = \?1/.test(sql)) {
          const m = args[0] as keyof Rows;
          return { results: ((rows[m] as unknown[]) ?? []) as T[] };
        }
        return { results: [] };
      },
      async first<T>(): Promise<T | null> {
        if (/FROM feed_status/.test(sql)) return (rows.feedStatus ?? null) as T | null;
        if (/FROM feed_pull_history/.test(sql)) return (rows.pull ?? null) as T | null;
        if (/FROM users/i.test(sql)) return { status: "active" } as unknown as T;
        return null;
      },
    });
    return { bind: (...args: unknown[]) => make(args), ...make([]) };
  };

  const db = {
    prepare: (sql: string) => stmt(sql),
    withSession: () => ({ prepare: (sql: string) => stmt(sql), getBookmark: () => null }),
  };

  const cache = {
    async get(key: string) {
      h.cacheGets.push(key);
      return opts.cached?.[key] ?? null;
    },
    async put(key: string, value: string, o: unknown) {
      h.cachePuts.push({ key, value, opts: o });
    },
  };

  h.env = { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env;
  return h;
}

const call = (env: Env, qs = "") =>
  handleBotTraffic(new Request(`https://averrow.com/api/bot-traffic${qs}`), env);

describe("parseBotTrafficDays", () => {
  it.each([
    [null, 30], ["", 30], ["7", 7], ["30", 30], ["90", 90],
  ])("%j -> %j", (raw, expected) => {
    expect(parseBotTrafficDays(raw)).toBe(expected);
  });
  it.each([["0"], ["1"], ["14"], ["365"], ["-7"], ["7.5"], ["abc"], ["7d"], [" 7"], ["1e1"]])(
    "%j is invalid",
    (raw) => {
      expect(parseBotTrafficDays(raw)).toBeNull();
    },
  );
});

describe("pivotBotShare", () => {
  const r = (d: string, k: string, v: number, f = "2026-10-11 06:00:00") => ({
    snapshot_date: d, dim_key: k, value_pct: v, fetched_at: f,
  });
  it("pivots to one entry per date, ascending, tracking the newest fetched_at", () => {
    const out = pivotBotShare([
      r("2026-10-02", "bot", 30, "a"), r("2026-10-01", "bot", 20, "b"),
      r("2026-10-01", "human", 80, "c"), r("2026-10-02", "human", 70, "a"),
    ]);
    expect(out).toEqual([
      { date: "2026-10-01", bot_pct: 20, human_pct: 80, fetched_at: "c" },
      { date: "2026-10-02", bot_pct: 30, human_pct: 70, fetched_at: "a" },
    ]);
  });
  it("complements a missing side, ignores unknown dim_keys, and drops dates with neither", () => {
    const out = pivotBotShare([r("2026-10-01", "bot", 35), r("2026-10-02", "human", 90), r("2026-10-03", "zzz", 1)]);
    expect(out.map((e) => [e.date, e.bot_pct, e.human_pct])).toEqual([
      ["2026-10-01", 35, 65], ["2026-10-02", 10, 90],
    ]);
  });
});

describe("toIsoUtc", () => {
  it.each([
    ["2026-10-11 06:00:05", "2026-10-11T06:00:05Z"],
    ["2026-10-11T06:00:05Z", "2026-10-11T06:00:05Z"],
    ["2026-10-11T06:00:05.123Z", "2026-10-11T06:00:05Z"],
    ["2026-10-11T06:00:05+00:00", "2026-10-11T06:00:05Z"],
    [" 2026-10-11 06:00:05 ", "2026-10-11T06:00:05Z"],
  ])("%j -> %j", (raw, expected) => {
    expect(toIsoUtc(raw)).toBe(expected);
  });
  it("passes null and unrecognised values through unchanged", () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc("x")).toBe("x");
    expect(toIsoUtc("2026-10-11")).toBe("2026-10-11");
    expect(toIsoUtc("2026-10-11T06:00:05+02:00")).toBe("2026-10-11T06:00:05+02:00");
  });
});

describe("handleBotTraffic", () => {
  it.each(["0", "14", "abc", "-1", "7.5"])("days=%s -> 400 and no cache or D1 access", async (d) => {
    const h = makeHarness();
    const res = await call(h.env, `?days=${d}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/7, 30, 90/);
    expect(h.cacheGets).toEqual([]);
    expect(h.dbPrepares).toBe(0);
  });

  it.each([
    ["", 30], ["?days=7", 7], ["?days=30", 30], ["?days=90", 90], ["?days=", 30],
  ])("%j reads cache key and window for %i days", async (qs, days) => {
    const h = makeHarness();
    const res = await call(h.env, qs);
    expect(res.status).toBe(200);
    expect(h.cacheGets).toEqual([botTrafficCacheKey(days)]);
    expect(h.seriesBinds).toEqual([[`-${days} days`]]);
    expect(h.cachePuts[0]!.key).toBe(botTrafficCacheKey(days));
  });

  it("empty table -> latest null, empty arrays, null last_fetch fields", async () => {
    const h = makeHarness();
    const res = await call(h.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      source: "cloudflare_radar",
      latest: null,
      series: [],
      top_locations: [],
      top_asns: [],
      categories: [],
      attack_origins: [],
      attack_targets: [],
      bot_density: [],
      bot_density_global_pct: null,
      last_fetch: { status: null, last_success_at: null, last_error: null },
      as_of: {
        bot_share: null, top_locations: null, top_asns: null, categories: null,
        attack_origins: null, attack_targets: null, bot_density: null,
      },
    });
    expect(h.countryMetrics.sort()).toEqual(["attack_origin", "attack_target", "bot_density"]);
  });

  it("builds the full response shape from rows and caches it for 1h", async () => {
    const h = makeHarness({
      series: [
        { snapshot_date: "2026-10-10", dim_key: "bot", value_pct: 28, fetched_at: "2026-10-11 06:00:00" },
        { snapshot_date: "2026-10-10", dim_key: "human", value_pct: 72, fetched_at: "2026-10-11 06:00:00" },
        { snapshot_date: "2026-10-11", dim_key: "bot", value_pct: 30, fetched_at: "2026-10-11 06:00:00" },
        { snapshot_date: "2026-10-11", dim_key: "human", value_pct: 70, fetched_at: "2026-10-11 06:00:00" },
      ],
      latest: [
        { snapshot_date: "2026-10-11", dim_key: "bot", value_pct: 30, fetched_at: "2026-10-11 06:00:00" },
        { snapshot_date: "2026-10-11", dim_key: "human", value_pct: 70, fetched_at: "2026-10-11 06:00:00" },
      ],
      // Ranked metrics each read their own latest date: after a partial
      // pull top_asn can lag behind bot_share.
      top_location: [
        { snapshot_date: "2026-10-11", dim_key: "US", label: "United States", rank: 1, value_pct: 40 },
        { snapshot_date: "2026-10-11", dim_key: "DE", label: null, rank: null, value_pct: 10 },
      ],
      top_asn: [
        { snapshot_date: "2026-10-09", dim_key: "16509", label: "AMAZON-02", rank: 1, value_pct: 12 },
        { snapshot_date: "2026-10-09", dim_key: "8075", label: null, rank: 2, value_pct: 8 },
        { snapshot_date: "2026-10-09", dim_key: "not-a-number", label: "bad", rank: 3, value_pct: 1 },
      ],
      bot_category: [
        { snapshot_date: "2026-10-11", dim_key: "OTHER", label: null, rank: 2, value_pct: 10 },
        { snapshot_date: "2026-10-11", dim_key: "AI_CRAWLER", label: null, rank: 1, value_pct: 60 },
      ],
      attack_origin: [
        { snapshot_date: "2026-10-11", country_code: "CN", label: "China", rank: 1, value_pct: 18.5, traffic_pct: null },
        { snapshot_date: "2026-10-11", country_code: "XX", label: null, rank: null, value_pct: 2, traffic_pct: null },
      ],
      attack_target: [
        { snapshot_date: "2026-10-10", country_code: "US", label: "United States", rank: 1, value_pct: 35, traffic_pct: null },
      ],
      // Returned in full, re-sorted by bot_pct desc and re-ranked; a row
      // without traffic_pct is dropped.
      // bound: 'lower'/'upper' pass through; anything else (null, junk) -> null.
      bot_density: [
        { snapshot_date: "2026-10-10", country_code: "DE", label: "Germany", rank: 2, value_pct: 20, traffic_pct: 4, bound: null },
        { snapshot_date: "2026-10-10", country_code: "SG", label: "Singapore", rank: 1, value_pct: 70.5, traffic_pct: 0.8, bound: "lower" },
        { snapshot_date: "2026-10-10", country_code: "NL", label: null, rank: 3, value_pct: 20, traffic_pct: 2, bound: "upper" },
        { snapshot_date: "2026-10-10", country_code: "JP", label: "Japan", rank: 4, value_pct: 10, traffic_pct: 3, bound: "sideways" },
        { snapshot_date: "2026-10-10", country_code: "QQ", label: "Bad", rank: 5, value_pct: 5, traffic_pct: null, bound: null },
      ],
      // Density lags bot_share by a day: the global baseline is that day's
      // bot share (28), not latest (30).
      densityShare: [
        { snapshot_date: "2026-10-10", dim_key: "bot", value_pct: 28, fetched_at: "2026-10-11 06:00:00" },
        { snapshot_date: "2026-10-10", dim_key: "human", value_pct: 72, fetched_at: "2026-10-11 06:00:00" },
      ],
      feedStatus: { last_successful_pull: "2026-10-11 06:00:05", last_error: null },
      pull: { status: "success" },
    });
    const res = await call(h.env, "?days=7");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toEqual({
      source: "cloudflare_radar",
      latest: { snapshot_date: "2026-10-11", bot_pct: 30, human_pct: 70, fetched_at: "2026-10-11T06:00:00Z" },
      series: [
        { date: "2026-10-10", bot_pct: 28, human_pct: 72 },
        { date: "2026-10-11", bot_pct: 30, human_pct: 70 },
      ],
      top_locations: [
        { code: "US", name: "United States", pct: 40, rank: 1 },
        { code: "DE", name: "DE", pct: 10, rank: 2 }, // null label -> code, null rank -> index+1
      ],
      top_asns: [
        { asn: 16509, name: "AMAZON-02", pct: 12, rank: 1 },
        { asn: 8075, name: "AS8075", pct: 8, rank: 2 },
      ], // non-numeric ASN filtered out
      categories: [
        { category: "AI_CRAWLER", pct: 60 },
        { category: "OTHER", pct: 10 },
      ], // sorted by pct desc
      attack_origins: [
        { code: "CN", name: "China", pct: 18.5, rank: 1 },
        { code: "XX", name: "XX", pct: 2, rank: 2 }, // null label -> code, null rank -> index+1
      ],
      attack_targets: [{ code: "US", name: "United States", pct: 35, rank: 1 }],
      bot_density: [
        { code: "SG", name: "Singapore", bot_pct: 70.5, traffic_pct: 0.8, bound: "lower", rank: 1 },
        { code: "DE", name: "Germany", bot_pct: 20, traffic_pct: 4, bound: null, rank: 2 }, // tie -> traffic desc
        { code: "NL", name: "NL", bot_pct: 20, traffic_pct: 2, bound: "upper", rank: 3 },
        { code: "JP", name: "Japan", bot_pct: 10, traffic_pct: 3, bound: null, rank: 4 },
      ],
      bot_density_global_pct: 28,
      last_fetch: { status: "success", last_success_at: "2026-10-11T06:00:05Z", last_error: null },
      as_of: {
        bot_share: "2026-10-11", top_locations: "2026-10-11", top_asns: "2026-10-09", categories: "2026-10-11",
        attack_origins: "2026-10-11", attack_targets: "2026-10-10", bot_density: "2026-10-10",
      },
    });
    // The baseline query is pinned to bot_density's own latest date.
    expect(h.densityShareSql).toMatch(/metric = 'bot_share'[\s\S]*SELECT MAX\(snapshot_date\) FROM radar_country_snapshots WHERE metric = 'bot_density'/);
    expect(h.cachePuts).toHaveLength(1);
    expect(h.cachePuts[0]!.opts).toEqual({ expirationTtl: 3600 });
    expect(JSON.parse(h.cachePuts[0]!.value)).toEqual(data);
  });

  it("latest is independent of the window (stalled feed still shows last value)", async () => {
    const h = makeHarness({
      series: [],
      latest: [{ snapshot_date: "2026-01-01", dim_key: "bot", value_pct: 25, fetched_at: "x" }],
    });
    const { data } = (await (await call(h.env, "?days=7")).json()) as { data: { latest: unknown; series: unknown[] } };
    expect(data.series).toEqual([]);
    expect(data.latest).toEqual({ snapshot_date: "2026-01-01", bot_pct: 25, human_pct: 75, fetched_at: "x" });
  });

  it("as_of: a section with no rows reads null while the others carry their dates", async () => {
    const h = makeHarness({
      latest: [{ snapshot_date: "2026-10-11", dim_key: "bot", value_pct: 30, fetched_at: "2026-10-11 06:00:00" }],
      top_location: [{ snapshot_date: "2026-10-10", dim_key: "US", label: "United States", rank: 1, value_pct: 40 }],
    });
    const { data } = (await (await call(h.env)).json()) as { data: { as_of: unknown } };
    expect(data.as_of).toEqual({
      bot_share: "2026-10-11", top_locations: "2026-10-10", top_asns: null, categories: null,
      attack_origins: null, attack_targets: null, bot_density: null,
    });
  });

  it("bot_density is returned in full (not a top-20 slice)", async () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({
      snapshot_date: "2026-10-11", country_code: `C${i}`, label: `Country ${i}`, rank: i + 1,
      value_pct: 90 - i, traffic_pct: 1,
    }));
    const h = makeHarness({ bot_density: rows });
    const { data } = (await (await call(h.env)).json()) as { data: { bot_density: Array<{ rank: number; bot_pct: number }> } };
    expect(data.bot_density).toHaveLength(45);
    expect(data.bot_density.map((r) => r.rank)).toEqual(rows.map((r) => r.rank));
  });

  it("bot_density_global_pct complements a lone human row and is null without a bot_share row", async () => {
    const density = [{ snapshot_date: "2026-10-11", country_code: "US", label: "US", rank: 1, value_pct: 30, traffic_pct: 20, bound: null }];
    const lone = makeHarness({
      bot_density: density,
      densityShare: [{ snapshot_date: "2026-10-11", dim_key: "human", value_pct: 65, fetched_at: "x" }],
    });
    const a = (await (await call(lone.env)).json()) as { data: { bot_density_global_pct: number | null } };
    expect(a.data.bot_density_global_pct).toBe(35);
    const none = makeHarness({ bot_density: density });
    const b = (await (await call(none.env)).json()) as { data: { bot_density_global_pct: number | null } };
    expect(b.data.bot_density_global_pct).toBeNull();
  });

  it("cache key is v4", () => {
    expect(botTrafficCacheKey(7)).toBe("bot_traffic:v4:7");
    expect(botTrafficCacheKey(30)).toBe("bot_traffic:v4:30");
    expect(botTrafficCacheKey(90)).toBe("bot_traffic:v4:90");
  });

  it("cache hit returns the cached payload without touching D1 or writing the cache", async () => {
    const payload = { source: "cloudflare_radar", latest: null, series: [], top_locations: [], top_asns: [], categories: [], last_fetch: { status: "cached", last_success_at: null, last_error: null } };
    const h = makeHarness({}, { cached: { [botTrafficCacheKey(90)]: JSON.stringify(payload) } });
    const res = await call(h.env, "?days=90");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: payload });
    expect(h.dbPrepares).toBe(0);
    expect(h.cachePuts).toEqual([]);
  });

  it("a cache miss on one window does not serve another window's cache", async () => {
    const h = makeHarness({}, { cached: { [botTrafficCacheKey(7)]: JSON.stringify({ stale: true }) } });
    const { data } = (await (await call(h.env, "?days=30")).json()) as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty("stale");
    expect(data.source).toBe("cloudflare_radar");
  });

  it("serves from D1 when KV get throws and when KV put throws", async () => {
    const h = makeHarness();
    (h.env.CACHE as unknown as { get: () => Promise<never> }).get = async () => { throw new Error("kv"); };
    (h.env.CACHE as unknown as { put: () => Promise<never> }).put = async () => { throw new Error("kv"); };
    const res = await call(h.env);
    expect(res.status).toBe(200);
  });

  it("D1 failure -> 500 with a generic error", async () => {
    const h = makeHarness({}, { dbThrows: true });
    const res = await call(h.env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({ success: false, error: "An internal error occurred" });
  });
});

// ─── Route wiring ───────────────────────────────────────────────

function makeRouter(): RouterType<IRequest> {
  const router = Router();
  registerDashboardRoutes(router);
  return router;
}

async function bearer(role: UserRole): Promise<string> {
  const payload: Omit<JWTPayload, "iat" | "exp"> = { sub: `u-${role}`, email: `${role}@averrow.com`, role };
  return `Bearer ${await signJWT(payload, SECRET, 300)}`;
}

async function route(path: string, env: Env, auth?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth) headers["Authorization"] = auth;
  const res = (await makeRouter().fetch(new Request(`https://averrow.com${path}`, { headers }), env)) as Response | undefined;
  if (!res) throw new Error(`no route matched ${path}`);
  return res;
}

describe("GET /api/bot-traffic route — staff only", () => {
  const cachedPayload = JSON.stringify({ source: "cloudflare_radar", latest: null, series: [], top_locations: [], top_asns: [], categories: [], last_fetch: { status: null, last_success_at: null, last_error: null } });

  it("anonymous -> 401 without reading cache", async () => {
    const h = makeHarness({}, { cached: { [botTrafficCacheKey(30)]: cachedPayload } });
    const res = await route("/api/bot-traffic", h.env);
    expect(res.status).toBe(401);
    expect(h.cacheGets.filter((k) => k.startsWith("bot_traffic:"))).toEqual([]);
  });

  it("tenant client JWT -> 403 without reading cache", async () => {
    const h = makeHarness({}, { cached: { [botTrafficCacheKey(30)]: cachedPayload } });
    const res = await route("/api/bot-traffic", h.env, await bearer("client"));
    expect(res.status).toBe(403);
    // Auth middleware may read its own KV keys; the handler's must not be read.
    expect(h.cacheGets.filter((k) => k.startsWith("bot_traffic:"))).toEqual([]);
    expect(await res.text()).not.toContain("cloudflare_radar");
  });

  it.each(["analyst", "auditor", "super_admin"] as UserRole[])("staff role %s -> 200", async (role) => {
    const h = makeHarness({}, { cached: { [botTrafficCacheKey(30)]: cachedPayload } });
    const res = await route("/api/bot-traffic", h.env, await bearer(role));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { source: string } };
    expect(body.data.source).toBe("cloudflare_radar");
  });

  it("staff + invalid days -> 400 through the router", async () => {
    const h = makeHarness();
    const res = await route("/api/bot-traffic?days=5", h.env, await bearer("analyst"));
    expect(res.status).toBe(400);
  });
});
