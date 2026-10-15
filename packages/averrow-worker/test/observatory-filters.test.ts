// Observatory cube filters (severity / threat_type / brand) on /nodes, /arcs,
// /stats and /timeline, plus the timeline prior-period `trend` (drill-drawer
// delta).
//
//   1. parse + canonicalise (sort, lowercase, dedupe; 'all' / '' / absent =
//      no filter; unknown → 400 before any KV read or SQL)
//   2. KV keys: no filter → the pre-existing key byte-for-byte (Navigator
//      warm keys unchanged); equivalent spellings → one key
//   3. SQL results over seeded cube rows (migrated schema)
//   4. trend maths, incl. a zero prior
//   5. query plans: every filtered cube read is an index range, never a scan

import { describe, it, expect, beforeAll } from "vitest";
import {
  parseObservatoryFilters,
  observatoryFilterCacheSegment,
  buildObservatoryCubeFilter,
  hasObservatoryFilters,
  NO_OBSERVATORY_FILTERS,
  OBSERVATORY_FILTER_MAX_BINDS,
  OBSERVATORY_THREAT_TYPES,
  NODES_BRAND_UNSUPPORTED_ERROR,
  handleObservatoryNodes,
  handleObservatoryArcs,
  handleObservatoryStats,
} from "../src/handlers/observatory";
import {
  handleObservatoryTimeline,
  computeTimelineTrend,
  periodDeltaPct,
  priorWindowStartMs,
  timelineStartMs,
  TIMELINE_SPECS,
  LENS_MAX_BINDS,
} from "../src/handlers/observatoryLenses";
import { NAVIGATOR_WARM_TARGETS } from "../src/cron/navigator";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

// ─── Harness ────────────────────────────────────────────────────────

function makeEnv(raw: SqliteDb) {
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  const withSession = () => ({ prepare: db.prepare.bind(db), getBookmark: () => null });
  const store = new Map<string, { value: string; metadata: unknown }>();
  const reads: string[] = [];
  const kv = {
    store,
    reads,
    get: async (k: string) => { reads.push(k); return store.get(k)?.value ?? null; },
    getWithMetadata: async (k: string) => {
      reads.push(k);
      const e = store.get(k);
      return { value: e?.value ?? null, metadata: e?.metadata ?? null };
    },
    put: async (k: string, value: string, opts?: { metadata?: unknown }) => {
      store.set(k, { value, metadata: opts?.metadata ?? null });
    },
    delete: async (k: string) => { store.delete(k); },
  };
  const env = { DB: { ...db, prepare: db.prepare, batch: db.batch, withSession }, CACHE: kv } as unknown as Env;
  return { env, kv, log };
}

const req = (path: string) => new Request(`https://averrow.com${path}`);
type Handler = (request: Request, env: Env) => Promise<Response>;

async function body<T>(res: Response): Promise<{ success: boolean; data: T; error?: string; meta?: Record<string, unknown> }> {
  return (await res.json()) as { success: boolean; data: T; error?: string; meta?: Record<string, unknown> };
}

function hourAgo(h: number): string {
  const d = new Date(Date.now() - h * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

const params = (qs: string) => new URL(`https://x/?${qs}`).searchParams;

// ─── 1. Parsing ─────────────────────────────────────────────────────

describe("parseObservatoryFilters", () => {
  it("absent / empty / 'all' → no filter", () => {
    for (const qs of ["", "severity=", "threat_type=", "brand=", "severity=all&threat_type=all&brand=all", "severity=,,", "severity=%20"]) {
      const r = parseObservatoryFilters(params(qs));
      expect(r, qs).toEqual({ ok: true, filters: NO_OBSERVATORY_FILTERS });
      if (r.ok) expect(hasObservatoryFilters(r.filters)).toBe(false);
    }
  });

  it("canonicalises lists: trim, lowercase, dedupe, sort; comma and repeated params agree", () => {
    const a = parseObservatoryFilters(params("severity=High,%20critical,high&threat_type=Phishing,c2"));
    const b = parseObservatoryFilters(params("severity=critical&severity=high&threat_type=c2&threat_type=phishing"));
    expect(a).toEqual({ ok: true, filters: { severity: ["critical", "high"], threatType: ["c2", "phishing"], brand: null } });
    expect(b).toEqual(a);
  });

  it("allow-lists severity against the four ranked values", () => {
    for (const bad of ["info", "unknown", "severe", "critical;--", "all,high"]) {
      const r = parseObservatoryFilters(params(`severity=${encodeURIComponent(bad)}`));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^Invalid severity/);
    }
  });

  it("allow-lists threat_type against the threats CHECK (migration 0013)", () => {
    expect(OBSERVATORY_THREAT_TYPES).toHaveLength(10);
    for (const t of OBSERVATORY_THREAT_TYPES) {
      expect(parseObservatoryFilters(params(`threat_type=${t}`))).toMatchObject({ ok: true, filters: { threatType: [t] } });
    }
    for (const bad of ["unknown", "device_code_phishing", "spam", "phish"]) {
      const r = parseObservatoryFilters(params(`threat_type=${bad}`));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^Invalid threat_type/);
    }
  });

  it("brand: one id matching BRAND_ID_PATTERN, case kept; lists and malformed ids are rejected", () => {
    expect(parseObservatoryFilters(params("brand=brand_PayPal"))).toMatchObject({ ok: true, filters: { brand: "brand_PayPal" } });
    expect(parseObservatoryFilters(params("brand=%20b_1%20"))).toMatchObject({ ok: true, filters: { brand: "b_1" } });
    for (const qs of ["brand=a:b", "brand=a,b", "brand=a&brand=b", `brand=${"x".repeat(129)}`, "brand=%27%3B"]) {
      expect(parseObservatoryFilters(params(qs)).ok, qs).toBe(false);
    }
  });
});

