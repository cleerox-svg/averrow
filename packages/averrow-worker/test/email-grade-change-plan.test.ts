/**
 * Email grade-change candidate query plan (2026-11-23 D1 overload).
 *
 * Prod EXPLAIN showed the plain `brands JOIN email_security_scans` driven by
 * `SCAN ess` — every scan row (~613K) with a brands PK lookup each — on the
 * hourly orchestrator tick. EMAIL_GRADE_CHANGES_SQL now fixes the join order
 * with CROSS JOIN, so it seeks the brands scanned in the last 23h first.
 * Pinned on the migrated schema, with and without ANALYZE stats skewed the
 * way prod is (many scans, few recently-scanned brands). Result equality is
 * covered by test/email-grade-change-rubric.test.ts, which runs this SQL.
 */

import { describe, it, expect } from "vitest";
import { hasSqlite, openMigratedDb, type SqliteDb } from "./sqlite-d1-harness";
import { EMAIL_GRADE_CHANGES_SQL } from "../src/lib/email-grade-change";
import { EMAIL_SCORE_RUBRIC_VERSION } from "../src/email-security";

function plan(db: SqliteDb): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${EMAIL_GRADE_CHANGES_SQL}`).all(EMAIL_SCORE_RUBRIC_VERSION) as Array<{ detail: string }>)
    .map((r) => r.detail);
}

function expectBrandsFirst(details: string[]): void {
  expect(details[0]).toMatch(/^SEARCH b USING (COVERING )?INDEX idx_brands_email_scan_due \(email_security_scanned_at>\?\)/);
  expect(details.some((d) => /^SEARCH ess USING (COVERING )?INDEX idx_ess_brand_scanned \(brand_id=\?/.test(d))).toBe(true);
  expect(details.some((d) => /^SCAN (ess|b)\b/.test(d))).toBe(false);
}

describe.skipIf(!hasSqlite())("EMAIL_GRADE_CHANGES_SQL plan", () => {
  it("joins brands → scans in that order (CROSS JOIN)", () => {
    expect(EMAIL_GRADE_CHANGES_SQL).toMatch(/FROM brands b\s+CROSS JOIN email_security_scans ess ON ess\.brand_id = b\.id/);
  });

  it("seeks recently-scanned brands, then each brand's scans (no stats)", () => {
    expectBrandsFirst(plan(openMigratedDb()));
  });

  it("keeps that order with prod-shaped ANALYZE stats", () => {
    const db = openMigratedDb();
    db.exec("ANALYZE");
    // Prod shape: ~132K brands, ~600K scans; the scanned_at range is narrow.
    db.exec(`DELETE FROM sqlite_stat1 WHERE tbl IN ('brands', 'email_security_scans')`);
    db.exec(`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES
      ('brands', 'idx_brands_email_scan_due', '132000 30'),
      ('brands', 'sqlite_autoindex_brands_1', '132000 1'),
      ('email_security_scans', 'idx_ess_brand_scanned', '600000 50 1'),
      ('email_security_scans', NULL, '600000')`);
    db.exec("ANALYZE sqlite_schema");
    expectBrandsFirst(plan(db));
  });
});
