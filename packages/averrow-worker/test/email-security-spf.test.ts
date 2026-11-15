/**
 * SPF include-tree walk wired into the posture scanner (email-security.ts):
 * findings → recommendations (no alert type), rubric 3 scoring, unread
 * includes not scored, root lookup failure (carry forward / not checked),
 * storage (migration 0332) and grade-change suppression only when SPF
 * uncertainty fully explains the change.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, sqliteTimestampHoursAgo, type SqliteDb } from "./sqlite-d1-harness";
import {
  CAPPED_SCAN_SPF_BUDGET,
  EMAIL_SCORE_RUBRIC_VERSION,
  buildSpfResult,
  calculateEmailSecurityScore,
  checkSpf,
  generateRecommendations,
  parseStoredSpfFindings,
  previousSpfLoader,
  saveEmailSecurityScan,
  spfFindingRecommendations,
  storedSpfWalkStatus,
  type EmailSecurityResult,
  type EmailSecurityScanInput,
  type SpfResult,
  type StoredEmailScanRow,
} from "../src/email-security";
import {
  findEmailGradeChanges, isSpfUncertaintyOnlyGradeChange, isSpfUncertaintyOnlyChange, resolveScanGradeChange,
} from "../src/lib/email-grade-change";
import { EMAIL_SCAN_BUDGET_MS } from "../src/lib/free-scan-view";
import { emailRecommendationInput } from "../src/handlers/reports";
import type { SpfTxtLookup } from "../src/lib/spf-walk";

type Zone = Record<string, { status: "ok" | "nxdomain" | "error"; records: string[] }>;
function dns(zone: Zone): SpfTxtLookup {
  return async (name) => zone[name] ?? { status: "nxdomain", records: [] };
}
const ok = (...records: string[]) => ({ status: "ok" as const, records });

function scanWith(spf: SpfResult): EmailSecurityScanInput {
  return {
    dmarc: { exists: true, policy: "reject", pct: 100, rua: "mailto:a@b.example", ruf: null, raw: "v=DMARC1; p=reject" },
    spf,
    dkim: { exists: true, selectorsFound: ["google"], raw: null },
    mx: { exists: true, providers: [] },
  };
}
const score = (spf: SpfResult) => calculateEmailSecurityScore(scanWith(spf)).score;

/** Ten includes of a.com (1 lookup each) + root `mx` = 11. */
function overLimitZone(extra: Zone = {}): Zone {
  const zone: Zone = { ...extra };
  for (let i = 0; i < 10; i++) zone[`i${i}.acme.com`] = ok("v=spf1 ip4:192.0.2.1 -all");
  return zone;
}
const TEN_INCLUDES = Array.from({ length: 10 }, (_, i) => `include:i${i}.acme.com`).join(" ");

describe("rubric version", () => {
  it("is 4 (dangling-include confirmation changed scoring)", () => {
    expect(EMAIL_SCORE_RUBRIC_VERSION).toBe(4);
  });
});