describe("observatoryFilterCacheSegment / buildObservatoryCubeFilter", () => {
  it("no filter → empty suffix; any filter → :f:<sev>:<types>:<brand> with 'all' per absent dimension", () => {
    expect(observatoryFilterCacheSegment(NO_OBSERVATORY_FILTERS)).toBe("");
    expect(observatoryFilterCacheSegment({ severity: ["critical", "high"], threatType: [], brand: null })).toBe(":f:critical,high:all:all");
    expect(observatoryFilterCacheSegment({ severity: [], threatType: ["phishing"], brand: "b_1" })).toBe(":f:all:phishing:b_1");
  });

  it("binds values, never interpolates them", () => {
    const f = { severity: ["critical", "high"] as const, threatType: ["phishing"] as const, brand: "b_1" };
    const r = buildObservatoryCubeFilter(f, { alias: "c", brandColumn: true });
    expect(r.sql).toBe(" AND c.severity IN (?, ?) AND c.threat_type IN (?) AND c.target_brand_id = ?");
    expect(r.params).toEqual(["critical", "high", "phishing", "b_1"]);
    expect(buildObservatoryCubeFilter(NO_OBSERVATORY_FILTERS, { brandColumn: false })).toEqual({ sql: "", params: [] });
  });

  it("refuses a brand filter on a cube without target_brand_id", () => {
    expect(() => buildObservatoryCubeFilter({ severity: [], threatType: [], brand: "b_1" }, { brandColumn: false })).toThrow();
  });

  it("the widest filter stays under the 99-bind budget", () => {
    const widest = parseObservatoryFilters(params(`severity=critical,high,medium,low&threat_type=${OBSERVATORY_THREAT_TYPES.join(",")}&brand=b_1`));
    expect(widest.ok).toBe(true);
    if (!widest.ok) return;
    const r = buildObservatoryCubeFilter(widest.filters, { brandColumn: true });
    expect(r.params).toHaveLength(OBSERVATORY_FILTER_MAX_BINDS);
    // + window start, country, limit, and source (never bound) at most.
    expect(OBSERVATORY_FILTER_MAX_BINDS + 3).toBeLessThanOrEqual(LENS_MAX_BINDS);
  });
});

// ─── Shared seeded DB ───────────────────────────────────────────────

