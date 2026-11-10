/**
 * Observer's 24h aggregates read the OLAP cubes, not raw threats (2026-11-10).
 *
 * Every observer run read ~1.55M rows (AE meter `agent:observer`, 14 runs /
 * 21.7M rows on 2026-11-09). EXPLAIN in prod: the type breakdown was
 * `SCAN threats USING INDEX idx_threats_type` (all 1.55M rows) and the top
 * brands join `SCAN b` (~133K brands) + a seek per brand. The cube versions
 * read ~2.5K rows in prod.
 *
 * Pins, against a DB built from every migration (tables + indexes):
 *   1. Each query's plan SEARCHes its cube by hour_bucket — no SCAN of the
 *      cube, of threats or of brands.
 *   2. The queries return the right shape and numbers for seeded cube rows
 *      (window = last 24 cube hours; older hours excluded).
 *   3. observer.ts no longer GROUPs BY over raw threats for these three.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OBSERVER_TOP_BRANDS_24H_SQL,
  OBSERVER_TOP_PROVIDERS_24H_SQL,
  OBSERVER_TYPE_BREAKDOWN_24H_SQL,
} from "../src/agents/observer";
import { hasSqlite, openMigratedDb, type SqliteDb } from "./sqlite-d1-harness";

const hourAgo = (h: number): string => {
  const d = new Date(Date.now() - h * 3_600_000);
  return `${d.toISOString().slice(0, 13).replace("T", " ")}:00:00`;
};

describe.skipIf(!hasSqlite())("observer cube aggregates", () => {
  let db: SqliteDb;

  beforeAll(() => {
    db = openMigratedDb();
    db.prepare(`INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Brand One', 'one.test'), ('b2', 'Brand Two', 'two.test')`).run();
    db.prepare(`INSERT INTO hosting_providers (id, name) VALUES ('p1', 'Prov'), ('p2', 'Prov'), ('p3', 'Other')`).run();
    const brand = db.prepare(`INSERT INTO threat_cube_brand (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count) VALUES (?, ?, ?, 'high', 'f', ?)`);
    brand.run(hourAgo(1), "b1", "phishing", 5);
    brand.run(hourAgo(2), "b1", "malware_distribution", 2);
    brand.run(hourAgo(3), "b2", "phishing", 4);
    brand.run(hourAgo(30), "b2", "phishing", 100); // outside the 24h window
    const prov = db.prepare(`INSERT INTO threat_cube_provider (hour_bucket, hosting_provider_id, threat_type, severity, source_feed, threat_count) VALUES (?, ?, 'phishing', 'high', 'f', ?)`);
    prov.run(hourAgo(1), "p1", 3);
    prov.run(hourAgo(1), "p2", 4); // same provider NAME as p1 — merged by name
    prov.run(hourAgo(2), "p3", 5);
    prov.run(hourAgo(40), "p3", 50);
    const st = db.prepare(`INSERT INTO threat_cube_status (hour_bucket, threat_type, severity, source_feed, status, threat_count) VALUES (?, ?, 'high', 'f', ?, ?)`);
    st.run(hourAgo(1), "phishing", "active", 6);
    st.run(hourAgo(1), "phishing", "remediated", 1);
    st.run(hourAgo(2), "c2", "active", 2);
    st.run(hourAgo(48), "c2", "active", 99);
  });

  const plan = (sql: string): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join("\n");

  it.each([
    ["top brands", OBSERVER_TOP_BRANDS_24H_SQL, "threat_cube_brand USING INDEX idx_cube_brand_hour (hour_bucket>?)"],
    ["top providers", OBSERVER_TOP_PROVIDERS_24H_SQL, "threat_cube_provider USING INDEX idx_cube_provider_hour (hour_bucket>?)"],
    ["type breakdown", OBSERVER_TYPE_BREAKDOWN_24H_SQL, "threat_cube_status USING INDEX idx_cube_status_hour (hour_bucket>?)"],
  ])("%s seeks its cube by hour and never scans threats/brands", (_name, sql, search) => {
    const p = plan(sql);
    expect(p).toContain(`SEARCH ${search}`);
    expect(p).not.toMatch(/SCAN (threats|brands|b\b|threat_cube_)/);
    expect(p).not.toMatch(/\bthreats\b/);
  });

  it("top brands: 24h window, summed across hours/types, ordered desc", () => {
    expect(db.prepare(OBSERVER_TOP_BRANDS_24H_SQL).all()).toEqual([
      { id: "b1", name: "Brand One", count: 7 },
      { id: "b2", name: "Brand Two", count: 4 },
    ]);
  });

  it("top providers: grouped by provider name like the old query", () => {
    expect(db.prepare(OBSERVER_TOP_PROVIDERS_24H_SQL).all()).toEqual([
      { name: "Prov", count: 7 },
      { name: "Other", count: 5 },
    ]);
  });

  it("type breakdown: every status counted, older hours excluded", () => {
    expect(db.prepare(OBSERVER_TYPE_BREAKDOWN_24H_SQL).all()).toEqual([
      { threat_type: "phishing", count: 7 },
      { threat_type: "c2", count: 2 },
    ]);
  });
});

describe("observer source", () => {
  it("has no raw-threats GROUP BY for the 24h brand / provider / type aggregates", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/agents/observer.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/FROM threats WHERE created_at >= datetime\('now', '-24 hours'\)\s*GROUP BY threat_type/);
    expect(src).not.toMatch(/FROM threats t JOIN brands b ON t\.target_brand_id = b\.id\s*WHERE t\.created_at >= datetime\('now', '-24 hours'\)/);
    expect(src).not.toMatch(/FROM threats t JOIN hosting_providers hp/);
  });
});