describe("checkSpf → findings", () => {
  it("clean -all record: complete walk, no findings, full 30 SPF points", async () => {
    const spf = await checkSpf("acme.com", dns({
      "acme.com": ok("v=spf1 include:_spf.google.com -all"),
      "_spf.google.com": ok("v=spf1 ip4:192.0.2.0/24 ~all"),
    }));
    expect(spf).toMatchObject({ exists: true, policy: "-all", tooManyLookups: false, lookupCount: 1, voidLookups: 0, walkStatus: "complete", findings: [] });
    expect(score(spf)).toBe(95);
  });

  it("over the 10-lookup limit → finding + permerror scoring (only the +10 record credit)", async () => {
    const spf = await checkSpf("acme.com", dns(overLimitZone({ "acme.com": ok(`v=spf1 mx ${TEN_INCLUDES} -all`) })));
    expect(spf.lookupCount).toBe(11);
    expect(spf.tooManyLookups).toBe(true);
    // The walk stops at the proven limit, so the count is a lower bound.
    expect(spf.findings).toContainEqual({ code: "lookup_limit_exceeded", count: 11, atLeast: true });
    expect(score(spf)).toBe(95 - 20);
    expect(generateRecommendations(scanWith(spf)).join("\n")).toMatch(/SPF needs at least 11 DNS lookups \(limit 10\)/);
  });

  it("a limit crossed deep in the tree is proven too", async () => {
    const zone = overLimitZone({ "acme.com": ok(`v=spf1 ${TEN_INCLUDES} -all`) });
    zone["i9.acme.com"] = ok("v=spf1 a -all");
    const spf = await checkSpf("acme.com", dns(zone));
    expect(spf.findings).toContainEqual({ code: "lookup_limit_exceeded", count: 11, atLeast: true });
    expect(spf.tooManyLookups).toBe(true);
  });

  it("exactly 10 lookups is within the limit", async () => {
    const spf = await checkSpf("acme.com", dns(overLimitZone({ "acme.com": ok(`v=spf1 ${TEN_INCLUDES} -all`) })));
    expect(spf.lookupCount).toBe(10);
    expect(spf.tooManyLookups).toBe(false);
    expect(score(spf)).toBe(95);
  });

  it("multiple SPF records → not walked, permerror scoring", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 -all", "v=spf1 include:x.com ~all") }));
    expect(spf.walkStatus).toBe("not_walked");
    expect(spf.findings).toContainEqual({ code: "multiple_records", count: 2 });
    expect(score(spf)).toBe(95 - 20);
    expect(generateRecommendations(scanWith(spf)).join("\n")).toMatch(/More than one SPF record/);
  });

  it("+all and bare `all` score 0 for SPF (was 15)", async () => {
    for (const rec of ["v=spf1 +all", "v=spf1 all"]) {
      const spf = await checkSpf("acme.com", dns({ "acme.com": ok(rec) }));
      expect(spf.policy).toBe("+all");
      expect(spf.findings).toContainEqual({ code: "pass_all" });
      expect(score(spf)).toBe(95 - 30);
    }
  });

  it("?all keeps its neutral score and the soft-fail recommendation", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 ?all") }));
    expect(spf.findings).toContainEqual({ code: "neutral_all" });
    expect(score(spf)).toBe(95 - 12);
    expect(generateRecommendations(scanWith(spf)).join("\n")).toMatch(/soft-fail/);
  });

  it("void lookups > 2, ptr, missing / multi-record / +all include targets, syntax errors → recommendations only", async () => {
    const spf = await checkSpf("acme.com", dns({
      "acme.com": ok("v=spf1 ptr include:gone1.com include:gone2.com include:gone3.com include:multi.acme.com include:lax.acme.com include:bad.acme.com -all"),
      "multi.acme.com": ok("v=spf1 -all", "v=spf1 ~all"),
      "lax.acme.com": ok("v=spf1 +all"),
      "bad.acme.com": ok("v=spf1 foo -all"),
    }));
    expect(spf.walkStatus).toBe("complete");
    expect(spf.voidLookups).toBe(3);
    const codes = (spf.findings ?? []).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining([
      "void_lookup_limit_exceeded", "ptr_mechanism", "include_target_missing",
      "include_multiple_records", "include_pass_all", "syntax_error",
    ]));
    expect(codes).not.toContain("pass_all");
    expect(score(spf)).toBe(95);
    const recs = spfFindingRecommendations(spf).join("\n");
    expect(recs).toMatch(/3 void lookups \(limit 2\)/);
    expect(recs).toMatch(/deprecated "ptr"/);
    expect(recs).toMatch(/gone1\.com.*re-registered/);
    expect(recs).toMatch(/included SPF record ends in "\+all" \(lax\.acme\.com\)/);
  });

  it("a proven include loop is a scored permerror", async () => {
    const spf = await checkSpf("acme.com", dns({
      "acme.com": ok("v=spf1 include:loop.acme.com -all"),
      "loop.acme.com": ok("v=spf1 include:acme.com -all"),
    }));
    expect(spf.findings).toContainEqual({ code: "include_loop", names: ["acme.com"] });
    expect(score(spf)).toBe(95 - 20);
    expect(spfFindingRecommendations(spf).join("\n")).toMatch(/CRITICAL: SPF include chain loops back/);
  });

  it("a redirect-only record takes its target's `all`", async () => {
    const spf = await checkSpf("acme.com", dns({
      "acme.com": ok("v=spf1 redirect=_spf.acme.com"),
      "_spf.acme.com": ok("v=spf1 ip4:192.0.2.1 -all"),
    }));
    expect(spf.policy).toBe("-all");
    expect(spf.lookupCount).toBe(1);
  });

  it("no record", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok("v=DMARC1") }));
    expect(spf).toMatchObject({ exists: false, walkStatus: "no_record" });
    expect(generateRecommendations(scanWith(spf)).join("\n")).toMatch(/No SPF record found/);
  });
});