function seedCubes(db: SqliteDb): void {
  db.prepare("INSERT INTO brands (id, name, canonical_domain, hq_country) VALUES ('b_pay', 'PayPal', 'paypal-test.example', 'US')").run();
  db.prepare("INSERT INTO brands (id, name, canonical_domain, hq_country) VALUES ('b_dhl', 'DHL', 'dhl-test.example', 'DE')").run();
  const geo = db.prepare(`INSERT INTO threat_cube_geo
    (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
    VALUES (?, ?, ?, ?, ?, ?, 'urlhaus', ?)`);
  const arcs = db.prepare(`INSERT INTO threat_cube_arcs
    (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed, threat_count, source_lat, source_lng, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, 'urlhaus', ?, ?, ?, ?, ?)`);
  const brand = db.prepare(`INSERT INTO threat_cube_brand
    (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count) VALUES (?, ?, ?, ?, 'urlhaus', ?)`);
  const status = db.prepare(`INSERT INTO threat_cube_status
    (hour_bucket, threat_type, severity, source_feed, status, threat_count) VALUES (?, ?, ?, 'urlhaus', ?, ?)`);

  // Current 7d window (hours 0..167) and prior window (168..335).
  //   US cell (40.7,-74.0): critical phishing 5 @1h, low c2 3 @2h, high phishing 4 @200h (prior)
  //   RU cell (55.7, 37.6): high malware 7 @1h
  geo.run(hourAgo(1), 40.71, -74.01, "US", "phishing", "critical", 5);
  geo.run(hourAgo(2), 40.72, -74.02, "US", "c2", "low", 3);
  geo.run(hourAgo(200), 40.71, -74.01, "US", "phishing", "high", 4);
  geo.run(hourAgo(1), 55.71, 37.61, "RU", "malware_distribution", "high", 7);

  // Arcs: same population, split by brand (b_pay gets everything US + 2 of RU).
  arcs.run(hourAgo(1), "US", "b_pay", "phishing", "critical", 5, 40.7, -74.0, hourAgo(1), hourAgo(1));
  arcs.run(hourAgo(2), "US", "b_pay", "c2", "low", 3, 40.7, -74.0, hourAgo(2), hourAgo(2));
  arcs.run(hourAgo(200), "US", "b_pay", "phishing", "high", 4, 40.7, -74.0, hourAgo(200), hourAgo(200));
  arcs.run(hourAgo(1), "RU", "b_pay", "malware_distribution", "high", 2, 55.7, 37.6, hourAgo(1), hourAgo(1));
  arcs.run(hourAgo(1), "RU", "b_dhl", "malware_distribution", "high", 5, 55.7, 37.6, hourAgo(1), hourAgo(1));

  // Brand cube (active + brand, not necessarily geolocated): b_pay has 1 extra unmapped.
  brand.run(hourAgo(1), "b_pay", "phishing", "critical", 6);
  brand.run(hourAgo(2), "b_pay", "c2", "low", 3);
  brand.run(hourAgo(1), "b_pay", "malware_distribution", "high", 2);
  brand.run(hourAgo(200), "b_pay", "phishing", "high", 4);
  brand.run(hourAgo(1), "b_dhl", "malware_distribution", "high", 5);

  // Status cube (all statuses).
  status.run(hourAgo(1), "phishing", "critical", "active", 6);
  status.run(hourAgo(2), "c2", "low", "active", 3);
  status.run(hourAgo(1), "malware_distribution", "high", "active", 8);
  status.run(hourAgo(1), "phishing", "critical", "remediated", 50);
  status.run(hourAgo(200), "phishing", "high", "active", 4);
}

// ─── 2. KV keys + 400s ──────────────────────────────────────────────

