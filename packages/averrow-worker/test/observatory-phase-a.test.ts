// Observatory overhaul Phase A — backend correctness pins.
//
//   - period allow-list + limit clamping (canonicalised before the KV key)
//   - severity ranking (never alphabetical MAX)
//   - arc target resolution order: hq_lat/lng → hq_country centroid → exact
//     dictionary → dropped (counted); no attacker-continent fallback, no jitter
//   - nodes: limit honoured + keyed; top country by count, never 'XX'
//   - stats: coverage numerator/denominator are the same population
//   - heatmap: cube-served, weighted, deterministic, source_feed-aware
//   - brand-arcs: 400 / 404 / cached / target_precision
//   - refresh-warm: only an in-process marked Request bypasses a fresh key

import { describe, it, expect } from "vitest";
import {
  parseObservatoryPeriod,
  parseObservatoryLimit,
  topSeverity,
  resolveBrandTarget,
  assembleArcs,
  snappedWindowStart,
  handleObservatoryNodes,
  handleObservatoryArcs,
  handleObservatoryStats,
  handleObservatoryHeatmap,
  handleObservatoryBrandArcs,
  handleObservatoryLive,
  handleObservatoryOperations,
  OBSERVATORY_TTL_S,
  BRAND_ID_PATTERN,
  type ArcRow,
} from "../src/handlers/observatory";
import {
  markCacheRefresh,
  isCacheRefresh,
  readRefreshableCache,
  refreshAfterSeconds,
  refreshMarginSeconds,
  refreshSkewSeconds,
  CACHE_REFRESH_MARGIN_S,
  CACHE_REFRESH_SKEW_S,
} from "../src/lib/cache-refresh";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

// ─── KV with metadata ───────────────────────────────────────────────

interface KvEntry { value: string; metadata: unknown; ttl?: number }
function metaKv() {
  const store = new Map<string, KvEntry>();
  const kv = {
    store,
    get: async (k: string) => store.get(k)?.value ?? null,
    getWithMetadata: async (k: string) => {
      const e = store.get(k);
      return { value: e?.value ?? null, metadata: e?.metadata ?? null };
    },
    put: async (k: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }) => {
      store.set(k, { value, metadata: opts?.metadata ?? null, ttl: opts?.expirationTtl });
    },
    delete: async (k: string) => { store.delete(k); },
  };
  return kv;
}

function makeEnv(raw: SqliteDb, log: StatementLogEntry[] = []) {
  const db = d1FromSqlite(raw, { log });
  const withSession = () => ({ prepare: db.prepare.bind(db), getBookmark: () => null });
  const kv = metaKv();
  const env = { DB: { ...db, prepare: db.prepare, batch: db.batch, withSession }, CACHE: kv } as unknown as Env;
  return { env, kv, log };
}

