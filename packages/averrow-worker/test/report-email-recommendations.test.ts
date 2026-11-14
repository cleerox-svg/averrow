/**
 * The brand report rebuilds its email recommendations from the stored
 * latest scan. It must pass the RFC 9989 inputs (pct, sp, np, t) through so
 * the report explains the testing-mode / np-gap penalties its grade carries.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, sqlContaining } from "./sqlite-d1-harness";
import { emailRecommendationInput, type StoredEmailScanRow } from "../src/handlers/reports";
import { generateRecommendations } from "../src/email-security";

const row = (over: Partial<StoredEmailScanRow> = {}): StoredEmailScanRow => ({
  dmarc_exists: 1, dmarc_policy: "reject", dmarc_pct: 100, dmarc_rua: "mailto:a@b.example",
  dmarc_sp: null, dmarc_np: null, dmarc_t: null,
  spf_exists: 1, spf_policy: "-all", spf_too_many_lookups: 0,
  dkim_exists: 1, dkim_selectors_found: '["google"]',
  mx_exists: 1, mx_providers: '["Google Workspace"]',
  ...over,
});

describe("report email recommendations (RFC 9989 inputs)", () => {
  it("passes stored pct / sp / np / t through", () => {
    const input = emailRecommendationInput(row({ dmarc_pct: 50, dmarc_sp: "none", dmarc_np: "none", dmarc_t: "y" }));
    expect(input.dmarc).toMatchObject({ pct: 50, sp: "none", np: "none", t: "y" });
  });

  it("explains testing mode and the np gap the stored grade includes", () => {
    const recs = generateRecommendations(emailRecommendationInput(row({ dmarc_t: "y", dmarc_np: "none" }))).join("\n");
    expect(recs).toMatch(/testing mode \(t=y\)/);
    expect(recs).toMatch(/non-existent subdomains/);
    expect(generateRecommendations(emailRecommendationInput(row({ dmarc_pct: 25 }))).join("\n")).toMatch(/pct=25/);
  });

  it("tolerates pre-0328 rows (NULL tags) and malformed JSON arrays", () => {
    const input = emailRecommendationInput(row({ dmarc_pct: null, dkim_selectors_found: "not json", mx_providers: '{"a":1}' }));
    expect(input.dkim.selectorsFound).toEqual([]);
    expect(input.mx.providers).toEqual([]);
    expect(generateRecommendations(input).join("\n")).not.toMatch(/testing|pct=/);
  });

  it.skipIf(!hasSqlite())("the report's latest-scan SELECT runs against the migrated schema", () => {
    const src = readFileSync(resolve(__dirname, "../src/handlers/reports.ts"), "utf8");
    const sql = sqlContaining(src, ["dmarc_np", "FROM email_security_scans WHERE brand_id = ?"]);
    const raw = openMigratedDb();
    expect(() => raw.prepare(sql).all("b1")).not.toThrow();
  });
});
