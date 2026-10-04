/**
 * PR-D review blockers B1 + B2 — hosting_providers.trend_7d / trend_30d
 * have ONE meaning (rolling 7d / 30d new-threat COUNTS) and ONE writer
 * (lib/provider-trends.ts).
 *
 *   B1  updateProviderTrends only UPDATEd providers present in the 30d
 *       cube aggregate, so a provider whose threats all aged out kept its
 *       last non-zero counts forever and surfaced as a phantom "Cooling"
 *       provider (/api/providers/v2?sort=cooling). It now zeroes absent
 *       providers, change-guarded (already-zero rows are not written).
 *
 *   B2  lib/snapshots.ts overwrote trend_7d with a day-over-week DELTA
 *       (possibly negative) at hour 0, so the column had delta semantics
 *       until the next NEXUS run. That write is removed.
 *
 * SQL runs for real against node:sqlite with the migration-derived schema
 * (test/sqlite-d1-harness.ts), so a column typo or a window/diff slip
 * fails here, not in prod.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { updateProviderTrends } from "../src/lib/provider-trends";
import { generateDailySnapshots } from "../src/lib/snapshots";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  sqliteTimestampHoursAgo,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";

function insertProvider(raw: SqliteDb, id: string, trend7d: number, trend30d: number): void {
  raw.prepare(
    `INSERT INTO hosting_providers (id, name, active_threat_count, total_threat_count, trend_7d, trend_30d)
     VALUES (?, ?, 0, 0, ?, ?)`,
  ).run(id, `Provider ${id}`, trend7d, trend30d);
}

let cubeSeq = 0;
function insertCube(raw: SqliteDb, providerId: string, hoursAgo: number, count: number): void {
  cubeSeq += 1;
  // Distinct source_feed per row keeps the composite PK unique.
  raw.prepare(
    `INSERT INTO threat_cube_provider (hour_bucket, hosting_provider_id, threat_type, severity, source_feed, threat_count)
     VALUES (?, ?, 'phishing', 'high', ?, ?)`,
  ).run(sqliteTimestampHoursAgo(hoursAgo), providerId, `feed_${cubeSeq}`, count);
}

function trends(raw: SqliteDb, id: string): { trend_7d: number; trend_30d: number } {
  return raw.prepare(`SELECT trend_7d, trend_30d FROM hosting_providers WHERE id = ?`).all(id)[0] as {
    trend_7d: number;
    trend_30d: number;
  };
}

describe.skipIf(!hasSqlite())("B1 — updateProviderTrends zeroes providers absent from the 30d cube window", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let db: D1Database;

  beforeEach(() => {
    raw = openDerivedDb(["hosting_providers", "threat_cube_provider"]);
    log = [];
    db = d1FromSqlite(raw, { log });

    // Live: 3 threats in the last 7d + 10 more inside 30d.
    insertProvider(raw, "p_live", 0, 0);
    insertCube(raw, "p_live", 24, 3);
    insertCube(raw, "p_live", 24 * 20, 10);

    // Gone: stale counts from when it was active; only cube data is
    // older than 30d now. Before the fix this kept 2 / 40 forever and
    // read as Cooling (2 < 40 * 7/30).
    insertProvider(raw, "p_gone", 2, 40);
    insertCube(raw, "p_gone", 24 * 45, 40);

    // Gone with only a stale 7d value (no cube rows at all) — zeroed.
    insertProvider(raw, "p_gone_7d_only", 4, 0);

    // Already quiet, no cube rows: must NOT be rewritten (change guard).
    insertProvider(raw, "p_quiet", 0, 0);
    insertProvider(raw, "p_quiet_2", 0, 0);
  });

  it("writes live counts, zeroes stale absent providers, leaves already-zero rows alone", async () => {
    const result = await updateProviderTrends(db);

    expect(log.filter((e) => e.error)).toEqual([]);
    expect(result.providers_evaluated).toBe(1);
    expect(result.providers_updated).toBe(1);
    // Exactly the two stale rows — the change guard skipped p_quiet and
    // p_quiet_2 (an unguarded "zero everything absent" would report 4).
    expect(result.providers_zeroed).toBe(2);

    expect(trends(raw, "p_live")).toEqual({ trend_7d: 3, trend_30d: 13 });
    expect(trends(raw, "p_gone")).toEqual({ trend_7d: 0, trend_30d: 0 });
    expect(trends(raw, "p_gone_7d_only")).toEqual({ trend_7d: 0, trend_30d: 0 });
    expect(trends(raw, "p_quiet")).toEqual({ trend_7d: 0, trend_30d: 0 });
  });

  it("is idempotent — a second run writes nothing", async () => {
    await updateProviderTrends(db);
    const second = await updateProviderTrends(db);
    expect(second.providers_updated).toBe(0);
    expect(second.providers_zeroed).toBe(0);
  });

  it("a zeroed provider no longer qualifies as Cooling", async () => {
    const coolingSql = `SELECT id FROM hosting_providers hp
      WHERE hp.trend_30d > 0 AND (hp.trend_7d - hp.trend_30d * 7.0 / 30.0) < 0`;
    expect((raw.prepare(coolingSql).all() as Array<{ id: string }>).map((r) => r.id)).toContain("p_gone");
    await updateProviderTrends(db);
    expect((raw.prepare(coolingSql).all() as Array<{ id: string }>).map((r) => r.id)).not.toContain("p_gone");
  });

  it("zeroing reuses the in-memory aggregate — the 30d cube is read exactly once", async () => {
    await updateProviderTrends(db);
    const cubeReads = log.filter((e) => /threat_cube_provider/.test(e.sql));
    expect(cubeReads).toHaveLength(1);
    // The zeroing UPDATE is id-keyed (in-memory diff), not a NOT IN subquery.
    const zeroWrites = log.filter((e) => /trend_7d\s*=\s*0/.test(e.sql));
    expect(zeroWrites).toHaveLength(1);
    expect(zeroWrites[0]!.sql).toMatch(/WHERE id IN \(\?,\?\)/);
    expect(zeroWrites[0]!.sql).not.toMatch(/NOT IN/);
  });

  it("chunks the zeroing UPDATE at <=90 binds (D1 100-bind ceiling)", async () => {
    for (let i = 0; i < 95; i++) insertProvider(raw, `p_stale_${i}`, 1, 5);
    const result = await updateProviderTrends(db);
    // 95 new stale rows + p_gone + p_gone_7d_only.
    expect(result.providers_zeroed).toBe(97);
    const zeroWrites = log.filter((e) => /trend_7d\s*=\s*0/.test(e.sql));
    expect(zeroWrites).toHaveLength(2);
    for (const w of zeroWrites) {
      expect((w.sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(90);
    }
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM hosting_providers WHERE trend_7d != 0 OR trend_30d != 0`).all()[0],
    ).toEqual({ n: 1 }); // only p_live
  });

  it("30-day window boundary: a cube row just inside counts, just outside is zeroed", async () => {
    insertProvider(raw, "p_edge_in", 9, 9);
    insertCube(raw, "p_edge_in", 24 * 30 - 1, 6);
    insertProvider(raw, "p_edge_out", 9, 9);
    insertCube(raw, "p_edge_out", 24 * 30 + 1, 6);

    const result = await updateProviderTrends(db);

    expect(log.filter((e) => e.error)).toEqual([]);
    expect(result.providers_evaluated).toBe(2); // p_live + p_edge_in
    // Inside 30d but outside 7d: counts toward trend_30d only.
    expect(trends(raw, "p_edge_in")).toEqual({ trend_7d: 0, trend_30d: 6 });
    expect(trends(raw, "p_edge_out")).toEqual({ trend_7d: 0, trend_30d: 0 });
    expect(result.providers_zeroed).toBe(3); // p_gone, p_gone_7d_only, p_edge_out
  });

  it("empty 30d cube is treated as unavailable — nothing is mass-zeroed", async () => {
    raw.exec(`DELETE FROM threat_cube_provider`);
    const result = await updateProviderTrends(db);
    expect(result).toEqual({ providers_evaluated: 0, providers_updated: 0, providers_zeroed: 0 });
    expect(trends(raw, "p_gone")).toEqual({ trend_7d: 2, trend_30d: 40 });
  });
});

describe.skipIf(!hasSqlite())("B2 — generateDailySnapshots no longer writes trend_7d", () => {
  it("leaves trend_7d's 7-day COUNT intact while still refreshing active/total counts", async () => {
    const raw = openDerivedDb(["hosting_providers", "threats", "daily_snapshots"]);
    const log: StatementLogEntry[] = [];
    const db = d1FromSqlite(raw, { log });
    const today = new Date().toISOString().slice(0, 10);

    insertProvider(raw, "p1", 12, 30);
    // Last week's snapshot had MORE new threats than today will — the old
    // code would have written trend_7d = 1 - 5 = -4 here.
    raw.prepare(
      `INSERT INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats)
       VALUES (date(?, '-7 days'), 'provider', 'p1', 5, 0, 0)`,
    ).run(today);
    raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_url, malicious_domain, hosting_provider_id, status, created_at)
       VALUES ('t1', 'feed', 'phishing', 'https://a.test/', 'a.test', 'p1', 'active', ?)`,
    ).run(`${today} 00:30:00`);

    await generateDailySnapshots(db, today);

    expect(log.filter((e) => e.error)).toEqual([]);
    const row = raw.prepare(
      `SELECT trend_7d, trend_30d, active_threat_count, total_threat_count FROM hosting_providers WHERE id = 'p1'`,
    ).all()[0];
    expect(row).toEqual({ trend_7d: 12, trend_30d: 30, active_threat_count: 1, total_threat_count: 1 });
  });

  it("no SQL in lib/snapshots.ts assigns trend_7d / trend_30d (single-writer guard)", () => {
    const src = readFileSync(resolve(__dirname, "../src/lib/snapshots.ts"), "utf8");
    const sqlLiterals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
    expect(sqlLiterals.length).toBeGreaterThan(0);
    // Targets ASSIGNMENT (`trend_7d = …`), not mere mention, so a future
    // read of the column (e.g. a SELECT or WHERE comparison like `>`)
    // does not trip the guard. `==`/`!=`/`<=`/`>=` comparisons are
    // excluded by the lookbehind/lookahead.
    const assign = /(?<![!<>=])\btrend_(?:7d|30d)\s*=(?!=)/;
    for (const sql of sqlLiterals) {
      expect(sql).not.toMatch(assign);
    }
  });

  it("the single-writer regex catches an assignment and ignores reads", () => {
    const assign = /(?<![!<>=])\btrend_(?:7d|30d)\s*=(?!=)/;
    expect("UPDATE hosting_providers SET trend_7d = ? WHERE id = ?").toMatch(assign);
    expect("UPDATE hosting_providers SET trend_30d=0").toMatch(assign);
    expect("SELECT trend_7d, trend_30d FROM hosting_providers").not.toMatch(assign);
    expect("WHERE trend_7d >= 1 AND trend_30d != 0").not.toMatch(assign);
  });
});
