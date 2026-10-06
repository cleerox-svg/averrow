/**
 * G30 — the email grade is neutral: where DMARC reports go does not
 * change the score. The old +5 for an Averrow rua address is gone.
 */

import { describe, it, expect } from "vitest";
import { calculateEmailSecurityScore, type EmailSecurityScanInput } from "../src/email-security";

function scan(rua: string | null, ruf: string | null = null): EmailSecurityScanInput {
  return {
    dmarc: { exists: true, policy: "reject", pct: 100, rua, ruf, raw: "v=DMARC1; p=reject" },
    spf: { exists: true, policy: "-all", includes: 2, tooManyLookups: false, raw: "v=spf1 -all" },
    dkim: { exists: true, selectorsFound: ["google"], raw: "Selectors: google" },
    mx: { exists: true, providers: ["Google Workspace"] },
  };
}

describe("calculateEmailSecurityScore (G30)", () => {
  it("scores an Averrow rua/ruf destination exactly like any other", () => {
    const elsewhere = calculateEmailSecurityScore(scan("mailto:dmarc@acme.example"));
    for (const rua of [
      "mailto:dmarc_rua@averrow.com",
      "mailto:dmarc_rua@trustradar.ca",
      "mailto:dmarc@acme.example,mailto:dmarc_rua@averrow.com",
    ]) {
      expect(calculateEmailSecurityScore(scan(rua, "mailto:dmarc_ruf@averrow.com"))).toEqual(elsewhere);
    }
  });

  it("a fully configured domain scores 95 — still A+ without any bonus", () => {
    expect(calculateEmailSecurityScore(scan("mailto:dmarc@acme.example"))).toEqual({ score: 95, grade: "A+" });
  });

  it("rua itself is still worth 5 points", () => {
    const withRua = calculateEmailSecurityScore(scan("mailto:dmarc@acme.example")).score;
    const without = calculateEmailSecurityScore(scan(null)).score;
    expect(withRua - without).toBe(5);
  });

  it("grade bands are unchanged", () => {
    // reject DMARC without rua (30) + SPF -all (30) + DKIM (20) + MX (10) = 90 → A+ boundary
    expect(calculateEmailSecurityScore(scan(null))).toEqual({ score: 90, grade: "A+" });
    // quarantine without rua: 22 + 30 + 20 + 10 = 82 → A
    const q = scan(null);
    q.dmarc.policy = "quarantine";
    expect(calculateEmailSecurityScore(q)).toEqual({ score: 82, grade: "A" });
  });
});
