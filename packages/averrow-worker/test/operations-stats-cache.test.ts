// Pin: GET /api/v1/operations/stats — `brands_targeted` (an unfiltered
// COUNT(DISTINCT target_brand_id) over all of threat_cube_brand, ~117K rows)
// is behind its own 1h cachedCount, so an operations_stats miss (Navigator
// Phase B warms every 15 min) no longer re-reads the whole brand cube.

import { describe, it, expect } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type StatementLogEntry } from "./sqlite-d1-harness";
import {
  handleOperationsStats,
  OPERATIONS_BRANDS_TARGETED_COUNT_KEY,
  OPERATIONS_BRANDS_TARGETED_TTL_S,
} from "../src/handlers/operations";
import type { Env } from "../src/types";

const DISTINCT_BRANDS = /COUNT\(DISTINCT target_brand_id\) AS brands_targeted FROM threat_cube_brand/;

describe.skipIf(!hasSqlite())("operations stats brands_targeted cache", () => {
  it("counts once per hour across operations_stats misses; response shape unchanged", async () => {
    const raw = openDerivedDb(["infrastructure_clusters", "campaigns", "threat_cube_brand", "threat_cube_status"]);
    const brand = raw.prepare(`INSERT INTO threat_cube_brand
      (hour_bucket, target_brand_id, threat_type, severity, source_feed, threat_count) VALUES ('2026-10-01 00:00:00', ?, 'phishing', 'high', 'f', 1)`);
    for (const id of ["b1", "b2", "b3"]) brand.run(id);
    const log: StatementLogEntry[] = [];
    const kv = fakeKv();
    const env = { DB: d1FromSqlite(raw, { log }), CACHE: kv } as unknown as Env;

    expect(OPERATIONS_BRANDS_TARGETED_COUNT_KEY.startsWith("count.")).toBe(true);
    expect(OPERATIONS_BRANDS_TARGETED_TTL_S).toBe(3600);

    const first = (await (await handleOperationsStats(new Request("https://averrow.com/api/v1/operations/stats"), env)).json()) as {
      success: boolean; data: Record<string, number>;
    };
    expect(first.success).toBe(true);
    expect(Object.keys(first.data).sort()).toEqual([
      "accelerating", "active_operations", "brands_targeted", "campaigns_tracked", "threat_types", "total_clusters",
    ]);
    expect(first.data.brands_targeted).toBe(3);
    expect(log.filter((e) => DISTINCT_BRANDS.test(e.sql))).toHaveLength(1);
    expect(kv.store.has(`cc:${OPERATIONS_BRANDS_TARGETED_COUNT_KEY}`)).toBe(true);

    // The 15-min operations_stats entry expires; the next miss reuses the count.
    kv.store.delete("operations_stats");
    brand.run("b4");
    const second = (await (await handleOperationsStats(new Request("https://averrow.com/api/v1/operations/stats"), env)).json()) as {
      data: Record<string, number>;
    };
    expect(second.data.brands_targeted).toBe(3);
    expect(log.filter((e) => DISTINCT_BRANDS.test(e.sql))).toHaveLength(1);
  });
});
