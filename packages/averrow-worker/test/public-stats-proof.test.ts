/**
 * GET /api/v1/public/stats — disclosure-register fixes (L4 / L12 / L20, G1).
 *
 * Runs the real handler against node:sqlite with the schema DERIVED from
 * migrations/, so a proof query naming a column or table that does not
 * exist fails here instead of silently publishing nulls.
 *
 * Pins:
 *   - no hard-coded `detection_time_label`, no `latest_insight_summary`;
 *   - one threat total: `total_threats` (number) and `threats_detected`
 *     (formatted string) come from the same all-time threats count;
 *   - `threats_today` exists and the legacy `certificates_today` alias
 *     equals it (frozen public/app.js still reads the alias);
 *   - `proof` shape + each definition (30-day lookalike registrations,
 *     component-collapsed live operations, tier-scoped monitored brands,
 *     catalog size, velocity share with the n >= 30 floor).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import { handlePublicStats } from "../src/handlers/public";
import { formatBigNumber } from "../src/lib/public-stats";
import { velocityPct, VELOCITY_MIN_SAMPLE } from "../src/lib/public-proof";
import type { Env } from "../src/types";

const TABLES = [
  "threats", "brands", "lookalike_domains", "infrastructure_clusters",
  "threat_cube_status", "threat_cube_geo", "threat_cube_provider",
  "monitored_brands", "feed_status", "feed_configs", "campaigns",
];

function envFor(raw: SqliteDb): Env {
  return { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
}

async function getStats(env: Env): Promise<Record<string, unknown>> {
  const res = await handlePublicStats(new Request("https://averrow.com/api/v1/public/stats"), env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
  expect(body.success).toBe(true);
  return body.data;
}

describe("velocityPct", () => {
  it("returns null below the sample floor and a 1-decimal percent at/above it", () => {
    expect(velocityPct(10, VELOCITY_MIN_SAMPLE - 1)).toBeNull();
    expect(velocityPct(0, 0)).toBeNull();
    expect(velocityPct(10, 30)).toBe(33.3);
    expect(velocityPct(30, 30)).toBe(100);
  });
});

describe.skipIf(!hasSqlite())("public stats + proof (real SQLite, migration-derived schema)", () => {
  let raw: SqliteDb;
  let n = 0;

  const threat = (opts: { firstSeenHoursAgo?: number; flag?: string | null } = {}) => {
    n++;
    raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, first_seen, weaponization_flag)
       VALUES (?, 'feed_x', 'phishing', ?, ?, ?)`,
    ).run(`t${n}`, `bad${n}.example`, sqliteTimestampHoursAgo(opts.firstSeenHoursAgo ?? 1), opts.flag ?? null);
  };
  const brand = (id: string, tier: string) =>
    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES (?, ?, ?, ?)")
      .run(id, `Brand ${id}`, `${id}.example`, tier);
  const lookalike = (id: string, registered: number, firstSeenHoursAgo: number | null) =>
    raw.prepare(
      `INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, registered, first_seen)
       VALUES (?, 'b1', ?, 'typosquat', ?, ?)`,
    ).run(id, `${id}.example`, registered, firstSeenHoursAgo === null ? null : sqliteTimestampHoursAgo(firstSeenHoursAgo));
  const cluster = (id: string, status: string, component: string | null, lastSeenHoursAgo = 1) =>
    raw.prepare(
      `INSERT INTO infrastructure_clusters (id, status, component_id, last_seen) VALUES (?, ?, ?, ?)`,
    ).run(id, status, component, sqliteTimestampHoursAgo(lastSeenHoursAgo));

  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    n = 0;
  });

  it("drops the unmeasured / risky keys and publishes ONE threat total", async () => {
    for (let i = 0; i < 1234; i++) threat();
    const d = await getStats(envFor(raw));

    expect(d).not.toHaveProperty("detection_time_label");
    expect(d).not.toHaveProperty("latest_insight_summary");
    expect(JSON.stringify(d)).not.toContain("<5min");

    expect(d.total_threats).toBe(1234);
    expect(d.threats_detected).toBe(formatBigNumber(1234));
    expect(typeof d.threats_detected).toBe("string");

    expect(d).toHaveProperty("threats_today");
    expect(d.certificates_today).toBe(d.threats_today);
    expect(d.threats_classified_today).toBe(d.threats_today);

    // Keys the marketing build consumes keep their types.
    for (const k of ["providers_mapped", "threat_campaigns", "countries", "active_feeds"]) {
      expect(typeof d[k]).toBe("number");
    }
  });

  it("computes every proof field from its documented definition", async () => {
    brand("b1", "monitored");
    brand("b2", "customer");
    brand("b3", "tracked");
    brand("b4", "tracked");

    lookalike("l1", 1, 24);          // registered, first seen 1d ago   → counts
    lookalike("l2", 1, 24 * 10);     // registered, 10d ago             → counts
    lookalike("l3", 1, 24 * 45);     // registered, 45d ago             → outside window
    lookalike("l4", 0, 24);          // not registered                  → no
    lookalike("l5", 1, null);        // baselined, never seen appearing → no

    cluster("c1", "active", "component_A");
    cluster("c2", "accelerating", "component_A"); // same operation as c1
    cluster("c3", "pivot", null);                 // its own operation
    cluster("c4", "dormant", null);               // not live
    cluster("c5", "active", null, 24 * 40);       // stale

    // 40 computable velocity rows in window: 10 very_fast, 10 fast, 20 normal.
    for (let i = 0; i < 10; i++) threat({ flag: "very_fast" });
    for (let i = 0; i < 10; i++) threat({ flag: "fast" });
    for (let i = 0; i < 20; i++) threat({ flag: "normal" });
    threat({ flag: null });                                  // not computable
    threat({ flag: "very_fast", firstSeenHoursAgo: 24 * 40 }); // outside window

    const d = await getStats(envFor(raw));
    const proof = d.proof as Record<string, unknown>;

    expect(Object.keys(proof).sort()).toEqual([
      "brands_in_catalog", "generated_at", "lookalikes_found_30d", "monitored_brands",
      "operations_tracked", "pct_live_within_24h", "pct_live_within_72h", "velocity_sample_30d",
    ]);
    expect(proof.lookalikes_found_30d).toBe(2);
    expect(proof.operations_tracked).toBe(2);
    expect(proof.monitored_brands).toBe(2);
    expect(proof.brands_in_catalog).toBe(4);
    expect(proof.velocity_sample_30d).toBe(40);
    expect(proof.pct_live_within_24h).toBe(25);
    expect(proof.pct_live_within_72h).toBe(50);
    expect(typeof proof.generated_at).toBe("string");
    expect(Number.isNaN(Date.parse(proof.generated_at as string))).toBe(false);
  });

  it("publishes null velocity percentages below the n >= 30 floor", async () => {
    for (let i = 0; i < 5; i++) threat({ flag: "very_fast" });
    const proof = (await getStats(envFor(raw))).proof as Record<string, unknown>;
    expect(proof.velocity_sample_30d).toBe(5);
    expect(proof.pct_live_within_24h).toBeNull();
    expect(proof.pct_live_within_72h).toBeNull();
  });

  it("serves proof from KV on the second call (no re-query)", async () => {
    brand("b1", "monitored");
    const env = envFor(raw);
    await getStats(env);
    brand("b2", "monitored"); // would change the count if re-queried
    const proof = (await getStats(env)).proof as Record<string, unknown>;
    expect(proof.monitored_brands).toBe(1);
  });
});