describe("root SPF lookup failure", () => {
  const failing = dns({ "acme.com": { status: "error", records: [] } });

  it("without a previous scan: not checked — no 'No SPF record' message", async () => {
    const spf = await checkSpf("acme.com", failing);
    expect(spf).toMatchObject({ exists: false, rootError: true, walkStatus: "root_error" });
    expect(spf.findings).toEqual([{ code: "root_lookup_failed" }]);
    const recs = generateRecommendations(scanWith(spf)).join("\n");
    expect(recs).toMatch(/Could not check the SPF record/);
    expect(recs).not.toMatch(/No SPF record found/);
  });

  it("with a previous scan: carried forward (same score) and flagged", async () => {
    const previous = await checkSpf("acme.com", dns(overLimitZone({ "acme.com": ok(`v=spf1 mx ${TEN_INCLUDES} -all`) })));
    let loads = 0;
    const spf = await checkSpf("acme.com", failing, async () => { loads++; return previous; });
    expect(loads).toBe(1);
    expect(spf).toMatchObject({ exists: true, policy: "-all", tooManyLookups: true, walkStatus: "complete", rootError: false });
    expect(spf.findings).toContainEqual({ code: "root_lookup_failed" });
    expect(score(spf)).toBe(score(previous));
    expect(spfFindingRecommendations(spf).join("\n")).toMatch(/result shown is from the previous scan/);
  });

  it("the previous loader is never called when the root lookup works", async () => {
    let loads = 0;
    await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 -all") }), async () => { loads++; return null; });
    expect(loads).toBe(0);
  });

  it("a throwing loader falls back to not checked", async () => {
    const spf = await checkSpf("acme.com", failing, async () => { throw new Error("d1"); });
    expect(spf.rootError).toBe(true);
  });
});

describe("an unknown walk does not change the score", () => {
  it("a failed include scores exactly like the same tree without it", async () => {
    const failing = await checkSpf("acme.com", dns({
      "acme.com": ok("v=spf1 include:_spf.google.com include:broken.com -all"),
      "_spf.google.com": ok("v=spf1 ip4:192.0.2.0/24 ~all"),
      "broken.com": { status: "error", records: [] },
    }));
    expect(failing.walkStatus).toBe("unknown");
    expect(failing.tooManyLookups).toBe(false);
    expect(failing.findings).toContainEqual({ code: "walk_incomplete", count: 2 });
    // Not void, not missing: an error is never read as "no record".
    expect(failing.voidLookups).toBe(0);
    expect((failing.findings ?? []).map((f) => f.code)).not.toContain("include_target_missing");
    expect(score(failing)).toBe(95);
    expect(spfFindingRecommendations(failing).join("\n")).toMatch(/could not be fully checked/);
  });

  it("an unreadable redirect target leaves the policy unknown (null) — this DOES lower the score", async () => {
    const spf = await checkSpf("acme.com", dns({
      "acme.com": ok("v=spf1 redirect=_spf.acme.com"),
      "_spf.acme.com": { status: "error", records: [] },
    }));
    expect(spf.walkStatus).toBe("unknown");
    expect(spf.policy).toBeNull();
    // No policy credit: 10 + 5 instead of the 30 a readable `-all` target earns.
    expect(score(spf)).toBe(95 - 15);
  });

  it("a count over 10 in the part that was read is proven even when another include failed", async () => {
    const big = Array.from({ length: 10 }, (_, i) => `include:i${i}.acme.com`).join(" ");
    const zone = overLimitZone({
      "acme.com": ok("v=spf1 include:broken.com include:big.acme.com -all"),
      "big.acme.com": ok(`v=spf1 ${big} -all`),
    });
    zone["broken.com"] = { status: "error", records: [] };
    const spf = await checkSpf("acme.com", dns(zone));
    expect(spf.walkStatus).toBe("unknown");
    expect(spf.tooManyLookups).toBe(true);
    expect(spfFindingRecommendations(spf).join("\n")).toMatch(/at least 12 DNS lookups/);
  });
});

