/**
 * Flight Control `backlog.total_unlinked.probe` — bounded probe.
 *
 * The exact `COUNT(*) … WHERE target_brand_id IS NULL AND status='active'`
 * read ~1.19M idx_threats_brand_status entries per call (prod, 2026-11-08)
 * to feed Analyst scaling tiers that top out at UNLINKED_TIER_HIGH. The
 * probe stops at UNLINKED_PROBE_CAP = HIGH + 1, which answers every tier
 * comparison exactly. Pins: exact below the cap, saturates at the cap,
 * tiers unchanged, and the plan is a covering index read (no table scan).
 */

import { describe, it, expect, vi } from "vitest";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";

vi.mock("../src/agents/index", () => ({ agentModules: {} }));
const {
  TOTAL_UNLINKED_PROBE_SQL, UNLINKED_PROBE_CAP, UNLINKED_TIER_HIGH, UNLINKED_TIER_MED,
} = await import("../src/agents/flightControl");

function openThreats(): SqliteDb {
  const raw = openDerivedDb(["threats"]);
  for (const ddl of liveIndexDdl("threats").values()) raw.exec(ddl);
  return raw;
}

/** n rows with the given brand/status, via a recursive CTE (fast). */
function fill(raw: SqliteDb, prefix: string, n: number, brand: string | null, status: string): void {
  raw.prepare(
    `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ?)
     INSERT INTO threats (id, source_feed, threat_type, target_brand_id, status, severity, created_at)
     SELECT ? || i, 'feed', 'phishing', ?, ?, 'high', datetime('now') FROM c`,
  ).run(n, prefix, brand, status);
}

const probe = (raw: SqliteDb): number =>
  (raw.prepare(TOTAL_UNLINKED_PROBE_SQL).get() as { count: number }).count;

describe.skipIf(!hasSqlite())("FC total_unlinked bounded probe", () => {
  it("cap is HIGH + 1 so every tier comparison stays exact", () => {
    expect(UNLINKED_TIER_HIGH).toBe(50_000);
    expect(UNLINKED_TIER_MED).toBe(10_000);
    expect(UNLINKED_PROBE_CAP).toBe(UNLINKED_TIER_HIGH + 1);
    expect(TOTAL_UNLINKED_PROBE_SQL).toContain(`LIMIT ${UNLINKED_PROBE_CAP}`);
  });

  it("is exact below the cap and counts only unlinked ACTIVE threats", () => {
    const raw = openThreats();
    fill(raw, "u", 12, null, "active");
    fill(raw, "d", 7, null, "down");
    fill(raw, "l", 5, "b1", "active");
    expect(probe(raw)).toBe(12);
  });

  it("saturates at the cap above HIGH, so `> HIGH` still holds", () => {
    const raw = openThreats();
    fill(raw, "u", UNLINKED_TIER_HIGH + 500, null, "active");
    const n = probe(raw);
    expect(n).toBe(UNLINKED_PROBE_CAP);
    expect(n > UNLINKED_TIER_HIGH).toBe(true);
  });

  it("at exactly HIGH it reports HIGH (tier boundary not crossed)", () => {
    const raw = openThreats();
    fill(raw, "u", UNLINKED_TIER_HIGH, null, "active");
    expect(probe(raw)).toBe(UNLINKED_TIER_HIGH);
  });

  it("plans as a covering range on idx_threats_brand_status (no table scan)", () => {
    const raw = openThreats();
    raw.exec("ANALYZE");
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${TOTAL_UNLINKED_PROBE_SQL}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/COVERING INDEX idx_threats_brand_status \(target_brand_id=\? AND status=\?\)/);
    expect(plan).not.toMatch(/SCAN threats(?! USING)/);
  });

  it("keeps that plan under prod-like planner stats", () => {
    const raw = openThreats();
    raw.exec("ANALYZE");
    raw.exec("DELETE FROM sqlite_stat1");
    const ins = raw.prepare("INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('threats', ?, ?)");
    ins.run(null, "1500000");
    ins.run("idx_threats_brand_status", "1500000 150 30");
    ins.run("idx_threats_status", "1500000 300000");
    raw.exec("ANALYZE sqlite_schema");
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${TOTAL_UNLINKED_PROBE_SQL}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail).join(" | ");
    expect(plan).toMatch(/COVERING INDEX idx_threats_brand_status/);
  });
});
