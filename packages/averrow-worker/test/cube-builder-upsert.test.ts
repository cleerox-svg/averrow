/**
 * Tests for cube-builder UPSERT WITH WHERE (PR-BO).
 *
 * Each build*CubeForHour wraps INSERT INTO ... ON CONFLICT(...) DO
 * UPDATE SET ... WHERE existing IS NOT excluded. The optimization
 * skips the row mutation when the aggregate is unchanged — major
 * write-budget savings on Navigator's 12×/hour current-hour rebuild.
 *
 * These tests are SQL-shape regression guards: a future refactor
 * that drops the WHERE clause, omits ON CONFLICT, or reverts to
 * INSERT OR REPLACE would silently restore the pre-PR-BO write
 * volume. Asserting the SQL text catches that.
 */

import { describe, it, expect } from "vitest";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
} from "../src/lib/cube-builder";

interface Call {
  sql: string;
  bindArgs: unknown[];
}

function makeEnv() {
  const calls: Call[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (...bindArgs: unknown[]) => {
            const record: Call = { sql, bindArgs };
            calls.push(record);
            return {
              run: async () => ({ meta: { changes: 0, rows_written: 0 }, success: true }),
            };
          },
        };
      },
    },
  } as unknown as Parameters<typeof buildGeoCubeForHour>[0];
  return { env, calls };
}

describe("cube-builder UPSERT WITH WHERE (PR-BO)", () => {
  const tableConflictCols = {
    geo: "ON CONFLICT(hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed)",
    provider: "ON CONFLICT(hour_bucket, hosting_provider_id, threat_type, severity, source_feed)",
    brand: "ON CONFLICT(hour_bucket, target_brand_id, threat_type, severity, source_feed)",
    status: "ON CONFLICT(hour_bucket, threat_type, severity, source_feed, status)",
    arcs: "ON CONFLICT(hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed)",
  };

  it("buildGeoCubeForHour emits INSERT INTO + UPSERT (no INSERT OR REPLACE)", async () => {
    const { env, calls } = makeEnv();
    await buildGeoCubeForHour(env, "2026-05-22 16:00:00");
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("INSERT INTO threat_cube_geo");
    expect(calls[0].sql).not.toContain("INSERT OR REPLACE");
    expect(calls[0].sql).toContain(tableConflictCols.geo);
    expect(calls[0].sql).toContain("DO UPDATE SET");
    expect(calls[0].sql).toContain("threat_cube_geo.threat_count IS NOT excluded.threat_count");
  });

  it("buildProviderCubeForHour emits INSERT INTO + UPSERT", async () => {
    const { env, calls } = makeEnv();
    await buildProviderCubeForHour(env, "2026-05-22 16:00:00");
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("INSERT INTO threat_cube_provider");
    expect(calls[0].sql).not.toContain("INSERT OR REPLACE");
    expect(calls[0].sql).toContain(tableConflictCols.provider);
    expect(calls[0].sql).toContain("threat_cube_provider.threat_count IS NOT excluded.threat_count");
  });

  it("buildBrandCubeForHour emits INSERT INTO + UPSERT", async () => {
    const { env, calls } = makeEnv();
    await buildBrandCubeForHour(env, "2026-05-22 16:00:00");
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("INSERT INTO threat_cube_brand");
    expect(calls[0].sql).not.toContain("INSERT OR REPLACE");
    expect(calls[0].sql).toContain(tableConflictCols.brand);
    expect(calls[0].sql).toContain("threat_cube_brand.threat_count IS NOT excluded.threat_count");
  });

  it("buildStatusCubeForHour emits INSERT INTO + UPSERT", async () => {
    const { env, calls } = makeEnv();
    await buildStatusCubeForHour(env, "2026-05-22 16:00:00");
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("INSERT INTO threat_cube_status");
    expect(calls[0].sql).not.toContain("INSERT OR REPLACE");
    expect(calls[0].sql).toContain(tableConflictCols.status);
    expect(calls[0].sql).toContain("threat_cube_status.threat_count IS NOT excluded.threat_count");
  });

  it("buildArcsCubeForHour emits INSERT INTO + multi-column UPSERT", async () => {
    const { env, calls } = makeEnv();
    await buildArcsCubeForHour(env, "2026-05-22 16:00:00");
    expect(calls.length).toBe(1);
    const sql = calls[0].sql;
    expect(sql).toContain("INSERT INTO threat_cube_arcs");
    expect(sql).not.toContain("INSERT OR REPLACE");
    expect(sql).toContain(tableConflictCols.arcs);
    // Arcs has mutable aggregates beyond threat_count — centroid + last_seen.
    expect(sql).toContain("threat_cube_arcs.threat_count IS NOT excluded.threat_count");
    expect(sql).toContain("threat_cube_arcs.last_seen IS NOT excluded.last_seen");
    expect(sql).toContain("threat_cube_arcs.source_lat IS NOT excluded.source_lat");
    expect(sql).toContain("threat_cube_arcs.source_lng IS NOT excluded.source_lng");
  });

  it("all 5 cubes use IS NOT (not !=) so NULL aggregates compare correctly", async () => {
    // IS NOT handles NULL on either side; != returns NULL when either
    // operand is NULL, which SQLite treats as falsy → the UPDATE
    // would FIRE on every conflict where the existing column is NULL,
    // negating the optimization. Critical for arcs (source_lat /
    // source_lng can be NULL).
    const { env: e1, calls: c1 } = makeEnv();
    await buildGeoCubeForHour(e1, "2026-05-22 16:00:00");
    const { env: e2, calls: c2 } = makeEnv();
    await buildProviderCubeForHour(e2, "2026-05-22 16:00:00");
    const { env: e3, calls: c3 } = makeEnv();
    await buildBrandCubeForHour(e3, "2026-05-22 16:00:00");
    const { env: e4, calls: c4 } = makeEnv();
    await buildStatusCubeForHour(e4, "2026-05-22 16:00:00");
    const { env: e5, calls: c5 } = makeEnv();
    await buildArcsCubeForHour(e5, "2026-05-22 16:00:00");

    for (const sql of [c1[0].sql, c2[0].sql, c3[0].sql, c4[0].sql, c5[0].sql]) {
      expect(sql).toMatch(/IS NOT excluded\./);
      // Make sure we didn't accidentally use the buggy != form.
      expect(sql).not.toMatch(/!= excluded\./);
    }
  });
});