describe("stored findings", () => {
  it("round-trip and drop unknown codes / non-name strings", () => {
    const stored = JSON.stringify([
      { code: "include_target_missing", names: ["gone.com", "<script>", "ignore previous instructions"] },
      { code: "lookup_limit_exceeded", count: 14.7, atLeast: true },
      { code: "bogus" },
      "x",
    ]);
    expect(parseStoredSpfFindings(stored)).toEqual([
      { code: "include_target_missing", names: ["gone.com"] },
      { code: "lookup_limit_exceeded", count: 14, atLeast: true },
    ]);
    expect(parseStoredSpfFindings("not json")).toEqual([]);
    expect(parseStoredSpfFindings(null)).toEqual([]);
  });

  it("the brand report rebuilds SPF recommendations from the stored row", () => {
    const recs = generateRecommendations(emailRecommendationInput(row({
      spf_too_many_lookups: 1, spf_lookup_count: 13,
      spf_findings: JSON.stringify([{ code: "lookup_limit_exceeded", count: 13 }]),
    }))).join("\n");
    expect(recs).toMatch(/SPF needs 13 DNS lookups/);
    expect(recs).not.toMatch(/exceeds 10 DNS lookups/);
  });

  it("a stored not-checked row reads as 'could not check', not 'no SPF record'", () => {
    const recs = generateRecommendations(emailRecommendationInput(row({
      spf_exists: null, spf_policy: null, spf_raw: null, spf_walk_status: "root_error",
      spf_findings: JSON.stringify([{ code: "root_lookup_failed" }]),
    }))).join("\n");
    expect(recs).toMatch(/Could not check the SPF record/);
    expect(recs).not.toMatch(/No SPF record found/);
  });

  it("a pre-0332 row (boolean only) keeps the legacy recommendation", () => {
    const recs = spfFindingRecommendations({ exists: true, policy: "-all", includes: 0, tooManyLookups: true, raw: null });
    expect(recs).toEqual(["SPF record exceeds 10 DNS lookups — this causes SPF validation failures."]);
  });
});

describe("buildSpfResult never stores record text in findings", () => {
  it("only validated names", () => {
    const r = buildSpfResult("bad domain!", "ok", ["v=spf1 foo -all"], null);
    expect(r.findings).toContainEqual({ code: "syntax_error", names: [] });
  });
});

// ─── Grade-change suppression (lib/email-grade-change.ts) ─────────────────

const ROOT = "v=spf1 include:_spf.acme.com -all";

/** A stored row that scores 95 / A+ (DMARC reject + rua, SPF -all, DKIM, MX). */
function row(over: Partial<StoredEmailScanRow> = {}): StoredEmailScanRow {
  return {
    dmarc_exists: 1, dmarc_policy: "reject", dmarc_pct: 100, dmarc_rua: "mailto:a@b.example",
    dmarc_sp: null, dmarc_np: null, dmarc_t: null,
    spf_exists: 1, spf_policy: "-all", spf_too_many_lookups: 0, spf_raw: ROOT,
    spf_lookup_count: 3, spf_void_lookups: 0, spf_walk_status: "complete", spf_findings: "[]",
    dkim_exists: 1, dkim_selectors_found: '["google"]', mx_exists: 1, mx_providers: "[]",
    ...over,
  };
}
const overLimitRow = (over: Partial<StoredEmailScanRow> = {}) => row({
  spf_too_many_lookups: 1, spf_lookup_count: 12,
  spf_findings: JSON.stringify([{ code: "lookup_limit_exceeded", count: 12, atLeast: true }]),
  ...over,
});
const timedOutRow = (over: Partial<StoredEmailScanRow> = {}) => row({
  spf_lookup_count: 5, spf_walk_status: "unknown",
  spf_findings: JSON.stringify([{ code: "walk_incomplete", count: 5 }]),
  ...over,
});
const grade = (r: StoredEmailScanRow) => calculateEmailSecurityScore(emailRecommendationInput(r)).grade;

