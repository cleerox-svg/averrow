// Observatory Phase B (B5) — takedowns-geo, velocity-nodes, timeline
// `velocity`, providers-geo `takedown`.
//
// Pure folds are unit-tested; handlers run against real SQLite with the
// migration-derived schema (0299 / 0300 tables), pinning shape, 400s, cache
// keys (400s never mint one) and that no read touches `threats`.

import { describe, it, expect } from "vitest";
import {
  foldTakedownCells,
  weightedMedian,
  providerTakedown,
  shapeVelocityNodes,
  bucketVelocityTimeline,
  timelineStartMs,
  TIMELINE_SPECS,
  LENS_TTL_S,
  handleObservatoryTakedownsGeo,
  handleObservatoryVelocityNodes,
  handleObservatoryTimeline,
  handleObservatoryProvidersGeo,
  type TakedownRollupRow,
} from "../src/handlers/observatoryLenses";
import { rollupWindowStartDay } from "../src/lib/takedown-outcome-rollup";
import { TAKEDOWN_ROLLUP_READ_SQL } from "../src/handlers/observatoryLenses";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitStatements } from "./migration-schema";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

// ─── Harness (same shape as observatory-lenses.test.ts) ──────────────

interface KvEntry { value: string; ttl?: number }
function kvStore() {
  const store = new Map<string, KvEntry>();
  return {
    store,
    get: async (k: string) => store.get(k)?.value ?? null,
    put: async (k: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value, ttl: opts?.expirationTtl });
    },
    delete: async (k: string) => { store.delete(k); },
  };
}
function makeEnv(raw: SqliteDb) {
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  const withSession = () => ({ prepare: db.prepare.bind(db), getBookmark: () => null });
  const kv = kvStore();
  const env = { DB: { ...db, prepare: db.prepare, batch: db.batch, withSession }, CACHE: kv } as unknown as Env;
  return { env, kv, log };
}
const req = (path: string) => new Request(`https://averrow.com${path}`);
interface Envelope<T> { success: boolean; data: T; meta: Record<string, unknown>; error?: string }
async function body<T>(res: Response): Promise<Envelope<T>> {
  return (await res.json()) as Envelope<T>;
}
const lensKeys = (kv: ReturnType<typeof kvStore>) => [...kv.store.keys()].filter((k) => k.startsWith("cv:observatory_lens."));
const TABLES = ["takedown_outcome_daily", "threat_cube_velocity", "hosting_providers"];

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
function hourAgo(h: number): string {
  const d = new Date(Date.now() - h * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString().replace("T", " ").slice(0, 19);
}
function cell(raw: SqliteDb, c: { day: string; dim: string; key: string; submitted: number; taken_down?: number;
  refused?: number; expired?: number; pending?: number; median_hours?: number | null }) {
  raw.prepare(`INSERT INTO takedown_outcome_daily (day, dim, key, submitted, taken_down, refused, expired, pending, median_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.day, c.dim, c.key, c.submitted, c.taken_down ?? 0, c.refused ?? 0,
    c.expired ?? 0, c.pending ?? 0, c.median_hours ?? null);
}
function vel(raw: SqliteDb, hour: string, cc: string, flag: string, n: number) {
  raw.prepare(`INSERT INTO threat_cube_velocity (hour_bucket, country_code, flag, threat_count) VALUES (?, ?, ?, ?)`).run(hour, cc, flag, n);
}
function provider(raw: SqliteDb, id: string, name: string, country: string | null, active: number) {
  raw.prepare(`INSERT INTO hosting_providers (id, name, asn, country, active_threat_count, total_threat_count, trend_7d, trend_30d, is_bulletproof, reputation_score)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 50)`).run(id, name, `AS${id.length}${id.charCodeAt(id.length - 1)}`, country, active, active);
}

// ─── Pure ─────────────────────────────────────────────────────────────

describe("takedown folding", () => {
  const r = (x: Partial<TakedownRollupRow>): TakedownRollupRow => ({
    day: "2026-10-01", key: "US", submitted: 0, taken_down: 0, refused: 0, expired: 0, pending: 0, median_hours: null, ...x,
  });

  it("sums counts per key; share = taken_down / resolved; null when nothing resolved", () => {
    const m = foldTakedownCells([
      r({ submitted: 3, taken_down: 2, refused: 1, median_hours: 10 }),
      r({ day: "2026-10-02", submitted: 2, taken_down: 1, expired: 1, median_hours: 40 }),
      r({ key: "DE", submitted: 1, pending: 1 }),
    ]);
    expect(m.get("US")).toEqual({ key: "US", submitted: 5, taken_down: 3, refused: 1, expired: 1, pending: 0, share: 0.6, median_hours: 10 });
    expect(m.get("DE")).toMatchObject({ share: null, median_hours: null, pending: 1 });
  });

  it("weightedMedian weighs each daily median by that day's taken_down", () => {
    expect(weightedMedian([])).toBeNull();
    expect(weightedMedian([{ value: 5, weight: 1 }, { value: 50, weight: 3 }])).toBe(50);
    expect(weightedMedian([{ value: 5, weight: 2 }, { value: 50, weight: 2 }])).toBe(5);
    expect(weightedMedian([{ value: 1, weight: 0 }, { value: 7.123, weight: 1 }])).toBe(7.12);
  });

  it("providerTakedown: null without submissions, else {share, median_hours, n}", () => {
    expect(providerTakedown(undefined)).toBeNull();
    expect(providerTakedown({ key: "x", submitted: 0, taken_down: 0, refused: 0, expired: 0, pending: 0, share: null, median_hours: null })).toBeNull();
    expect(providerTakedown({ key: "x", submitted: 4, taken_down: 1, refused: 1, expired: 0, pending: 2, share: 0.5, median_hours: 3 }))
      .toEqual({ share: 0.5, median_hours: 3, n: 4 });
  });
});

describe("velocity shaping", () => {
  it("centroid-placed /nodes shape; XX + unknown-centroid dropped and counted", () => {
    const { nodes, dropped } = shapeVelocityNodes([
      { country_code: "US", very_fast: 2, fast: 3 },
      { country_code: "RU", very_fast: 9, fast: 0 },
      { country_code: "XX", very_fast: 4, fast: 0 },
      { country_code: "QQ", very_fast: 0, fast: 1 },
      { country_code: "DE", very_fast: 0, fast: 0 },
    ]);
    expect(dropped).toBe(5);
    expect(nodes.map((n) => [n.country_code, n.threat_count, n.very_fast, n.fast])).toEqual([["RU", 9, 9, 0], ["US", 5, 2, 3]]);
    const us = nodes[1]!;
    expect(us).toMatchObject({ top_severity: null, critical: 0, high: 0, medium: 0, low: 0, top_threat_type: null, precision: "country" });
    expect(typeof us.lat).toBe("number");
    expect(typeof us.lng).toBe("number");
  });

  it("velocity timeline: zero-filled, severity fields 0, very_fast/fast per bucket", () => {
    const spec = TIMELINE_SPECS["24h"];
    const start = timelineStartMs(spec, new Date("2026-10-14T10:30:00Z"));
    const pts = bucketVelocityTimeline([
      { hour_bucket: "2026-10-14 10:00:00", total: 5, very_fast: 2, fast: 3 },
      { hour_bucket: "2026-10-13 09:00:00", total: 9, very_fast: 9, fast: 0 }, // before window
    ], spec, start);
    expect(pts).toHaveLength(24);
    expect(pts[23]).toEqual({ t: "2026-10-14T10:00:00.000Z", total: 5, critical: 0, high: 0, medium: 0, low: 0, very_fast: 2, fast: 3 });
    expect(pts.slice(0, 23).every((p) => p.total === 0 && p.very_fast === 0)).toBe(true);
  });
});

// ─── Handlers ─────────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("B5 handlers — real SQLite", () => {
  it("takedowns-geo by=country: window, fold, share, labels, centroid, order, cache key, TTL", async () => {
    const raw = openDerivedDb(TABLES);
    cell(raw, { day: daysAgo(1), dim: "country", key: "RU", submitted: 4, taken_down: 3, refused: 1, median_hours: 12 });
    cell(raw, { day: daysAgo(3), dim: "country", key: "RU", submitted: 2, taken_down: 1, expired: 1, median_hours: 30 });
    cell(raw, { day: daysAgo(2), dim: "country", key: "unknown", submitted: 7, pending: 7 });
    cell(raw, { day: daysAgo(60), dim: "country", key: "BR", submitted: 1, taken_down: 1, median_hours: 5 }); // outside 30d
    cell(raw, { day: daysAgo(1), dim: "provider", key: "hp_1", submitted: 99 });                              // other dim
    const { env, kv, log } = makeEnv(raw);

    const b = await body<Array<Record<string, unknown>>>(await handleObservatoryTakedownsGeo(req("/api/observatory/takedowns-geo"), env));
    expect(b.success).toBe(true);
    expect(b.meta).toMatchObject({ period: "30d", by: "country", window_start_day: rollupWindowStartDay(new Date(), 30) });
    expect(b.data).toEqual([
      { key: "unknown", label: "Unknown", country: null, lat: null, lng: null, submitted: 7, taken_down: 0, refused: 0, expired: 0, pending: 7, share: null, median_hours: null },
      expect.objectContaining({ key: "RU", label: "RU", country: "RU", submitted: 6, taken_down: 4, refused: 1, expired: 1, pending: 0, share: 0.6667, median_hours: 12 }),
    ]);
    const ru = b.data[1]!;
    expect(typeof ru.lat).toBe("number");
    expect(log.some((l) => /FROM threats\b/.test(l.sql))).toBe(false);

    const b90 = await body<Array<{ key: string }>>(await handleObservatoryTakedownsGeo(req("/api/observatory/takedowns-geo?period=90d&by=country"), env));
    expect(b90.data.map((r) => r.key)).toContain("BR");
    expect(lensKeys(kv).sort()).toEqual([
      "cv:observatory_lens.takedowns_geo:30d:country",
      "cv:observatory_lens.takedowns_geo:90d:country",
    ]);
    // cachedValue checks freshness (ttl) in-value; the KV expiry is 2 × ttl.
    expect(kv.store.get("cv:observatory_lens.takedowns_geo:30d:country")?.ttl).toBe(LENS_TTL_S.takedownsGeo * 2);
    expect(LENS_TTL_S.takedownsGeo).toBe(3600);
  });

  it("takedowns-geo by=provider: provider name + country, unnamed id falls back to the id", async () => {
    const raw = openDerivedDb(TABLES);
    provider(raw, "hp_1", "Bulletproof LLC", "nl", 10);
    cell(raw, { day: daysAgo(1), dim: "provider", key: "hp_1", submitted: 3, taken_down: 3, median_hours: 8 });
    cell(raw, { day: daysAgo(1), dim: "provider", key: "hp_gone", submitted: 1, refused: 1 });
    const { env } = makeEnv(raw);
    const b = await body<Array<Record<string, unknown>>>(await handleObservatoryTakedownsGeo(req("/api/observatory/takedowns-geo?by=provider"), env));
    expect(b.data).toEqual([
      expect.objectContaining({ key: "hp_1", label: "Bulletproof LLC", country: "NL", share: 1, median_hours: 8 }),
      expect.objectContaining({ key: "hp_gone", label: "hp_gone", country: null, lat: null, share: 0 }),
    ]);
  });

  it("takedowns-geo: bad period / by → 400 and never mint a key", async () => {
    const raw = openDerivedDb(TABLES);
    const { env, kv } = makeEnv(raw);
    for (const q of ["period=7d", "period=24h", "period=bogus", "by=asn", "by=COUNTRY"]) {
      expect((await handleObservatoryTakedownsGeo(req(`/api/observatory/takedowns-geo?${q}`), env)).status).toBe(400);
    }
    expect(lensKeys(kv)).toEqual([]);
  });

  it("velocity-nodes: window, flag filter, shape, dropped count, cache keys, 400s", async () => {
    const raw = openDerivedDb(TABLES);
    vel(raw, hourAgo(2), "US", "very_fast", 3);
    vel(raw, hourAgo(3), "US", "fast", 4);
    vel(raw, hourAgo(2), "XX", "fast", 6);
    vel(raw, hourAgo(24 * 20), "BR", "fast", 5); // outside 7d
    const { env, kv, log } = makeEnv(raw);

    const all = await body<Array<Record<string, unknown>>>(await handleObservatoryVelocityNodes(req("/api/observatory/velocity-nodes"), env));
    expect(all.meta).toMatchObject({ period: "7d", flag: "all", dropped_no_centroid: 6 });
    expect(all.data).toEqual([expect.objectContaining({ country_code: "US", threat_count: 7, very_fast: 3, fast: 4, precision: "country", top_severity: null })]);

    const vf = await body<Array<Record<string, unknown>>>(await handleObservatoryVelocityNodes(req("/api/observatory/velocity-nodes?period=7d&flag=very_fast"), env));
    expect(vf.data).toEqual([expect.objectContaining({ country_code: "US", threat_count: 3, very_fast: 3, fast: 0 })]);
    const m30 = await body<Array<{ country_code: string }>>(await handleObservatoryVelocityNodes(req("/api/observatory/velocity-nodes?period=30d"), env));
    expect(m30.data.map((n) => n.country_code)).toEqual(["US", "BR"]); // 7 > 5, threat_count DESC
    expect(log.some((l) => /FROM threats\b/.test(l.sql))).toBe(false);

    for (const q of ["flag=normal", "flag=slow", "period=1y"]) {
      expect((await handleObservatoryVelocityNodes(req(`/api/observatory/velocity-nodes?${q}`), env)).status).toBe(400);
    }
    expect(lensKeys(kv).sort()).toEqual([
      "cv:observatory_lens.velocity_nodes:30d:all",
      "cv:observatory_lens.velocity_nodes:7d:all",
      "cv:observatory_lens.velocity_nodes:7d:very_fast",
    ]);
    expect(LENS_TTL_S.velocityNodes).toBe(900);
    expect(kv.store.get("cv:observatory_lens.velocity_nodes:7d:all")?.ttl).toBe(900 * 2);
  });

  it("timeline velocity: reads the velocity cube, country filter, flag filter, distinct cache key, 400s", async () => {
    const raw = openDerivedDb([...TABLES, "threat_cube_status", "threat_cube_geo"]);
    vel(raw, hourAgo(1), "US", "very_fast", 2);
    vel(raw, hourAgo(1), "US", "fast", 1);
    vel(raw, hourAgo(1), "RU", "fast", 5);
    const { env, kv, log } = makeEnv(raw);

    const b = await body<{ bucket: string; points: Array<Record<string, number | string>> }>(
      await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h&velocity=all"), env));
    expect(b.meta).toMatchObject({ period: "24h", velocity: "all", source_feed: "all", country: null });
    expect(b.data.points).toHaveLength(24);
    expect(b.data.points.reduce((s, p) => s + Number(p.total), 0)).toBe(8);
    expect(b.data.points.reduce((s, p) => s + Number(p.very_fast), 0)).toBe(2);

    const us = await body<{ points: Array<Record<string, number>> }>(
      await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h&velocity=fast&country=us"), env));
    expect(us.data.points.reduce((s, p) => s + p.total, 0)).toBe(1);
    expect(log.some((l) => /threat_cube_status|threat_cube_geo|FROM threats\b/.test(l.sql))).toBe(false);

    // Without velocity the classic series (status cube) is unchanged and keyed as before.
    await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h"), env);
    expect(lensKeys(kv).sort()).toEqual([
      "cv:observatory_lens.timeline:24h:all:US:v:fast",
      "cv:observatory_lens.timeline:24h:all:all",
      "cv:observatory_lens.timeline:24h:all:all:v:all",
    ]);

    for (const q of ["velocity=normal", "velocity=1", "velocity=all&source_feed=spam_trap", "velocity=fast&source_feed=feeds"]) {
      expect((await handleObservatoryTimeline(req(`/api/observatory/timeline?period=24h&${q}`), env)).status).toBe(400);
    }
    // `velocity=` (empty) is the classic series, and source_feed=all is fine with velocity.
    expect((await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h&velocity="), env)).status).toBe(200);
    expect((await handleObservatoryTimeline(req("/api/observatory/timeline?period=24h&velocity=all&source_feed=all"), env)).status).toBe(200);
  });

  it("providers-geo: takedown {share, median_hours, n} matched on provider id (90d), null otherwise", async () => {
    const raw = openDerivedDb(TABLES);
    provider(raw, "hp_a", "A Host", "US", 50);
    provider(raw, "hp_b", "B Host", "DE", 40);
    provider(raw, "hp_c", "C Host", "FR", 30);
    cell(raw, { day: daysAgo(10), dim: "provider", key: "hp_a", submitted: 4, taken_down: 2, refused: 2, median_hours: 6 });
    cell(raw, { day: daysAgo(80), dim: "provider", key: "hp_a", submitted: 1, taken_down: 1, median_hours: 100 });
    cell(raw, { day: daysAgo(120), dim: "provider", key: "hp_b", submitted: 9, taken_down: 9 }); // outside 90d
    cell(raw, { day: daysAgo(1), dim: "country", key: "hp_c", submitted: 3 });                    // other dim never matches
    const { env } = makeEnv(raw);
    const b = await body<Array<{ id: string; takedown: unknown }>>(await handleObservatoryProvidersGeo(req("/api/observatory/providers-geo"), env));
    expect(b.data.map((p) => [p.id, p.takedown])).toEqual([
      ["hp_a", { share: 0.6, median_hours: 6, n: 5 }],
      ["hp_b", null],
      ["hp_c", null],
    ]);
  });

  it("migration 0299: the rollup window read is a (dim, day) range, and velocity reads range the cube PK", () => {
    const raw = openDerivedDb(TABLES);
    const sql = readFileSync(resolve(__dirname, "../migrations/0299_takedown_outcome_daily.sql"), "utf-8");
    for (const stmt of splitStatements(sql)) {
      if (/^\s*CREATE INDEX/i.test(stmt) && /ON takedown_outcome_daily/i.test(stmt)) raw.exec(stmt);
    }
    const plan = (q: string, ...binds: unknown[]) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...binds) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    const read = plan(TAKEDOWN_ROLLUP_READ_SQL, "country", "2026-09-15");
    expect(read).toContain("idx_takedown_outcome_dim_day");
    expect(read).not.toContain("SCAN takedown_outcome_daily");
    const vn = plan(`SELECT country_code, SUM(threat_count) FROM threat_cube_velocity WHERE hour_bucket >= ? GROUP BY country_code`, "2026-10-07 00:00:00");
    expect(vn).toMatch(/SEARCH threat_cube_velocity USING (COVERING )?INDEX sqlite_autoindex_threat_cube_velocity_1 \(hour_bucket>\?\)/);
  });
});