describe.skipIf(!hasSqlite())("cache keys — unfiltered keys unchanged, filters canonical", () => {
  let db: SqliteDb;
  beforeAll(() => { db = openMigratedDb(); seedCubes(db); }, 60_000);

  async function firstKey(handler: Handler, path: string): Promise<string> {
    const { env, kv } = makeEnv(db);
    const res = await handler(req(path), env);
    expect(res.status, path).toBe(200);
    expect(kv.reads.length).toBeGreaterThan(0);
    return kv.reads[0]!;
  }

  const WARMED: Array<{ path: string; key: string; handler: Handler }> = [
    { path: "/api/observatory/nodes?period=7d", key: "observatory_nodes:7d:all:2000", handler: handleObservatoryNodes },
    { path: "/api/observatory/arcs?period=7d", key: "observatory_arcs:7d:all", handler: handleObservatoryArcs },
    { path: "/api/observatory/stats?period=7d", key: "observatory_stats:7d:all", handler: handleObservatoryStats },
    { path: "/api/observatory/nodes?period=24h", key: "observatory_nodes:24h:all:2000", handler: handleObservatoryNodes },
    { path: "/api/observatory/arcs?period=24h", key: "observatory_arcs:24h:all", handler: handleObservatoryArcs },
    { path: "/api/observatory/stats?period=24h", key: "observatory_stats:24h:all", handler: handleObservatoryStats },
    { path: "/api/observatory/nodes?period=30d", key: "observatory_nodes:30d:all:2000", handler: handleObservatoryNodes },
    { path: "/api/observatory/arcs?period=30d", key: "observatory_arcs:30d:all", handler: handleObservatoryArcs },
    { path: "/api/observatory/stats?period=30d", key: "observatory_stats:30d:all", handler: handleObservatoryStats },
  ];

  for (const { path, key, handler } of WARMED) {
    it(`warm target ${path} keeps its pre-filter key and matches every 'no filter' client spelling`, async () => {
      const target = NAVIGATOR_WARM_TARGETS.find((t) => t.path === path);
      expect(target, path).toBeDefined();
      const warmKey = await firstKey(target!.handler, path);
      expect(warmKey).toBe(key);
      for (const noFilter of ["severity=&threat_type=&brand=", "severity=all", "threat_type=all&brand=all", "severity=,"]) {
        expect(await firstKey(handler, `${path}&${noFilter}`), noFilter).toBe(warmKey);
      }
    });
  }

  it("equivalent filter spellings share one key; different filters get different keys", async () => {
    const a = await firstKey(handleObservatoryArcs, "/api/observatory/arcs?period=7d&severity=High,critical&threat_type=Phishing&brand=b_pay");
    const b = await firstKey(handleObservatoryArcs, "/api/observatory/arcs?period=7d&brand=b_pay&threat_type=phishing&severity=critical&severity=high&severity=high");
    expect(a).toBe("observatory_arcs:7d:all:f:critical,high:phishing:b_pay");
    expect(b).toBe(a);
    const c = await firstKey(handleObservatoryArcs, "/api/observatory/arcs?period=7d&severity=critical");
    expect(c).toBe("observatory_arcs:7d:all:f:critical:all:all");
    expect(await firstKey(handleObservatoryNodes, "/api/observatory/nodes?period=7d&threat_type=c2&limit=50"))
      .toBe("observatory_nodes:7d:all:50:f:all:c2:all");
    expect(await firstKey(handleObservatoryStats, "/api/observatory/stats?period=24h&source_feed=feeds&brand=b_pay"))
      .toBe("observatory_stats:24h:feeds:f:all:all:b_pay");
  });

  it("timeline: unfiltered keys unchanged; filters append the same suffix", async () => {
    expect(await firstKey(handleObservatoryTimeline, "/api/observatory/timeline?period=7d&country=us&severity="))
      .toBe("cv:observatory_lens.timeline:7d:all:US");
    expect(await firstKey(handleObservatoryTimeline, "/api/observatory/timeline?period=7d&country=US&severity=low,critical&brand=b_pay"))
      .toBe("cv:observatory_lens.timeline:7d:all:US:f:critical,low:all:b_pay");
  });

  it("brands_distinct cachedValue key carries the filter suffix (unfiltered key unchanged)", async () => {
    const { env, kv } = makeEnv(db);
    await handleObservatoryStats(req("/api/observatory/stats?period=7d"), env);
    await handleObservatoryStats(req("/api/observatory/stats?period=7d&threat_type=c2"), env);
    expect([...kv.store.keys()].filter((k) => k.includes("brands_distinct")).sort()).toEqual([
      "cv:observatory.brands_distinct:168h:all",
      "cv:observatory.brands_distinct:168h:all:f:all:c2:all",
    ]);
  });

  const BAD: Array<{ handler: Handler; path: string; error: RegExp }> = [
    { handler: handleObservatoryNodes, path: "/api/observatory/nodes?severity=info", error: /^Invalid severity/ },
    { handler: handleObservatoryNodes, path: "/api/observatory/nodes?brand=b_pay", error: /brand filter is not supported on \/nodes/ },
    { handler: handleObservatoryArcs, path: "/api/observatory/arcs?threat_type=spam", error: /^Invalid threat_type/ },
    { handler: handleObservatoryArcs, path: "/api/observatory/arcs?brand=a,b", error: /^Invalid brand/ },
    { handler: handleObservatoryArcs, path: "/api/observatory/arcs?brand=a&brand=b", error: /single brand id/ },
    { handler: handleObservatoryStats, path: "/api/observatory/stats?brand=bad:id", error: /^Invalid brand/ },
    { handler: handleObservatoryTimeline, path: "/api/observatory/timeline?severity=bogus", error: /^Invalid severity/ },
    { handler: handleObservatoryTimeline, path: "/api/observatory/timeline?velocity=fast&severity=high", error: /not supported with velocity/ },
  ];
  for (const { handler, path, error } of BAD) {
    it(`400 before any KV read or SQL: ${path}`, async () => {
      const { env, kv, log } = makeEnv(db);
      const res = await handler(req(path), env);
      expect(res.status).toBe(400);
      const b = await body<unknown>(res);
      expect(b.success).toBe(false);
      expect(b.error).toMatch(error);
      expect(kv.reads).toEqual([]);
      expect(log).toEqual([]);
    });
  }

  it("nodes brand error names the alternative", () => {
    expect(NODES_BRAND_UNSUPPORTED_ERROR).toMatch(/arcs|stats/);
  });
});