describe("isSpfUncertaintyOnlyGradeChange", () => {
  it("fixtures grade as expected", () => {
    expect(grade(row())).toBe("A+");
    expect(grade(overLimitRow())).toBe("B");
    expect(grade(timedOutRow())).toBe("A+");
  });

  it("pure timeout flip (same DNS, one walk unknown) → suppressed, both directions", () => {
    expect(isSpfUncertaintyOnlyGradeChange(overLimitRow(), timedOutRow())).toBe(true);
    expect(isSpfUncertaintyOnlyGradeChange(timedOutRow(), overLimitRow())).toBe(true);
  });

  it("(a) root record changed to `include:<blackholed> +all` with an unknown walk → alerts", () => {
    const current = row({
      spf_raw: "v=spf1 include:blackholed.example.net +all", spf_policy: "+all", spf_lookup_count: 1,
      spf_walk_status: "unknown",
      spf_findings: JSON.stringify([{ code: "pass_all" }, { code: "walk_incomplete", count: 1 }]),
    });
    expect(grade(current)).not.toBe("A+");
    expect(isSpfUncertaintyOnlyGradeChange(row(), current)).toBe(false);
  });

  it("(b) DMARC reject → none coinciding with an include timeout → alerts", () => {
    const current = timedOutRow({ dmarc_policy: "none" });
    expect(grade(current)).not.toBe("A+");
    expect(isSpfUncertaintyOnlyGradeChange(row(), current)).toBe(false);
  });

  it("both walks complete → never suppressed", () => {
    expect(isSpfUncertaintyOnlyGradeChange(row(), overLimitRow())).toBe(false);
  });

  it("spf_exists / multiple-records changes are root facts → never suppressed", () => {
    const gone = row({ spf_exists: 0, spf_raw: null, spf_policy: null, spf_walk_status: "no_record", spf_findings: "[]" });
    expect(isSpfUncertaintyOnlyGradeChange(timedOutRow(), gone)).toBe(false);
    const multi = timedOutRow({ spf_findings: JSON.stringify([{ code: "multiple_records", count: 2 }]) });
    expect(isSpfUncertaintyOnlyGradeChange(row(), multi)).toBe(false);
  });

  it("an unreadable redirect target (redirect-derived policy) is held to the previous scan", () => {
    const redirect = "v=spf1 redirect=_spf.acme.com";
    const prev = row({ spf_raw: redirect, spf_lookup_count: 1 });
    const curr = timedOutRow({ spf_raw: redirect, spf_policy: null, spf_lookup_count: 1 });
    expect(grade(curr)).toBe("A");
    expect(isSpfUncertaintyOnlyGradeChange(prev, curr)).toBe(true);
  });

  it("root lookup failed (SPF not checked) → no alert from that scan, unless something else changed", () => {
    const notChecked = (over: Partial<StoredEmailScanRow> = {}) => row({
      spf_exists: null, spf_policy: null, spf_raw: null, spf_too_many_lookups: 0, spf_lookup_count: null,
      spf_walk_status: "root_error", spf_findings: JSON.stringify([{ code: "root_lookup_failed" }]), ...over,
    });
    expect(grade(notChecked())).not.toBe("A+");
    expect(isSpfUncertaintyOnlyGradeChange(row(), notChecked())).toBe(true);
    expect(isSpfUncertaintyOnlyGradeChange(row(), notChecked({ dmarc_policy: "none" }))).toBe(false);
  });

  it("Cartographer form compares the fresh result as it is stored", () => {
    expect(isSpfUncertaintyOnlyChange(undefined, resultFor(row()))).toBe(false);
  });
});

function resultFor(r: StoredEmailScanRow): EmailSecurityResult {
  const findings = parseStoredSpfFindings(r.spf_findings);
  return {
    domain: "acme.example", score: 0, grade: grade(r), score_rubric_version: EMAIL_SCORE_RUBRIC_VERSION,
    dmarc: {
      exists: !!r.dmarc_exists, policy: r.dmarc_policy, pct: r.dmarc_pct, rua: r.dmarc_rua, ruf: null,
      sp: null, np: null, t: null, psd: null, testing: false, reporting_enabled: !!r.dmarc_rua, record: null,
    },
    spf: {
      exists: r.spf_exists === 1, policy: r.spf_policy, too_many_lookups: !!r.spf_too_many_lookups,
      record: r.spf_raw ?? null, lookup_count: r.spf_lookup_count ?? null, void_lookups: r.spf_void_lookups ?? null,
      walk_status: storedSpfWalkStatus(r.spf_walk_status) ?? "no_record", findings,
    },
    dkim: { exists: !!r.dkim_exists, selectors_found: ["google"] },
    mx: { exists: !!r.mx_exists, providers: [] },
    bimi: { record: null, svg_url: null, vmc_url: null, vmc_valid: false, vmc_expiry: null, grade: "B" },
    recommendations: [], scanned_at: "", scan_duration_ms: 1,
  };
}

