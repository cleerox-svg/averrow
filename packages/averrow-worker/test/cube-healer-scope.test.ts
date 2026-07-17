/**
 * Tests for cube_healer hot/cold scope selection (PR-BM).
 *
 * Verifies:
 *   - pickHealScope() picks 'cold' at UTC hour 0, 'hot' otherwise.
 *   - healSQLForTest() embeds the right window literal for each scope.
 *   - The five cube SQLs (geo/provider/brand/status/arcs) all carry
 *     the same window — no drift between cubes within one tick.
 */

import { describe, it, expect } from "vitest";
import {
  pickHealScope,
  healSQLForTest,
  HOT_HEAL_WINDOW_DAYS,
  COLD_HEAL_WINDOW_DAYS,
} from "../src/agents/cube-healer";

describe("pickHealScope", () => {
  it("picks 'cold' at UTC hour 0 (the 00:12 cron tick)", () => {
    expect(pickHealScope(new Date("2026-05-21T00:12:00Z"))).toBe("cold");
  });

  it("picks 'hot' at every non-zero UTC hour", () => {
    expect(pickHealScope(new Date("2026-05-21T06:12:00Z"))).toBe("hot");
    expect(pickHealScope(new Date("2026-05-21T12:12:00Z"))).toBe("hot");
    expect(pickHealScope(new Date("2026-05-21T18:12:00Z"))).toBe("hot");
  });

  it("ignores local timezone — only UTC hour matters", () => {
    // 19:12 EST is 00:12 UTC the next day — UTC 0 wins, picks cold.
    expect(pickHealScope(new Date("2026-05-21T00:12:00Z"))).toBe("cold");
    // 00:12 EST is 05:12 UTC — UTC 5 → hot.
    expect(pickHealScope(new Date("2026-05-21T05:12:00Z"))).toBe("hot");
  });

  it("treats minutes/seconds within hour-0 as cold (cron jitter tolerance)", () => {
    expect(pickHealScope(new Date("2026-05-21T00:00:00Z"))).toBe("cold");
    expect(pickHealScope(new Date("2026-05-21T00:59:59Z"))).toBe("cold");
  });
});