// ─── 3. SQL results on seeded cube rows ─────────────────────────────

describe.skipIf(!hasSqlite())("filtered results over seeded cubes", () => {
  let db: SqliteDb;
  beforeAll(() => { db = openMigratedDb(); seedCubes(db); }, 60_000);

  it("nodes: severity and threat_type filter the geo cube", async () => {
    const { env } = makeEnv(db);
    type Node = { lat: number; lng: number; threat_count: number; top_severity: string; country_code: string; top_threat_type: string };
    const all = await body<Node[]>(await handleObservatoryNodes(req("/api/observatory/nodes?period=7d"), env));
    expect(all.data.map((n) => [n.country_code, n.threat_count])).toEqual([["US", 8], ["RU", 7]]);

    const crit = await body<Node[]>(await handleObservatoryNodes(req("/api/observatory/nodes?period=7d&severity=critical"), env));
    expect(crit.data).toEqual([expect.objectContaining({ country_code: "US", threat_count: 5, top_severity: "critical", top_threat_type: "phishing" })]);

    const typed = await body<Node[]>(await handleObservatoryNodes(req("/api/observatory/nodes?period=7d&threat_type=c2,malware_distribution"), env));
    expect(typed.data.map((n) => [n.country_code, n.threat_count, n.top_threat_type])).toEqual([["RU", 7, "malware_distribution"], ["US", 3, "c2"]]);

    const none = await body<Node[]>(await handleObservatoryNodes(req("/api/observatory/nodes?period=7d&severity=medium"), env));
    expect(none.data).toEqual([]);
  });

  it("arcs: brand + severity + threat_type filter the arcs cube; a filtered empty result never falls back to raw threats", async () => {
    const { env, log } = makeEnv(db);
    type Arc = { source_region: string; target_brand: string; target_brand_id: string | null; threat_type: string; volume: number; severity: string };
    const all = await body<Arc[]>(await handleObservatoryArcs(req("/api/observatory/arcs?period=7d"), env));
    expect(all.data.map((a) => `${a.source_region}>${a.target_brand}:${a.threat_type}=${a.volume}`).sort()).toEqual([
      "RU>DHL:malware_distribution=5", "RU>PayPal:malware_distribution=2", "US>PayPal:c2=3", "US>PayPal:phishing=5",
    ]);
    // Every arc carries its brand id: the client filters by id, never by looking a name up.
    expect(all.data.map((a) => `${a.target_brand}=${a.target_brand_id}`).sort()).toEqual(["DHL=b_dhl", "PayPal=b_pay", "PayPal=b_pay", "PayPal=b_pay"]);
    const dhl = await body<Arc[]>(await handleObservatoryArcs(req("/api/observatory/arcs?period=7d&brand=b_dhl"), env));
    expect(dhl.data).toEqual([expect.objectContaining({ source_region: "RU", target_brand: "DHL", target_brand_id: "b_dhl", volume: 5, severity: "high" })]);
    const pay = await body<Arc[]>(await handleObservatoryArcs(req("/api/observatory/arcs?period=30d&brand=b_pay&threat_type=phishing&severity=high,critical"), env));
    // 30d includes the 200h-old high phishing row → volume 9, top severity critical.
    expect(pay.data).toEqual([expect.objectContaining({ source_region: "US", threat_type: "phishing", volume: 9, severity: "critical" })]);

    log.length = 0;
    const empty = await body<Arc[]>(await handleObservatoryArcs(req("/api/observatory/arcs?period=7d&brand=b_none"), env));
    expect(empty.data).toEqual([]);
    expect(log.some((l) => /FROM threats\b/.test(l.sql))).toBe(false);
  });

  it("stats: filters apply to every cube tile; brand swaps geo → arcs and status → brand cube", async () => {
    const { env } = makeEnv(db);
    type Stats = { threats_mapped: number; threats_total: number; geo_coverage_pct: number | null; countries: number; brands_monitored: number };
    const all = await body<Stats>(await handleObservatoryStats(req("/api/observatory/stats?period=7d"), env));
    expect(all.data).toMatchObject({ threats_mapped: 15, threats_total: 17, countries: 2, brands_monitored: 2 });

    const high = await body<Stats>(await handleObservatoryStats(req("/api/observatory/stats?period=7d&severity=high"), env));
    expect(high.data).toMatchObject({ threats_mapped: 7, threats_total: 8, countries: 1, brands_monitored: 2 });

    const pay = await body<Stats>(await handleObservatoryStats(req("/api/observatory/stats?period=7d&brand=b_pay"), env));
    // arcs: 5+3+2 = 10 mapped in 2 countries; brand cube: 6+3+2 = 11 active.
    expect(pay.data).toMatchObject({ threats_mapped: 10, threats_total: 11, geo_coverage_pct: 91, countries: 2, brands_monitored: 1 });

    const payPhish = await body<Stats>(await handleObservatoryStats(req("/api/observatory/stats?period=7d&brand=b_pay&threat_type=phishing"), env));
    expect(payPhish.data).toMatchObject({ threats_mapped: 5, threats_total: 6, countries: 1, brands_monitored: 1 });
  });

  it("timeline: filters pick the cube per (country, brand) and filter it", async () => {
    const { env, log } = makeEnv(db);
    type TL = { points: Array<{ total: number }>; trend: { current: number } };
    const sum = (b: { data: TL }) => b.data.points.reduce((s, p) => s + p.total, 0);

    const status = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&severity=low,critical"), env));
    expect(sum(status)).toBe(9); // active only: 6 critical + 3 low
    const brand = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&brand=b_pay"), env));
    expect(sum(brand)).toBe(11);
    const usPay = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=US&brand=b_pay&threat_type=phishing"), env));
    expect(sum(usPay)).toBe(5);
    const ruType = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=RU&threat_type=malware_distribution"), env));
    expect(sum(ruType)).toBe(7);

    const cubes = log.map((l) => /FROM (threat_cube_\w+)/.exec(l.sql)?.[1]).filter(Boolean);
    expect(cubes).toEqual(["threat_cube_status", "threat_cube_brand", "threat_cube_arcs", "threat_cube_geo"]);
    // every filter value is bound: nothing quoted in the WHERE clause but the
    // fixed status literal.
    for (const l of log) {
      const where = l.sql.slice(l.sql.indexOf("WHERE"));
      expect(where).not.toMatch(/'(b_pay|phishing|malware_distribution|critical|low|US|RU)'/);
      expect(l.binds).toEqual(expect.arrayContaining([expect.any(String)]));
    }
  });
});