describe.skipIf(!hasSqlite())("storage + grade-change detection (migration 0332)", () => {
  let raw: SqliteDb;
  let db: D1Database;

  beforeEach(() => {
    raw = openMigratedDb();
    db = d1FromSqlite(raw);
  });

  const COLS = [
    "dmarc_exists", "dmarc_policy", "dmarc_pct", "dmarc_rua", "dmarc_sp", "dmarc_np", "dmarc_t",
    "spf_exists", "spf_policy", "spf_too_many_lookups", "spf_raw", "spf_lookup_count", "spf_void_lookups",
    "spf_walk_status", "spf_findings", "dkim_exists", "dkim_selectors_found", "mx_exists", "mx_providers",
  ] as const;

  function insertScan(r: StoredEmailScanRow, scannedAt: string) {
    raw.prepare(
      `INSERT INTO email_security_scans (brand_id, domain, email_security_score, email_security_grade, score_rubric_version, scanned_at, ${COLS.join(", ")})
       VALUES (?, ?, ?, ?, ?, ?, ${COLS.map(() => "?").join(", ")})`,
    ).run("b1", "acme.example", 0, grade(r), EMAIL_SCORE_RUBRIC_VERSION, scannedAt, ...COLS.map((c) => r[c] ?? null));
  }

  function seed(previous: StoredEmailScanRow, current: StoredEmailScanRow) {
    const now = sqliteTimestampHoursAgo(1);
    raw.prepare(
      "INSERT INTO brands (id, name, canonical_domain, email_security_grade, email_security_scanned_at) VALUES (?, ?, ?, ?, ?)",
    ).run("b1", "Acme", "acme.example", grade(current), now);
    insertScan(previous, sqliteTimestampHoursAgo(8 * 24));
    insertScan(current, now);
  }

  it("pure timeout flip: no alert", async () => {
    seed(overLimitRow(), timedOutRow());
    expect(await findEmailGradeChanges(db)).toEqual([]);
  });

  it("(a) +all behind an unknown walk: alerts", async () => {
    seed(row(), row({
      spf_raw: "v=spf1 include:blackholed.example.net +all", spf_policy: "+all", spf_walk_status: "unknown",
      spf_findings: JSON.stringify([{ code: "pass_all" }, { code: "walk_incomplete", count: 1 }]),
    }));
    expect(await findEmailGradeChanges(db)).toEqual([
      { brand_id: "b1", name: "Acme", current_grade: "C", previous_grade: "A+" },
    ]);
  });

  it("(b) DMARC downgrade + include timeout: alerts", async () => {
    seed(row(), timedOutRow({ dmarc_policy: "none" }));
    expect(await findEmailGradeChanges(db)).toHaveLength(1);
  });

  it("both walks complete: real change alerts", async () => {
    seed(row(), overLimitRow());
    expect(await findEmailGradeChanges(db)).toHaveLength(1);
  });

  it("saveEmailSecurityScan writes the SPF walk columns", async () => {
    raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)").run("b2", "Beta", "beta.example");
    const result: EmailSecurityResult = {
      domain: "beta.example", score: 75, grade: "B", score_rubric_version: EMAIL_SCORE_RUBRIC_VERSION,
      dmarc: {
        exists: true, policy: "reject", pct: 100, rua: null, ruf: null, sp: null, np: null, t: null, psd: null,
        testing: false, reporting_enabled: false, record: "v=DMARC1; p=reject",
      },
      spf: {
        exists: true, policy: "-all", too_many_lookups: true, record: "v=spf1 -all",
        lookup_count: 12, void_lookups: 1, walk_status: "complete",
        findings: [{ code: "lookup_limit_exceeded", count: 12 }],
      },
      dkim: { exists: false, selectors_found: [] },
      mx: { exists: true, providers: [] },
      bimi: { record: null, svg_url: null, vmc_url: null, vmc_valid: false, vmc_expiry: null, grade: "B" },
      recommendations: [], scanned_at: "", scan_duration_ms: 1,
    };
    await saveEmailSecurityScan(db, "b2", result);
    const stored = raw.prepare(
      "SELECT spf_exists, spf_lookup_count, spf_void_lookups, spf_walk_status, spf_findings, spf_too_many_lookups, score_rubric_version FROM email_security_scans WHERE brand_id = 'b2'",
    ).get() as Record<string, unknown>;
    expect(stored).toEqual({
      spf_exists: 1, spf_lookup_count: 12, spf_void_lookups: 1, spf_walk_status: "complete",
      spf_findings: '[{"code":"lookup_limit_exceeded","count":12}]', spf_too_many_lookups: 1,
      score_rubric_version: 4,
    });
  });

  it("a not-checked scan is stored with spf_exists NULL, never a confirmed 0", async () => {
    raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)").run("b3", "Gamma", "gamma.example");
    const r = resultFor(row({
      spf_exists: null, spf_policy: null, spf_raw: null, spf_walk_status: "root_error",
      spf_findings: JSON.stringify([{ code: "root_lookup_failed" }]),
    }));
    await saveEmailSecurityScan(db, "b3", r);
    const stored = raw.prepare("SELECT spf_exists, spf_walk_status FROM email_security_scans WHERE brand_id = 'b3'").get();
    expect(stored).toEqual({ spf_exists: null, spf_walk_status: "root_error" });
  });

  it("previousSpfLoader skips not-checked rows and returns the last checked SPF", async () => {
    insertScan(overLimitRow(), sqliteTimestampHoursAgo(48));
    insertScan(row({ spf_exists: null, spf_raw: null, spf_policy: null, spf_walk_status: "root_error" }), sqliteTimestampHoursAgo(2));
    const prev = await previousSpfLoader(db, "b1")();
    expect(prev).toMatchObject({ exists: true, tooManyLookups: true, walkStatus: "complete" });
  });
});

