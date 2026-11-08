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

import { describe, it, expect } from "vitest";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  sqliteTimestampHoursAgo,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import { threatAggregate } from "../src/lib/threat-aggregates";

const TABLES = [
  "threats", "brands", "hosting_providers", "campaigns",
  "threat_actors", "threat_actor_infrastructure",
];

function seed() {
  const db = openDerivedDb(TABLES);
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