// ─── 4. Trend (prior-period delta) ──────────────────────────────────

describe("periodDeltaPct", () => {
  it("percent change, one decimal", () => {
    expect(periodDeltaPct(150, 100)).toBe(50);
    expect(periodDeltaPct(50, 100)).toBe(-50);
    expect(periodDeltaPct(100, 100)).toBe(0);
    expect(periodDeltaPct(1, 3)).toBe(-66.7);
    expect(periodDeltaPct(2, 3)).toBe(-33.3);
    expect(periodDeltaPct(0, 7)).toBe(-100);
  });
  it("zero prior → null (no baseline), never Infinity / NaN", () => {
    expect(periodDeltaPct(5, 0)).toBeNull();
    expect(periodDeltaPct(0, 0)).toBeNull();
  });
});

describe("computeTimelineTrend", () => {
  const spec = TIMELINE_SPECS["7d"];
  const now = new Date("2026-10-15T10:30:00Z");
  const start = timelineStartMs(spec, now);
  const hb = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const H = 3_600_000;

  it("prior window is the equal-length window ending at the current start", () => {
    expect(new Date(start).toISOString()).toBe("2026-10-08T11:00:00.000Z");
    expect(new Date(priorWindowStartMs(spec, start)).toISOString()).toBe("2026-10-01T11:00:00.000Z");
    const d90 = TIMELINE_SPECS["90d"];
    const s90 = timelineStartMs(d90, now);
    expect((s90 - priorWindowStartMs(d90, s90)) / (24 * H)).toBe(90);
  });

  it("splits rows at the window boundaries (inclusive start, exclusive end)", () => {
    const t = computeTimelineTrend([
      { hour_bucket: hb(start), total: 4 },               // first current hour
      { hour_bucket: hb(start + 167 * H), total: 6 },     // current (partial) hour
      { hour_bucket: hb(start - H), total: 2 },           // last prior hour
      { hour_bucket: hb(start - 168 * H), total: 3 },     // first prior hour
      { hour_bucket: hb(start - 169 * H), total: 100 },   // before the prior window
      { hour_bucket: "garbage", total: 100 },
      { hour_bucket: hb(start + H), total: null },
    ], spec, start);
    expect(t).toEqual({
      current: 10, prior: 5, delta_pct: 100,
      current_start: "2026-10-08T11:00:00.000Z", prior_start: "2026-10-01T11:00:00.000Z",
    });
  });

  it("zero prior", () => {
    expect(computeTimelineTrend([{ hour_bucket: hb(start), total: 3 }], spec, start))
      .toMatchObject({ current: 3, prior: 0, delta_pct: null });
    expect(computeTimelineTrend([], spec, start)).toMatchObject({ current: 0, prior: 0, delta_pct: null });
  });
});