// ─── Fix round 2 ───────────────────────────────────────────────────────────

describe("long flattened ip4 lists", () => {
  it("110 × ip4 + -all scores exactly like a short -all record", async () => {
    const ips = Array.from({ length: 110 }, (_, i) => `ip4:198.51.100.${i}`).join(" ");
    const long = await checkSpf("acme.com", dns({ "acme.com": ok(`v=spf1 ${ips} -all`) }));
    const short = await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 ip4:198.51.100.1 -all") }));
    expect(long).toMatchObject({ policy: "-all", walkStatus: "complete", tooManyLookups: false, lookupCount: 0 });
    expect(long.findings).toEqual([]);
    expect(score(long)).toBe(score(short));
    expect(score(long)).toBe(95);
  });
});

describe("shared SPF budget for wall-clock-capped scans", () => {
  it("CAPPED_SCAN_SPF_BUDGET fits inside the 8 s free-scan cap", () => {
    expect(CAPPED_SCAN_SPF_BUDGET.rootTimeoutMs).toBe(3_000);
    expect(CAPPED_SCAN_SPF_BUDGET.totalMs).toBeLessThan(EMAIL_SCAN_BUDGET_MS);
  });

  it("the root lookup gets rootTimeoutMs and the walk only what is left of totalMs", async () => {
    const timeouts: Array<[string, number]> = [];
    const lookup: SpfTxtLookup = async (name, timeoutMs) => {
      timeouts.push([name, timeoutMs]);
      if (name === "acme.com") {
        await new Promise((r) => setTimeout(r, 60));
        return { status: "ok", records: ["v=spf1 include:_spf.acme.com -all"] };
      }
      return { status: "ok", records: ["v=spf1 -all"] };
    };
    await checkSpf("acme.com", lookup, undefined, { rootTimeoutMs: 3_000, totalMs: 1_000 });
    expect(timeouts[0]).toEqual(["acme.com", 3_000]);
    expect(timeouts[1]![0]).toBe("_spf.acme.com");
    expect(timeouts[1]![1]).toBeLessThanOrEqual(1_000 - 50);
  });

  it("without a budget the defaults stay (5 s root)", async () => {
    const timeouts: number[] = [];
    await checkSpf("acme.com", async (_n, t) => { timeouts.push(t); return { status: "ok", records: ["v=spf1 -all"] }; });
    expect(timeouts).toEqual([5_000]);
  });
});