describe("healSQL window selection", () => {
  const tables = ["geo", "provider", "brand", "status", "arcs"] as const;

  it("hot scope embeds the 2-day window literal", () => {
    for (const t of tables) {
      const sql = healSQLForTest(t, "hot");
      expect(sql).toContain(`datetime('now', '-${HOT_HEAL_WINDOW_DAYS} days')`);
      expect(sql).not.toContain(`datetime('now', '-${COLD_HEAL_WINDOW_DAYS} days')`);
    }
  });

  it("cold scope embeds the 14-day window literal", () => {
    for (const t of tables) {
      const sql = healSQLForTest(t, "cold");
      expect(sql).toContain(`datetime('now', '-${COLD_HEAL_WINDOW_DAYS} days')`);
      expect(sql).not.toContain(`datetime('now', '-${HOT_HEAL_WINDOW_DAYS} days')`);
    }
  });

  it("hot and cold differ only in the window literal", () => {
    for (const t of tables) {
      const hot = healSQLForTest(t, "hot");
      const cold = healSQLForTest(t, "cold");
      const hotNormalized = hot.replace(`-${HOT_HEAL_WINDOW_DAYS} days`, "WINDOW");
      const coldNormalized = cold.replace(`-${COLD_HEAL_WINDOW_DAYS} days`, "WINDOW");
      expect(hotNormalized).toBe(coldNormalized);
    }
  });

  it("every cube targets the correct destination table (PR-BO: INSERT INTO + UPSERT)", () => {
    // PR-BO switched INSERT OR REPLACE → INSERT INTO ... ON CONFLICT
    // DO UPDATE WHERE. INSERT OR REPLACE always mutates 1 row per
    // existing bucket; the new shape skips the mutation entirely when
    // the aggregate hasn't changed.
    expect(healSQLForTest("geo", "hot")).toContain("INSERT INTO threat_cube_geo");
    expect(healSQLForTest("provider", "hot")).toContain("INSERT INTO threat_cube_provider");
    expect(healSQLForTest("brand", "hot")).toContain("INSERT INTO threat_cube_brand");
    expect(healSQLForTest("status", "hot")).toContain("INSERT INTO threat_cube_status");
    expect(healSQLForTest("arcs", "hot")).toContain("INSERT INTO threat_cube_arcs");

    for (const t of ["geo", "provider", "brand", "status", "arcs"] as const) {
      expect(healSQLForTest(t, "hot")).not.toContain("INSERT OR REPLACE");
    }
  });

  it("PR-BO: every cube uses ON CONFLICT DO UPDATE with a WHERE-skip clause", () => {
    // The WHERE-skip is the entire point of the change. A stale
    // INSERT OR REPLACE would still bill 1 row written per existing
    // bucket; UPSERT with `WHERE existing IS NOT excluded` writes 0
    // when the aggregate is unchanged.
    for (const t of ["geo", "provider", "brand", "status", "arcs"] as const) {
      const sql = healSQLForTest(t, "hot");
      expect(sql).toMatch(/ON CONFLICT\(/);
      expect(sql).toMatch(/DO UPDATE SET/);
      // IS NOT (not !=) so NULL on either side compares correctly.
      expect(sql).toMatch(/IS NOT excluded\./);
      expect(sql).toContain("threat_count = excluded.threat_count");
    }
  });

  it("PR-BO: ON CONFLICT target matches each cube's PRIMARY KEY columns", () => {
    expect(healSQLForTest("geo", "hot")).toContain(
      "ON CONFLICT(hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed)",
    );
    expect(healSQLForTest("provider", "hot")).toContain(
      "ON CONFLICT(hour_bucket, hosting_provider_id, threat_type, severity, source_feed)",
    );
    expect(healSQLForTest("brand", "hot")).toContain(
      "ON CONFLICT(hour_bucket, target_brand_id, threat_type, severity, source_feed)",
    );
    expect(healSQLForTest("status", "hot")).toContain(
      "ON CONFLICT(hour_bucket, threat_type, severity, source_feed, status)",
    );
    expect(healSQLForTest("arcs", "hot")).toContain(
      "ON CONFLICT(hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed)",
    );
  });

  it("PR-BO: arcs WHERE-skip also compares last_seen + source_lat/lng (not just threat_count)", () => {
    // Arcs has mutable aggregates beyond threat_count — the centroid
    // (source_lat/lng) and last_seen MAX both shift as new threats
    // land in a bucket. Comparing only threat_count would let drift
    // accumulate silently. first_seen is intentionally NOT in the
    // WHERE because MIN(created_at) is stable for any fixed hour
    // (the floor can only move later via row deletion, which
    // doesn't happen).
    const sql = healSQLForTest("arcs", "hot");
    expect(sql).toContain("threat_cube_arcs.last_seen IS NOT excluded.last_seen");
    expect(sql).toContain("threat_cube_arcs.source_lat IS NOT excluded.source_lat");
    expect(sql).toContain("threat_cube_arcs.source_lng IS NOT excluded.source_lng");
  });

  it("status heal has NO status='active' filter (only reconciles status mutations)", () => {
    const sql = healSQLForTest("status", "hot");
    expect(sql).not.toMatch(/AND status = 'active'/);
  });

  it("geo/provider/brand/arcs healers all filter on status='active'", () => {
    for (const t of ["geo", "provider", "brand", "arcs"] as const) {
      expect(healSQLForTest(t, "hot")).toContain("AND status = 'active'");
    }
  });

  it("arcs heal aggregates source_lat/source_lng + first_seen/last_seen", () => {
    const sql = healSQLForTest("arcs", "cold");
    expect(sql).toContain("ROUND(AVG(lat), 1)");
    expect(sql).toContain("ROUND(AVG(lng), 1)");
    expect(sql).toContain("MIN(created_at)");
    expect(sql).toContain("MAX(created_at)");
  });

  it("HOT_HEAL_WINDOW_DAYS < COLD_HEAL_WINDOW_DAYS (sanity)", () => {
    expect(HOT_HEAL_WINDOW_DAYS).toBeLessThan(COLD_HEAL_WINDOW_DAYS);
  });

  it("write reduction sanity: 3 hot + 1 cold per day << 4 cold per day", () => {
    // 4 daily ticks. Pre-PR-BM was 4 × COLD; now is 3 × HOT + 1 × COLD.
    const preDays = 4 * COLD_HEAL_WINDOW_DAYS;
    const postDays = 3 * HOT_HEAL_WINDOW_DAYS + 1 * COLD_HEAL_WINDOW_DAYS;
    // Expect at least a 50% reduction in cumulative window-days/day.
    expect(postDays).toBeLessThan(preDays * 0.5);
  });
});