describe.skipIf(!hasSqlite())("timeline?country= trend over the geo cube", () => {
  let db: SqliteDb;
  beforeAll(() => { db = openMigratedDb(); seedCubes(db); }, 60_000);

  type TL = { points: Array<{ total: number }>; trend: { current: number; prior: number; delta_pct: number | null; current_start: string; prior_start: string } };

  it("US 7d: current 8 (5 + 3) vs prior 4 → +100%; current == sum(points)", async () => {
    const { env, log } = makeEnv(db);
    const b = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=US"), env));
    expect(b.data.trend).toMatchObject({ current: 8, prior: 4, delta_pct: 100 });
    expect(b.data.trend.current).toBe(b.data.points.reduce((s, p) => s + p.total, 0));
    expect(b.data.trend.current_start).toBe((b.data.points[0] as unknown as { t: string }).t);
    // One cube read spans both windows, on threat_cube_geo.
    const reads = log.filter((l) => /FROM threat_cube_geo/.test(l.sql));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.binds?.[0]).toBe(b.data.trend.prior_start.replace("T", " ").slice(0, 19));
  });

  it("RU 7d: prior 0 → delta_pct null", async () => {
    const { env } = makeEnv(db);
    const b = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=RU"), env));
    expect(b.data.trend).toMatchObject({ current: 7, prior: 0, delta_pct: null });
  });

  it("24h: the 200h-old row is in neither window; filters apply to the trend", async () => {
    const { env } = makeEnv(db);
    const b = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h&country=US"), env));
    expect(b.data.trend).toMatchObject({ current: 8, prior: 0, delta_pct: null });
    const crit = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=US&severity=critical"), env));
    expect(crit.data.trend).toMatchObject({ current: 5, prior: 0, delta_pct: null });
    const high = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&country=US&severity=high"), env));
    expect(high.data.trend).toMatchObject({ current: 0, prior: 4, delta_pct: -100 });
  });

  it("velocity series carries a trend too", async () => {
    const { env } = makeEnv(db);
    const b = await body<TL>(await handleObservatoryTimeline(req("/api/observatory/timeline?period=7d&velocity=all"), env));
    expect(b.data.trend).toMatchObject({ current: 0, prior: 0, delta_pct: null });
  });
});

// ─── 5. Query plans (fully migrated schema) ─────────────────────────