const req = (path: string) => new Request(`https://averrow.com${path}`);

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function hourAgo(h: number): string {
  const d = new Date(Date.now() - h * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// ─── 1. Param parsing ───────────────────────────────────────────────

describe("parseObservatoryPeriod", () => {
  it("allow-lists 24h|7d|30d|90d", () => {
    for (const p of ["24h", "7d", "30d", "90d"]) expect(parseObservatoryPeriod(p)).toBe(p);
  });
  it("canonicalises unknown / missing to 7d (incl. the retired 'all')", () => {
    for (const p of [null, "", "all", "365d", "7D", "7d ", "x"]) expect(parseObservatoryPeriod(p)).toBe("7d");
  });
});

describe("parseObservatoryLimit", () => {
  it("defaults on missing / empty / NaN", () => {
    expect(parseObservatoryLimit(null, 20, 50)).toBe(20);
    expect(parseObservatoryLimit("", 20, 50)).toBe(20);
    expect(parseObservatoryLimit("abc", 20, 50)).toBe(20);
    expect(parseObservatoryLimit("Infinity", 20, 50)).toBe(20);
  });
  it("clamps to [1, max] and floors", () => {
    expect(parseObservatoryLimit("-1", 20, 50)).toBe(1);
    expect(parseObservatoryLimit("0", 20, 50)).toBe(1);
    expect(parseObservatoryLimit("999", 20, 50)).toBe(50);
    expect(parseObservatoryLimit("7.9", 20, 50)).toBe(7);
  });
});

describe("snappedWindowStart", () => {
  it("snaps to the top of the hour", () => {
    expect(snappedWindowStart("24h", new Date("2026-05-22T16:47:12Z"))).toBe("2026-05-21 16:00:00");
    expect(snappedWindowStart("90d", new Date("2026-05-22T16:47:12Z"))).toBe("2026-02-21 16:00:00");
  });
});

// ─── 2. Severity ranking ────────────────────────────────────────────

describe("topSeverity", () => {
  it("ranks critical > high > medium > low > unknown (not alphabetical)", () => {
    expect(topSeverity({ critical: 1, high: 0, medium: 5, low: 9 })).toBe("critical");
    expect(topSeverity({ critical: 0, high: 2, medium: 5, low: 9 })).toBe("high");
    expect(topSeverity({ critical: 0, high: 0, medium: 1, low: 9 })).toBe("medium");
    expect(topSeverity({ critical: 0, high: 0, medium: 0, low: 1 })).toBe("low");
    expect(topSeverity({ critical: 0, high: 0, medium: 0, low: 0 })).toBe("unknown");
  });
});

// ─── 3. Arc target resolution ───────────────────────────────────────

const base = { name: null, canonical_domain: null, hq_lat: null, hq_lng: null, hq_country: null };

describe("resolveBrandTarget", () => {
  it("1. an EXACT dictionary match wins over enricher coords (those are often a CDN edge)", () => {
    expect(resolveBrandTarget({ ...base, name: "PayPal", canonical_domain: "paypal.com", hq_lat: 10, hq_lng: 20, hq_country: "DE" }))
      .toEqual({ position: [-121.9687, 37.379], precision: "hq" });
  });
  it("2. then hq_lat/hq_lng", () => {
    expect(resolveBrandTarget({ ...base, name: "Obscure Co", hq_lat: 10, hq_lng: 20, hq_country: "DE" }))
      .toEqual({ position: [20, 10], precision: "hq" });
  });
  it("3. then the hq_country centroid", () => {
    const r = resolveBrandTarget({ ...base, name: "Obscure Co", hq_country: "de" });
    expect(r?.precision).toBe("country");
    expect(r?.position).toEqual([10.4, 51.1]);
  });
  it("dictionary matches by domain, then name slug", () => {
    expect(resolveBrandTarget({ ...base, canonical_domain: "www.PayPal.com" })).toEqual({ position: [-121.9687, 37.379], precision: "hq" });
    expect(resolveBrandTarget({ ...base, name: "Bank of America" })?.precision).toBe("hq");
  });
  it("loose substring matches are gone", () => {
    expect(resolveBrandTarget({ ...base, name: "Targetry Ltd" })).toBeNull();
    expect(resolveBrandTarget({ ...base, canonical_domain: "apple-bank.com", name: "Apple Bank" })).toBeNull();
    expect(resolveBrandTarget({ ...base, canonical_domain: "login.paypal.com.evil.ru" })).toBeNull();
  });
  it("4. unknown → null (never the attacker's continent); (0,0) and unknown country ignored", () => {
    expect(resolveBrandTarget({ ...base, name: "Obscure Co" })).toBeNull();
    expect(resolveBrandTarget({ ...base, hq_lat: 0, hq_lng: 0, hq_country: "ZZ" })).toBeNull();
  });
});

function arcRow(over: Partial<ArcRow>): ArcRow {
  return {
    source_lat: 50, source_lng: 30, threat_type: "phishing", source_country: "UA",
    target_brand: "Obscure", target_domain: "obscure.example", target_sector: null,
    hq_lat: null, hq_lng: null, hq_country: null, volume: 3,
    critical: 0, high: 1, medium: 2, low: 0, first_seen: null, last_seen: null, ...over,
  };
}

describe("assembleArcs", () => {
  it("drops + counts unknown targets and missing sources; deterministic (no jitter)", () => {
    const rows = [
      arcRow({ hq_lat: 1, hq_lng: 2 }),
      arcRow({ hq_country: "FR" }),
      arcRow({}),
      arcRow({ hq_country: "FR", source_lat: null, source_lng: null }),
      arcRow({ hq_country: "FR", source_country: "XX" }),
    ];
    const a = assembleArcs(rows);
    expect(a.dropped_unknown_target).toBe(1);
    expect(a.dropped_no_source).toBe(1);
    expect(a.arcs.map((x) => x.target_precision)).toEqual(["hq", "country", "country"]);
    expect(a.arcs[0].targetPosition).toEqual([2, 1]);
    expect(a.arcs[0].severity).toBe("high");
    expect(a.arcs[2].source_region).toBe("Unknown");
    expect(assembleArcs(rows)).toEqual(a);
  });
});

// ─── 4. Refresh marker ──────────────────────────────────────────────

describe("cache refresh marker", () => {
  it("only the marked Request object is a refresh; headers can't forge it", () => {
    const r = new Request("https://x/api/observatory/nodes", { headers: { "x-cache-refresh": "1", "x-navigator-warm": "1" } });
    expect(isCacheRefresh(r)).toBe(false);
    expect(isCacheRefresh(r.clone())).toBe(false);
    const m = markCacheRefresh(new Request("https://x/api/observatory/nodes"));
    expect(isCacheRefresh(m)).toBe(true);
    expect(isCacheRefresh(new Request(m.url, { headers: m.headers }))).toBe(false);
  });

  it("refresh reads recompute once within the margin of expiry; live reads never do", async () => {
    const kv = metaKv();
    const now = 1_000_000_000;
    await kv.put("k", "v", { metadata: { cachedAt: now - 10_000 } }); // 10s old
    const live = new Request("https://x/");
    const warm = markCacheRefresh(new Request("https://x/"));
    const cache = kv as unknown as KVNamespace;
    // TTL 7200 → margin min(1800, 3600) = 1800, skew 60 → refresh after 5340s
    expect(refreshAfterSeconds(7200)).toBe(7200 - CACHE_REFRESH_MARGIN_S - CACHE_REFRESH_SKEW_S);
    expect(await readRefreshableCache(warm, cache, "k", 7200, now)).toBe("v");
    expect(await readRefreshableCache(warm, cache, "k", 7200, now + 5_320_000)).toBe("v"); // age 5330s
    expect(await readRefreshableCache(warm, cache, "k", 7200, now + 5_340_000)).toBeNull(); // age 5350s
    expect(await readRefreshableCache(live, cache, "k", 7200, now + 5_400_000)).toBe("v");
    // A short key is NOT recomputed on every warm: 900s → margin 450s, skew 60s → 390s.
    expect(await readRefreshableCache(warm, cache, "k", 900, now)).toBe("v");
    expect(await readRefreshableCache(warm, cache, "k", 900, now + 370_000)).toBe("v"); // age 380s
    expect(await readRefreshableCache(warm, cache, "k", 900, now + 385_000)).toBeNull(); // age 395s
    // Unstamped legacy entries refresh
    await kv.put("legacy", "v");
    expect(await readRefreshableCache(warm, cache, "legacy", 7200, now)).toBeNull();
  });
});

describe("refresh margin is relative to the TTL", () => {
  it("margin = min(1800, ttl/2); never refreshes a fresh key, never lets one lapse", () => {
    expect(refreshMarginSeconds(7200)).toBe(1800);
    expect(refreshMarginSeconds(3600)).toBe(1800);
    expect(refreshMarginSeconds(1800)).toBe(900);
    expect(refreshMarginSeconds(900)).toBe(450);
    expect(refreshMarginSeconds(60)).toBe(30);
    for (const ttl of [60, 300, 900, 1800, 3600, 7200, 86_400]) {
      const after = refreshAfterSeconds(ttl);
      expect(after).toBeGreaterThan(0);   // a just-written key is served
      expect(after).toBeLessThan(ttl);    // refresh happens before expiry
    }
  });

  it("Phase A cadence (600s) on a 1800s key recomputes every OTHER warm and never lapses", () => {
    const ttl = OBSERVATORY_TTL_S.nodes;
    expect(ttl).toBe(1800);
    // Simulate warms every 600s starting from a fresh write at t=0.
    let writtenAt = 0;
    const recomputes: number[] = [];
    for (let t = 600; t <= 6000; t += 600) {
      const age = t - writtenAt;
      expect(age).toBeLessThan(ttl); // the live path never sees a lapsed key
      if (age >= refreshAfterSeconds(ttl)) { recomputes.push(t); writtenAt = t; }
    }
    expect(recomputes).toEqual([1200, 2400, 3600, 4800, 6000]);
  });

  it("A2 cadence (900s) on a 1800s key refreshes before expiry", () => {
    expect(OBSERVATORY_TTL_S.heatmap).toBe(1800);
    expect(OBSERVATORY_TTL_S.stats).toBe(1800);
    expect(900).toBeGreaterThanOrEqual(refreshAfterSeconds(1800));
  });

  it("skew: an A2 warm landing ON the old 900s threshold (jitter → age 899.x s) still refreshes", async () => {
    // Pre-skew the threshold was exactly 900s = the A2 cadence. A warm whose
    // previous write landed later in its tick than this read reads the age
    // back as 899.x s → served as a hit → the next warm (900s later) finds
    // the 1800s key already expired.
    expect(refreshSkewSeconds(1800)).toBe(CACHE_REFRESH_SKEW_S);
    expect(refreshAfterSeconds(1800)).toBe(840);
    const kv = metaKv();
    const cache = kv as unknown as KVNamespace;
    const warm = markCacheRefresh(new Request("https://x/"));
    const writtenAt = 2_000_000_000;
    await kv.put("a2", "v", { metadata: { cachedAt: writtenAt } });
    for (const ageMs of [899_400, 900_000, 900_600, 850_000]) {
      expect(await readRefreshableCache(warm, cache, "a2", 1800, writtenAt + ageMs)).toBeNull();
    }
    // A fresh-ish key is still served (no recompute storm).
    expect(await readRefreshableCache(warm, cache, "a2", 1800, writtenAt + 600_000)).toBe("v");
    // Simulated A2 cadence with ±1s jitter never lets the key lapse.
    let lastWrite = 0;
    for (let k = 1; k <= 12; k++) {
      const t = k * 900 + (k % 2 === 0 ? -0.6 : 0.6);
      const age = t - lastWrite;
      expect(age).toBeLessThan(1800);
      if (age >= refreshAfterSeconds(1800)) lastWrite = t;
      expect(lastWrite).toBe(t); // every A2 warm refreshes
    }
  });

  it("skew stays a small fraction of short TTLs (threshold > 0)", () => {
    expect(refreshSkewSeconds(60)).toBe(7.5);
    expect(refreshAfterSeconds(60)).toBe(22.5);
  });
});

// ─── 5. Handlers against real SQLite ────────────────────────────────

const TABLES = ["threats", "brands", "campaigns", "threat_cube_geo", "threat_cube_status", "threat_cube_brand", "threat_cube_arcs"];

function geo(raw: SqliteDb, r: { hour?: string; lat: number; lng: number; cc: string; type?: string; sev: string; feed?: string; n: number }) {
  raw.prepare(`INSERT INTO threat_cube_geo (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed, threat_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(r.hour ?? hourAgo(2), r.lat, r.lng, r.cc, r.type ?? "phishing", r.sev, r.feed ?? "phishtank", r.n);
}
function statusCube(raw: SqliteDb, r: { status: string; feed?: string; n: number }) {
  raw.prepare(`INSERT INTO threat_cube_status (hour_bucket, threat_type, severity, source_feed, status, threat_count)
    VALUES (?, 'phishing', 'high', ?, ?, ?)`).run(hourAgo(2), r.feed ?? "phishtank", r.status, r.n);
}
function brand(raw: SqliteDb, b: { id: string; name: string; domain: string; hq_lat?: number | null; hq_lng?: number | null; hq_country?: string | null }) {
  raw.prepare(`INSERT INTO brands (id, name, canonical_domain, hq_lat, hq_lng, hq_country) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(b.id, b.name, b.domain, b.hq_lat ?? null, b.hq_lng ?? null, b.hq_country ?? null);
}
function arcsCube(raw: SqliteDb, r: { brand: string; cc: string; sev: string; n: number; lat?: number | null; lng?: number | null; feed?: string }) {
  raw.prepare(`INSERT INTO threat_cube_arcs (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed, threat_count, source_lat, source_lng, first_seen, last_seen)
    VALUES (?, ?, ?, 'phishing', ?, ?, ?, ?, ?, ?, ?)`)
    .run(hourAgo(2), r.cc, r.brand, r.sev, r.feed ?? "phishtank", r.n, r.lat === undefined ? 50 : r.lat, r.lng === undefined ? 30 : r.lng, hourAgo(2), hourAgo(2));
}

describe.skipIf(!hasSqlite())("observatory handlers — real SQLite", () => {
  it("nodes: ranked severity, top country by count (never XX), limit honoured + keyed", async () => {
    const raw = openDerivedDb(TABLES);
    // Cell A (10.0, 20.0): 1 critical + 5 medium; XX has the most threats.
    geo(raw, { lat: 10.01, lng: 20.02, cc: "XX", sev: "medium", n: 5 });
    geo(raw, { lat: 10.02, lng: 20.01, cc: "DE", sev: "critical", n: 1, type: "malware_distribution" });
    geo(raw, { lat: 10.03, lng: 20.03, cc: "FR", sev: "medium", n: 2 });
    // Cell B: all unknown country.
    geo(raw, { lat: 50, lng: 60, cc: "XX", sev: "low", n: 1 });
    const { env, kv } = makeEnv(raw);

    const res = await handleObservatoryNodes(req("/api/observatory/nodes?period=7d&limit=2000"), env);
    expect(res.status).toBe(200);
    const nodes = (await body<{ data: Array<Record<string, unknown>> }>(res)).data;
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ lat: 10, lng: 20, threat_count: 8, top_severity: "critical", critical: 1, medium: 7, country_code: "FR", top_threat_type: "phishing" });
    expect(nodes[1]).toMatchObject({ country_code: null, top_severity: "low" });
    expect(kv.store.has("observatory_nodes:7d:all:2000")).toBe(true);

    const one = await body<{ data: unknown[] }>(await handleObservatoryNodes(req("/api/observatory/nodes?period=7d&limit=1"), env));
    expect(one.data).toHaveLength(1);
    expect(kv.store.has("observatory_nodes:7d:all:1")).toBe(true);
    // Garbage → canonical key, no new key per value
    await handleObservatoryNodes(req("/api/observatory/nodes?period=bogus&limit=-5"), env);
    expect(kv.store.has("observatory_nodes:7d:all:1")).toBe(true);
    expect([...kv.store.keys()].some((k) => k.includes("bogus") || k.includes("-5"))).toBe(false);
  });

  it("stats: threats_total is active-only + source-filtered; XX is not a country", async () => {
    const raw = openDerivedDb(TABLES);
    geo(raw, { lat: 1, lng: 1, cc: "US", sev: "high", n: 6 });
    geo(raw, { lat: 2, lng: 2, cc: "XX", sev: "high", n: 2 });
    geo(raw, { lat: 3, lng: 3, cc: "DE", sev: "high", n: 4, feed: "spam_trap" });
    statusCube(raw, { status: "active", n: 16 });
    statusCube(raw, { status: "remediated", n: 100 }); // must not dilute coverage
    statusCube(raw, { status: "active", feed: "spam_trap", n: 4 });
    const { env } = makeEnv(raw);

    const all = (await body<{ data: Record<string, number> }>(await handleObservatoryStats(req("/api/observatory/stats?period=7d"), env))).data;
    expect(all.threats_mapped).toBe(12);
    expect(all.threats_total).toBe(20);
    expect(all.geo_coverage_pct).toBe(60);
    expect(all.countries).toBe(2);

    const spam = (await body<{ data: Record<string, number> }>(await handleObservatoryStats(req("/api/observatory/stats?period=7d&source_feed=spam_trap"), env))).data;
    expect(spam.threats_mapped).toBe(4);
    expect(spam.threats_total).toBe(4);
    expect(spam.geo_coverage_pct).toBe(100);
  });

  it("heatmap: cube-served {lat,lng,severity,threat_type,weight}, weight DESC, source_feed filter", async () => {
    const raw = openDerivedDb(TABLES);
    geo(raw, { lat: 10.01, lng: 20.01, cc: "US", sev: "high", n: 2 });
    geo(raw, { lat: 10.04, lng: 20.02, cc: "CA", sev: "high", n: 3 });
    geo(raw, { lat: 40, lng: 40, cc: "DE", sev: "critical", n: 1, feed: "spam_trap" });
    geo(raw, { lat: 0, lng: 0, cc: "XX", sev: "low", n: 99 });
    geo(raw, { hour: hourAgo(24 * 40), lat: 5, lng: 5, cc: "US", sev: "low", n: 50 }); // outside 7d
    const { env, kv, log } = makeEnv(raw);

    const res = await body<{ data: unknown[] }>(await handleObservatoryHeatmap(req("/api/observatory/heatmap?period=7d&limit=10000"), env));
    expect(res.data).toEqual([
      { lat: 10, lng: 20, severity: "high", threat_type: "phishing", weight: 5 },
      { lat: 40, lng: 40, severity: "critical", threat_type: "phishing", weight: 1 },
    ]);
    expect(log.some((l) => /FROM threats\b/.test(l.sql))).toBe(false);
    // absent / '' / all share the canonical key the Navigator warm writes
    expect(kv.store.has("observatory_heatmap:7d:all:10000")).toBe(true);
    await handleObservatoryHeatmap(req("/api/observatory/heatmap?period=7d&source_feed="), env);
    expect([...kv.store.keys()].filter((k) => k.startsWith("observatory_heatmap:"))).toEqual(["observatory_heatmap:7d:all:10000"]);

    const spam = await body<{ data: Array<{ weight: number }> }>(await handleObservatoryHeatmap(req("/api/observatory/heatmap?period=7d&source_feed=spam_trap"), env));
    expect(spam.data).toEqual([{ lat: 40, lng: 40, severity: "critical", threat_type: "phishing", weight: 1 }]);
  });

  it("arcs: HQ columns drive the target; unplaceable + sourceless arcs are counted, not drawn", async () => {
    const raw = openDerivedDb(TABLES);
    brand(raw, { id: "b1", name: "Acme", domain: "acme.example", hq_lat: 45, hq_lng: -75 });
    brand(raw, { id: "b2", name: "Beta", domain: "beta.example", hq_country: "JP" });
    brand(raw, { id: "b3", name: "Gamma", domain: "gamma.example" });
    arcsCube(raw, { brand: "b1", cc: "RU", sev: "medium", n: 3 });
    arcsCube(raw, { brand: "b1", cc: "RU", sev: "critical", n: 1 });
    arcsCube(raw, { brand: "b2", cc: "CN", sev: "low", n: 2 });
    arcsCube(raw, { brand: "b3", cc: "BR", sev: "high", n: 9 });
    arcsCube(raw, { brand: "b2", cc: "XX", sev: "high", n: 1, lat: null, lng: null });
    const { env } = makeEnv(raw);

    const res = await body<{ data: Array<Record<string, unknown>>; dropped_unknown_target: number; dropped_no_source: number }>(
      await handleObservatoryArcs(req("/api/observatory/arcs?period=7d"), env),
    );
    expect(res.dropped_unknown_target).toBe(1);
    expect(res.dropped_no_source).toBe(1);
    expect(res.data).toHaveLength(2);
    const acme = res.data.find((a) => a.target_brand === "Acme")!;
    expect(acme).toMatchObject({ targetPosition: [-75, 45], target_precision: "hq", severity: "critical", volume: 4, sourcePosition: [30, 50] });
    const beta = res.data.find((a) => a.target_brand === "Beta")!;
    expect(beta).toMatchObject({ targetPosition: [138, 37.5], target_precision: "country" });
  });

  it("brand-arcs: 400 without id, 404 for unknown id (no cache write), cached + source-aware otherwise", async () => {
    const raw = openDerivedDb(TABLES);
    brand(raw, { id: "b1", name: "Acme", domain: "acme.example", hq_country: "CA" });
    arcsCube(raw, { brand: "b1", cc: "RU", sev: "high", n: 3 });
    arcsCube(raw, { brand: "b1", cc: "CN", sev: "low", n: 1, feed: "spam_trap" });
    const { env, kv } = makeEnv(raw);

    expect((await handleObservatoryBrandArcs(req("/api/observatory/brand-arcs"), env)).status).toBe(400);
    const missing = await handleObservatoryBrandArcs(req("/api/observatory/brand-arcs?brand_id=nope"), env);
    expect(missing.status).toBe(404);
    expect([...kv.store.keys()].some((k) => k.includes("nope"))).toBe(false);

    const ok = await body<{ data: Array<Record<string, unknown>>; target_precision: string; brand: { id: string } }>(
      await handleObservatoryBrandArcs(req("/api/observatory/brand-arcs?brand_id=b1&period=garbage"), env),
    );
    expect(ok.brand.id).toBe("b1");
    expect(ok.target_precision).toBe("country");
    expect(ok.data).toHaveLength(2);
    expect(ok.data[0]).toMatchObject({ country_code: "RU", volume: 3, target_precision: "country", severity: "high" });
    expect(kv.store.has("observatory_brand_arcs:7d:all:b1")).toBe(true);
    expect(kv.store.get("observatory_brand_arcs:7d:all:b1")?.ttl).toBe(OBSERVATORY_TTL_S.brandArcs);

    const spam = await body<{ data: unknown[] }>(await handleObservatoryBrandArcs(req("/api/observatory/brand-arcs?brand_id=b1&source_feed=spam_trap"), env));
    expect(spam.data).toHaveLength(1);
    expect(kv.store.has("observatory_brand_arcs:7d:spam_trap:b1")).toBe(true);
  });

  it("brand-arcs: a malformed brand_id or unknown source_feed is a 400 before any KV read or query", async () => {
    const raw = openDerivedDb(TABLES);
    brand(raw, { id: "b1", name: "Acme", domain: "acme.example", hq_country: "CA" });
    const { env, kv, log } = makeEnv(raw);
    const reads: string[] = [];
    const get = kv.get;
    const getWithMetadata = kv.getWithMetadata;
    kv.get = async (k: string) => { reads.push(k); return get(k); };
    kv.getWithMetadata = async (k: string) => { reads.push(k); return getWithMetadata(k); };
    const bad = ["b1:7d", "b1%20", "b1'", "../b1", "%E2%9C%93", "a".repeat(129), "b1;DROP"];
    for (const id of bad) {
      const res = await handleObservatoryBrandArcs(req(`/api/observatory/brand-arcs?brand_id=${id}`), env);
      expect(res.status, id).toBe(400);
      expect(await res.json()).toMatchObject({ success: false });
    }
    const badSource = await handleObservatoryBrandArcs(req("/api/observatory/brand-arcs?brand_id=b1&source_feed=urlhaus"), env);
    expect(badSource.status).toBe(400);
    expect(reads).toEqual([]);
    expect(log).toEqual([]);
    expect(kv.store.size).toBe(0);
    // Every id shape the platform mints passes.
    for (const id of ["brand_acme_com", "b_0123456789abcdef", "brand-x", "a".repeat(128)]) {
      expect(BRAND_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  it("operations: status=all is unfiltered (one key); known status filters; unknown is 400", async () => {
    const raw = openDerivedDb([...TABLES, "infrastructure_clusters"]);
    raw.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status) VALUES ('c1', 'one', 5, 'active')`).run();
    raw.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status) VALUES ('c2', 'two', 3, 'dormant')`).run();
    const { env, kv, log } = makeEnv(raw);

    const all = await body<{ data: Array<{ id: string }> }>(await handleObservatoryOperations(req("/api/observatory/operations?status=all"), env));
    expect(all.data.map((r) => r.id).sort()).toEqual(["c1", "c2"]);
    expect([...kv.store.keys()]).toEqual(["observatory_operations:all:5"]);
    // Absent / empty status read the same key — served from cache.
    const n = log.length;
    for (const q of ["", "?status=", "?status=all"]) {
      const r = await body<{ data: unknown[] }>(await handleObservatoryOperations(req(`/api/observatory/operations${q}`), env));
      expect(r.data).toHaveLength(2);
    }
    expect(log.length).toBe(n);

    const dormant = await body<{ data: Array<{ id: string }> }>(await handleObservatoryOperations(req("/api/observatory/operations?status=dormant"), env));
    expect(dormant.data.map((r) => r.id)).toEqual(["c2"]);
    expect(kv.store.has("observatory_operations:dormant:5")).toBe(true);

    const before = log.length;
    for (const bad of ["ALL", "nope", "active'"]) {
      const res = await handleObservatoryOperations(req(`/api/observatory/operations?status=${encodeURIComponent(bad)}`), env);
      expect(res.status, bad).toBe(400);
    }
    expect(log.length).toBe(before);
    expect(kv.store.size).toBe(2);
  });

  it("live: negative limit clamps to 1, TTL 60s", async () => {
    const raw = openDerivedDb(TABLES);
    const { env, kv } = makeEnv(raw);
    const res = await handleObservatoryLive(req("/api/observatory/live?limit=-1"), env);
    expect(res.status).toBe(200);
    expect(kv.store.get("observatory_live:all:1")?.ttl).toBe(60);
  });

  it("refresh-warm serves a fresh key, and recomputes it only once inside the margin", async () => {
    const raw = openDerivedDb(TABLES);
    geo(raw, { lat: 1, lng: 1, cc: "US", sev: "high", n: 1 });
    const { env, kv, log } = makeEnv(raw);
    const KEY = "observatory_stats:7d:all";
    await handleObservatoryStats(req("/api/observatory/stats?period=7d"), env);
    expect(kv.store.get(KEY)?.ttl).toBe(1800);
    const n = log.length;
    await handleObservatoryStats(req("/api/observatory/stats?period=7d"), env);
    expect(log.length).toBe(n); // live hit
    // A fresh key: the warm does NOT recompute (the old fixed 1800s margin did).
    await handleObservatoryStats(markCacheRefresh(req("/api/observatory/stats?period=7d")), env);
    expect(log.length).toBe(n);
    // Age the entry 600s (one Phase A slot): still outside the 900s margin.
    const age = (s: number) => {
      const e = kv.store.get(KEY)!;
      kv.store.set(KEY, { ...e, metadata: { cachedAt: Date.now() - s * 1000 } });
    };
    age(600);
    await handleObservatoryStats(markCacheRefresh(req("/api/observatory/stats?period=7d")), env);
    expect(log.length).toBe(n);
    // Age 1200s: remaining 600s < 900s margin → the warm recomputes and restamps.
    age(1200);
    await handleObservatoryStats(markCacheRefresh(req("/api/observatory/stats?period=7d")), env);
    expect(log.length).toBeGreaterThan(n);
    expect(Date.now() - (kv.store.get(KEY)?.metadata as { cachedAt: number }).cachedAt).toBeLessThan(5_000);
    // A live request at the same age never recomputes.
    age(1200);
    const m = log.length;
    await handleObservatoryStats(req("/api/observatory/stats?period=7d"), env);
    expect(log.length).toBe(m);
  });
});