describe("carrying a pre-0332 scan forward", () => {
  const legacy: SpfResult = { exists: true, policy: "-all", includes: 0, tooManyLookups: false, raw: ROOT, walkStatus: null, findings: [] };

  it("is stored as carried_legacy, never no_record next to spf_exists = 1", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": { status: "error", records: [] } }), async () => legacy);
    expect(spf.walkStatus).toBe("carried_legacy");
    expect(spf.exists).toBe(true);
  });

  it("counts as SPF-uncertain: the next real walk does not raise a walk-only alert", () => {
    const carried = row({ spf_walk_status: "carried_legacy", spf_lookup_count: null, spf_findings: JSON.stringify([{ code: "root_lookup_failed" }]) });
    const walked = overLimitRow();
    expect(grade(carried)).not.toBe(grade(walked));
    expect(isSpfUncertaintyOnlyGradeChange(carried, walked)).toBe(true);
    // A root-record change still alerts.
    expect(isSpfUncertaintyOnlyGradeChange(carried, overLimitRow({ spf_raw: "v=spf1 +all", spf_policy: "+all" }))).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("a not-checked scan is never the baseline (both detectors)", () => {
  let raw: SqliteDb;
  let db: D1Database;

  beforeEach(() => {
    raw = openMigratedDb();
    db = d1FromSqlite(raw);
  });

  const COLS = [
    "dmarc_exists", "dmarc_policy", "dmarc_pct", "dmarc_rua", "dmarc_sp", "dmarc_np", "dmarc_t",
    "spf_exists", "spf_policy", "spf_too_many_lookups", "spf_raw", "spf_lookup_count", "spf_void_lookups",
    "spf_walk_status", "spf_findings", "dkim_exists", "dkim_selectors_found", "mx_exists", "mx_providers",
  ] as const;

  function insertScan(r: StoredEmailScanRow, scannedAt: string): void {
    raw.prepare(
      `INSERT INTO email_security_scans (brand_id, domain, email_security_score, email_security_grade, score_rubric_version, scanned_at, ${COLS.join(", ")})
       VALUES (?, ?, ?, ?, ?, ?, ${COLS.map(() => "?").join(", ")})`,
    ).run("b1", "acme.example", 0, grade(r), EMAIL_SCORE_RUBRIC_VERSION, scannedAt, ...COLS.map((c) => r[c] ?? null));
  }
  function brand(gradeNow: string, scannedAt: string): void {
    raw.prepare(
      "INSERT INTO brands (id, name, canonical_domain, email_security_grade, email_security_scanned_at) VALUES (?, ?, ?, ?, ?)",
    ).run("b1", "Acme", "acme.example", gradeNow, scannedAt);
  }

  // No DKIM: -all scores 75 (B, "good"); SPF 0 scores 45 (D, "bad").
  const scan1 = row({ dkim_exists: 0, dkim_selectors_found: "[]" });
  const scan2NotChecked = row({
    dkim_exists: 0, dkim_selectors_found: "[]",
    spf_exists: null, spf_policy: null, spf_raw: null, spf_lookup_count: null,
    spf_walk_status: "root_error", spf_findings: JSON.stringify([{ code: "root_lookup_failed" }]),
  });
  const scan3PassAll = row({
    dkim_exists: 0, dkim_selectors_found: "[]",
    spf_raw: "v=spf1 +all", spf_policy: "+all", spf_lookup_count: 0,
    spf_findings: JSON.stringify([{ code: "pass_all" }]),
  });
  const T1 = sqliteTimestampHoursAgo(16 * 24);
  const T2 = sqliteTimestampHoursAgo(8 * 24);
  const T3 = sqliteTimestampHoursAgo(1);

  it("fixtures", () => {
    expect([grade(scan1), grade(scan2NotChecked), grade(scan3PassAll)]).toEqual(["B", "D", "D"]);
  });

  it("orchestrator: the not-checked scan itself raises nothing", async () => {
    insertScan(scan1, T1);
    insertScan(scan2NotChecked, T3);
    brand("D", T3);
    expect(await findEmailGradeChanges(db)).toEqual([]);
  });

  it("orchestrator: -all (B) → not checked (D) → +all (D) alerts B → D on the third scan", async () => {
    insertScan(scan1, T1);
    insertScan(scan2NotChecked, T2);
    insertScan(scan3PassAll, T3);
    brand("D", T3);
    expect(await findEmailGradeChanges(db)).toEqual([
      { brand_id: "b1", name: "Acme", current_grade: "D", previous_grade: "B" },
    ]);
  });

  it("orchestrator: -all → not checked → -all again is not a change", async () => {
    insertScan(scan1, T1);
    insertScan(scan2NotChecked, T2);
    insertScan(scan1, T3);
    brand("B", T3);
    expect(await findEmailGradeChanges(db)).toEqual([]);
  });

  it("Cartographer: the same sequence is a B → D change", async () => {
    insertScan(scan1, T1);
    insertScan(scan2NotChecked, T2);
    const change = await resolveScanGradeChange(db, "b1", { ...scan2NotChecked, scanned_at: T2 }, "D", resultFor(scan3PassAll));
    expect(change).toEqual({ isChange: true, previousGrade: "B", currentGrade: "D" });
    const same = await resolveScanGradeChange(db, "b1", { ...scan2NotChecked, scanned_at: T2 }, "D", resultFor(scan1));
    expect(same.isChange).toBe(false);
  });

  it("the current scan is the one that set brands.email_security_scanned_at, not a later row", async () => {
    insertScan(overLimitRow(), T1);
    insertScan(timedOutRow(), T2);            // pure timeout flip → suppressed
    brand("A+", T2);
    insertScan(timedOutRow({ dmarc_policy: "none" }), T3);  // written later by another path
    expect(await findEmailGradeChanges(db)).toEqual([]);
  });

  it("qualifiedReport passes previousSpfLoader to its brand-scoped scan", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/handlers/qualifiedReport.ts"), "utf8");
    expect(src).toMatch(/runEmailSecurityScanWithin\(domain, EMAIL_SCAN_BUDGET_MS,\s*brandId != null \? \{ previousSpf: previousSpfLoader\(env\.DB, brandId\) \}/);
  });
});