describe.skipIf(!hasSqlite())("filtered cube reads stay on the cube indexes", () => {
  interface Planned { sql: string; plan: string }
  const modes: Record<string, Planned[]> = {};

  async function planAll(db: SqliteDb): Promise<Planned[]> {
    const { env, log } = makeEnv(db);
    const paths: Array<[Handler, string]> = [
      [handleObservatoryNodes, "/api/observatory/nodes?period=7d&severity=critical,high&threat_type=phishing"],
      [handleObservatoryArcs, "/api/observatory/arcs?period=30d&severity=high&threat_type=phishing,c2"],
      [handleObservatoryArcs, "/api/observatory/arcs?period=30d&brand=b_7"],
      [handleObservatoryStats, "/api/observatory/stats?period=7d&threat_type=phishing&severity=low"],
      [handleObservatoryStats, "/api/observatory/stats?period=30d&brand=b_7&severity=critical"],
      [handleObservatoryTimeline, "/api/observatory/timeline?period=7d&threat_type=phishing"],
      [handleObservatoryTimeline, "/api/observatory/timeline?period=7d&brand=b_7"],
      [handleObservatoryTimeline, "/api/observatory/timeline?period=7d&country=US&severity=high"],
      [handleObservatoryTimeline, "/api/observatory/timeline?period=90d&country=US&brand=b_7"],
    ];
    for (const [h, p] of paths) expect((await h(req(p), env)).status, p).toBe(200);
    return log
      .filter((e) => e.error === undefined && /FROM threat_cube_/.test(e.sql))
      .map((e) => ({
        sql: e.sql.replace(/\s+/g, " "),
        plan: (db.prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...(e.binds ?? [])) as Array<{ detail: string }>)
          .map((r) => r.detail).join(" | "),
      }));
  }

  beforeAll(async () => {
    const db = openMigratedDb();
    seedCubes(db);
    // Spread rows over 60 days × several dims so the planner has a real choice.
    db.exec("BEGIN");
    const geo = db.prepare(`INSERT OR IGNORE INTO threat_cube_geo
      (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count) VALUES (?, ?, 1, ?, ?, ?, 'f', 1)`);
    const arcs = db.prepare(`INSERT OR IGNORE INTO threat_cube_arcs
      (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed, threat_count) VALUES (?, ?, ?, ?, ?, 'f', 1)`);
    const brand = db.prepare(`INSERT OR IGNORE INTO threat_cube_brand
      (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count) VALUES (?, ?, ?, ?, 'f', 1)`);
    const status = db.prepare(`INSERT OR IGNORE INTO threat_cube_status
      (hour_bucket, threat_type, severity, source_feed, status, threat_count) VALUES (?, ?, ?, 'f', ?, 1)`);
    const sev = ["critical", "high", "medium", "low"];
    const cc = ["US", "RU", "CN", "DE", "NL"];
    for (let h = 0; h < 60 * 24; h++) {
      const hb = hourAgo(h);
      for (let k = 0; k < 12; k++) {
        const tt = OBSERVATORY_THREAT_TYPES[k % 10]!;
        geo.run(hb, k, cc[k % 5]!, tt, sev[k % 4]!);
        arcs.run(hb, cc[k % 5]!, `b_${k}`, tt, sev[k % 4]!);
        brand.run(hb, `b_${k}`, tt, sev[k % 4]!);
        status.run(hb, tt, sev[k % 4]!, k % 3 ? "active" : "remediated");
      }
    }
    db.exec("COMMIT");
    modes["no stats"] = await planAll(db);
    db.exec("ANALYZE");
    modes["ANALYZE"] = await planAll(db);
  }, 120_000);

  for (const mode of ["no stats", "ANALYZE"]) {
    it(`${mode}: no filtered cube read full-scans its cube; brand reads seek the brand index`, () => {
      const planned = modes[mode]!;
      expect(planned.length).toBeGreaterThanOrEqual(12);
      for (const p of planned) {
        const cube = /FROM (threat_cube_\w+)/.exec(p.sql)![1]!;
        expect(p.plan, p.sql).toMatch(new RegExp(`SEARCH (\\w+ )?USING (COVERING )?INDEX (idx_cube_\\w+|sqlite_autoindex_${cube}_1)`));
        expect(p.plan, p.sql).not.toMatch(/\bSCAN threat_cube_/);
        // /arcs aliases the cube as `c` (in /nodes `c` is the CTE `cells`).
        if (/FROM threat_cube_arcs c\b/.test(p.sql)) expect(p.plan, p.sql).not.toMatch(/\bSCAN c\b/);
      }
      // COUNT(DISTINCT …) with a severity/type filter would otherwise walk
      // the whole (country|brand, hour) index non-covering without stats.
      const distinctGeo = planned.find((x) => /COUNT\(DISTINCT country_code\) AS n FROM threat_cube_geo/.test(x.sql));
      expect(distinctGeo!.plan).toContain("SEARCH threat_cube_geo USING INDEX idx_cube_geo_hour (hour_bucket>?)");
      const distinctBrand = planned.find((x) => /COUNT\(DISTINCT target_brand_id\) AS n FROM threat_cube_brand INDEXED BY/.test(x.sql));
      expect(distinctBrand!.plan).toContain("SEARCH threat_cube_brand USING INDEX idx_cube_brand_hour (hour_bucket>?)");
      for (const p of planned.filter((x) => /target_brand_id = \?/.test(x.sql))) {
        expect(p.plan, p.sql).toMatch(/idx_cube_(arcs|brand)_(brand|id)_hour \(target_brand_id=\? AND hour_bucket>\?\)/);
      }
    });
  }
});
