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
 *     catalog size); velocity is NOT published (no prod index, G16);
 *   - a failing proof compute answers all-null and is negative-cached;
 *   - D1 outage → last-known-good totals, else null (never invented).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import { handlePublicStats } from "../src/handlers/public";
import { formatBigNumber } from "../src/lib/public-stats";
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

describe.skipIf(!hasSqlite())("public stats + proof (real SQLite, migration-derived schema)", () => {
  let raw: SqliteDb;
  let n = 0;

  const threat = () => {
    n++;
    raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, first_seen)
       VALUES (?, 'feed_x', 'phishing', ?, ?)`,
    ).run(`t${n}`, `bad${n}.example`, sqliteTimestampHoursAgo(1));
  };
  const brand = (id: string, tier: string) =>
    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES (?, ?, ?, ?)")
      .run(id, `Brand ${id}`, `${id}.example`, tier);
  const lookalike = (
    id: string,
    registered: number,
    firstSeenHoursAgo: number | null,
    extra: { evidence?: string | null; baselineHoursAgo?: number | null; createdAt?: string } = {},
  ) =>
    raw.prepare(
      `INSERT INTO lookalike_domains
         (id, brand_id, domain, permutation_type, registered, first_seen,
          registration_evidence, baseline_established_at, created_at)
       VALUES (?, 'b1', ?, 'typosquat', ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    ).run(
      id, `${id}.example`, registered,
      firstSeenHoursAgo === null ? null : sqliteTimestampHoursAgo(firstSeenHoursAgo),
      extra.evidence ?? null,
      extra.baselineHoursAgo == null ? null : sqliteTimestampHoursAgo(extra.baselineHoursAgo),
      extra.createdAt ?? null,
    );
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

    // lookalikes_found_30d = registered + COALESCE(first_seen, baseline)
    // in 30d + created on/after 2026-09-30. new_registrations_30d =
    // evidence IN ('nrd','observed') + first_seen in 30d.
    //                                                            found  new
    lookalike("l1", 1, 24, { evidence: "observed" });         //    yes    yes
    lookalike("l2", 1, 24 * 10, { evidence: "nrd" });         //    yes    yes
    lookalike("l3", 1, 24 * 45, { evidence: "observed" });    //    no     no  (outside window)
    lookalike("l4", 0, 24, { evidence: "nrd" });              //    no     yes (NRD-dated, DNS not yet)
    lookalike("l5", 1, null, { baselineHoursAgo: 48 });       //    yes    no  (baseline discovery)
    lookalike("l6", 1, null, {                                //    no     no  (legacy backfill)
      baselineHoursAgo: 48, createdAt: "2026-05-01 00:00:00",
    });
    lookalike("l7", 1, 24);                                   //    yes    no  (no evidence: legacy first_seen)

    cluster("c1", "active", "component_A");
    cluster("c2", "accelerating", "component_A"); // same operation as c1
    cluster("c3", "pivot", null);                 // its own operation
    cluster("c4", "dormant", null);               // not live
    cluster("c5", "active", null, 24 * 40);       // stale

    const d = await getStats(envFor(raw));
    const proof = d.proof as Record<string, unknown>;

    expect(Object.keys(proof).sort()).toEqual([
      "brands_in_catalog", "generated_at", "lookalikes_found_30d", "monitored_brands",
      "new_registrations_30d", "operations_tracked",
    ]);
    expect(proof.lookalikes_found_30d).toBe(4);
    expect(proof.new_registrations_30d).toBe(3);
    expect(proof.operations_tracked).toBe(2);
    expect(proof.monitored_brands).toBe(2);
    expect(proof.brands_in_catalog).toBe(4);
    expect(typeof proof.generated_at).toBe("string");
    expect(Number.isNaN(Date.parse(proof.generated_at as string))).toBe(false);
  });

  it("never reads threats for proof (no full scan in prod)", async () => {
    const log: Array<{ sql: string }> = [];
    const env = { DB: d1FromSqlite(raw, { log }), CACHE: fakeKv() } as unknown as Env;
    await getStats(env);
    const proofSql = log.map((l) => l.sql).filter((q) => /weaponization|FROM threats\s+WHERE first_seen/i.test(q));
    expect(proofSql).toEqual([]);
  });

  it("a failing proof compute answers all-null and is negative-cached (no per-request retry)", async () => {
    raw.exec("DROP TABLE lookalike_domains");
    const log: Array<{ sql: string; error?: string }> = [];
    const env = { DB: d1FromSqlite(raw, { log }), CACHE: fakeKv() } as unknown as Env;

    const p1 = (await getStats(env)).proof as Record<string, unknown>;
    expect(p1.lookalikes_found_30d).toBeNull();
    expect(p1.operations_tracked).toBeNull();
    expect(p1.monitored_brands).toBeNull();
    expect(p1.brands_in_catalog).toBeNull();
    const attempts = () => log.filter((l) => l.sql.includes("FROM lookalike_domains")).length;
    expect(p1.new_registrations_30d).toBeNull();
    // Two lookalike statements per compute (found + new registrations),
    // both attempted once in parallel.
    expect(attempts()).toBe(2);

    await getStats(env);
    expect(attempts()).toBe(2); // second request served by the negative cache
  });

  it("serves proof from KV on the second call (no re-query)", async () => {
    brand("b1", "monitored");
    const env = envFor(raw);
    await getStats(env);
    brand("b2", "monitored"); // would change the count if re-queried
    const proof = (await getStats(env)).proof as Record<string, unknown>;
    expect(proof.monitored_brands).toBe(1);
  });

  it("D1 outage: totals come from the last-known-good copy, else null — never an invented number", async () => {
    for (let i = 0; i < 1500; i++) threat();
    raw.prepare("INSERT INTO feed_configs (feed_name, display_name, schedule_cron, enabled) VALUES ('f', 'F', '0 * * * *', 1)").run();
    brand("b1", "monitored");
    const kv = fakeKv();
    const good = { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env;
    const first = await getStats(good);
    expect(first.total_threats).toBe(1500);

    // Fresh compute (expire the 10-min stats key + count caches), D1 down.
    for (const k of Array.from(kv.store.keys())) {
      if (!k.startsWith("public_stats:lkg")) kv.store.delete(k);
    }
    const broken = { DB: { prepare: () => { throw new Error("D1 down"); } }, CACHE: kv } as unknown as Env;
    const { getPublicStats } = await import("../src/lib/public-stats");
    const lkg = await getPublicStats(broken);
    expect(lkg.threats_total).toBe(1500);
    expect(lkg.threats_detected).toBe(formatBigNumber(1500));

    const empty = { DB: broken.DB, CACHE: fakeKv() } as unknown as Env;
    const unknown = await getPublicStats(empty);
    expect(unknown.threats_total).toBeNull();
    expect(unknown.threats_detected).toBeNull();
    expect(unknown.feeds_protecting).toBeNull();
    expect(unknown.brands_monitored).toBeNull();
  });
});
