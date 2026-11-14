/**
 * Email-security grade-change alerting vs scoring-rubric changes.
 *
 * The RFC 9989 rubric (EMAIL_SCORE_RUBRIC_VERSION 2) grades testing-mode
 * and np-gap records lower. The first rescan under it must update the
 * stored grade silently — no `email_grade_change` alert, no Cartographer
 * band-crossing notification — because the customer's DNS did not change.
 * Real changes between two scans under the same rubric still alert.
 *
 * Runs the real detector SQL against the fully migrated schema (so it also
 * proves migration 0328's columns exist and saveEmailSecurityScan writes
 * them).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import { findEmailGradeChanges, isRubricOnlyGradeChange } from "../src/lib/email-grade-change";
import {
  EMAIL_SCORE_RUBRIC_VERSION,
  saveEmailSecurityScan,
  type EmailSecurityResult,
} from "../src/email-security";

function scanResult(grade: string, score: number): EmailSecurityResult {
  return {
    domain: "acme.example",
    score,
    grade,
    score_rubric_version: EMAIL_SCORE_RUBRIC_VERSION,
    dmarc: {
      exists: true, policy: "reject", pct: 100, rua: null, ruf: null,
      sp: null, np: "none", t: "y", psd: null, testing: true,
      reporting_enabled: false, record: "v=DMARC1; p=reject; t=y; np=none",
    },
    spf: { exists: true, policy: "-all", too_many_lookups: false, record: "v=spf1 -all" },
    dkim: { exists: true, selectors_found: ["google"] },
    mx: { exists: true, providers: [] },
    bimi: { record: null, svg_url: null, vmc_url: null, vmc_valid: false, vmc_expiry: null, grade: "B" },
    recommendations: [],
    scanned_at: "",
    scan_duration_ms: 1,
  };
}

describe.skipIf(!hasSqlite())("email grade-change detection across rubric versions", () => {
  let raw: SqliteDb;
  let db: D1Database;

  beforeEach(() => {
    raw = openMigratedDb();
    db = d1FromSqlite(raw);
  });

  /** Brand scanned 1h ago at `current`; previous scan 8 days ago at `previous`/`prevVersion`. */
  function seed(current: string, previous: string, prevVersion: number | null) {
    const now = sqliteTimestampHoursAgo(1);
    raw.prepare(
      "INSERT INTO brands (id, name, canonical_domain, email_security_grade, email_security_scanned_at) VALUES (?, ?, ?, ?, ?)",
    ).run("b1", "Acme", "acme.example", current, now);
    const ins = raw.prepare(
      "INSERT INTO email_security_scans (brand_id, domain, email_security_score, email_security_grade, score_rubric_version, scanned_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    ins.run("b1", "acme.example", 95, previous, prevVersion, sqliteTimestampHoursAgo(8 * 24));
    ins.run("b1", "acme.example", 82, current, EMAIL_SCORE_RUBRIC_VERSION, now);
  }

  it("rubric-only change (previous scan graded under the old, NULL-stamped rubric) → no alert", async () => {
    seed("A", "A+", null);
    expect(await findEmailGradeChanges(db)).toEqual([]);
  });

  it("previous scan graded under a different explicit rubric version → no alert", async () => {
    seed("A", "A+", EMAIL_SCORE_RUBRIC_VERSION - 1);
    expect(await findEmailGradeChanges(db)).toEqual([]);
  });

  it("real change between two scans under the same rubric → alert", async () => {
    seed("D", "A+", EMAIL_SCORE_RUBRIC_VERSION);
    expect(await findEmailGradeChanges(db)).toEqual([
      { brand_id: "b1", name: "Acme", current_grade: "D", previous_grade: "A+" },
    ]);
  });

  it("saveEmailSecurityScan stamps the rubric version and the RFC 9989 tags (migration 0328)", async () => {
    raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)").run("b2", "Beta", "beta.example");
    await saveEmailSecurityScan(db, "b2", scanResult("A", 82));
    const row = raw.prepare(
      "SELECT score_rubric_version, dmarc_np, dmarc_t, dmarc_sp, dmarc_psd, dmarc_pct FROM email_security_scans WHERE brand_id = 'b2'",
    ).get() as Record<string, unknown>;
    expect(row).toEqual({
      score_rubric_version: EMAIL_SCORE_RUBRIC_VERSION, dmarc_np: "none", dmarc_t: "y", dmarc_sp: null, dmarc_psd: null, dmarc_pct: 100,
    });
  });
});

describe("Cartographer band-crossing gate", () => {
  it("treats an older / unknown baseline rubric as a rubric-only change", () => {
    expect(isRubricOnlyGradeChange(null)).toBe(true);
    expect(isRubricOnlyGradeChange(undefined)).toBe(true);
    expect(isRubricOnlyGradeChange(EMAIL_SCORE_RUBRIC_VERSION - 1)).toBe(true);
    expect(isRubricOnlyGradeChange(EMAIL_SCORE_RUBRIC_VERSION)).toBe(false);
  });

  it("is wired into Cartographer's notification and the orchestrator's alert", () => {
    const carto = readFileSync(resolve(__dirname, "../src/agents/cartographer.ts"), "utf8");
    expect(carto).toMatch(/!isRubricOnlyGradeChange\(rubricByBrand\.get\(String\(brand\.id\)\)\)/);
    const orch = readFileSync(resolve(__dirname, "../src/cron/orchestrator.ts"), "utf8");
    expect(orch).toMatch(/findEmailGradeChanges\(env\.DB\)/);
    expect(orch).not.toMatch(/b\.email_security_grade != ess\.email_security_grade/);
  });
});
