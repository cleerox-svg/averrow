/**
 * RFC 9989 (DMARCbis) tag parsing + posture scoring.
 */

import { describe, it, expect } from "vitest";
import {
  parseDmarcRecord,
  isDmarcTestingMode,
  effectiveNonExistentSubdomainPolicy,
  hasNonExistentSubdomainGap,
} from "../src/lib/dmarc-record";
import {
  calculateEmailSecurityScore,
  generateRecommendations,
  dmarcResultFromRecord,
  type EmailSecurityScanInput,
} from "../src/email-security";
import { parseDmarcPolicy } from "../src/lib/doh";

function scanFor(record: string | null): EmailSecurityScanInput {
  return {
    dmarc: dmarcResultFromRecord(record),
    spf: { exists: true, policy: "-all", includes: 2, tooManyLookups: false, raw: "v=spf1 -all" },
    dkim: { exists: true, selectorsFound: ["google"], raw: "Selectors: google" },
    mx: { exists: true, providers: ["Google Workspace"] },
  };
}
const score = (r: string | null) => calculateEmailSecurityScore(scanFor(r)).score;

describe("parseDmarcRecord", () => {
  it("parses p, sp, np, t, psd, pct, rua, ruf", () => {
    const r = parseDmarcRecord("v=DMARC1; p=reject; sp=quarantine; np=none; t=y; psd=n; pct=50; rua=mailto:a@b.example; ruf=mailto:f@b.example")!;
    expect(r.p).toBe("reject");
    expect(r.sp).toBe("quarantine");
    expect(r.np).toBe("none");
    expect(r.t).toBe("y");
    expect(r.psd).toBe("n");
    expect(r.pct).toBe(50);
    expect(r.rua).toBe("mailto:a@b.example");
    expect(r.ruf).toBe("mailto:f@b.example");
  });

  it("does not read np= or sp= as p= (old regex bug)", () => {
    expect(parseDmarcRecord("v=DMARC1; np=none; p=reject")!.p).toBe("reject");
    expect(parseDmarcPolicy("v=DMARC1; sp=none; p=quarantine")).toBe("quarantine");
    expect(parseDmarcPolicy("v=DMARC1; np=none; p=reject")).toBe("reject");
  });

  it("is case/whitespace tolerant and requires v=DMARC1 first", () => {
    expect(parseDmarcRecord("V=DMARC1 ; P = Quarantine ; T = Y")!.p).toBe("quarantine");
    expect(parseDmarcRecord("V=DMARC1 ; P = Quarantine ; T = Y")!.t).toBe("y");
    expect(parseDmarcRecord("p=reject; v=DMARC1")).toBeNull();
    expect(parseDmarcRecord("v=spf1 -all")).toBeNull();
    expect(parseDmarcRecord("")).toBeNull();
  });

  it("nulls invalid tag values but keeps the raw p", () => {
    const r = parseDmarcRecord("v=DMARC1; p=rejct; t=maybe; psd=x; pct=abc; np=block")!;
    expect(r.p).toBeNull();
    expect(r.pRaw).toBe("rejct");
    expect(r.t).toBeNull();
    expect(r.psd).toBeNull();
    expect(r.pct).toBeNull();
    expect(r.np).toBeNull();
    expect(parseDmarcRecord("v=DMARC1; pct=150")!.pct).toBeNull();
  });
});

describe("dmarcResultFromRecord", () => {
  it("keeps legacy defaults: pct 100 when absent, policy 'none' when p missing", () => {
    const d = dmarcResultFromRecord("v=DMARC1; rua=mailto:a@b.example");
    expect(d.exists).toBe(true);
    expect(d.policy).toBe("none");
    expect(d.pct).toBe(100);
    expect(d.np).toBeNull();
  });
  it("no record → exists false", () => {
    expect(dmarcResultFromRecord(undefined).exists).toBe(false);
  });
});

describe("testing mode and np helpers", () => {
  it("t=y and pct<100 are both testing; pct=100 / absent is not", () => {
    expect(isDmarcTestingMode({ policy: "reject", pct: 100, t: "y" })).toBe(true);
    expect(isDmarcTestingMode({ policy: "reject", pct: 0 })).toBe(true);
    expect(isDmarcTestingMode({ policy: "reject", pct: 99 })).toBe(true);
    expect(isDmarcTestingMode({ policy: "reject", pct: 100, t: "n" })).toBe(false);
    expect(isDmarcTestingMode({ policy: "reject", pct: null })).toBe(false);
  });

  it("np falls back to sp then p", () => {
    expect(effectiveNonExistentSubdomainPolicy({ policy: "reject", pct: 100 })).toBe("reject");
    expect(effectiveNonExistentSubdomainPolicy({ policy: "reject", pct: 100, sp: "none" })).toBe("none");
    expect(effectiveNonExistentSubdomainPolicy({ policy: "reject", pct: 100, sp: "none", np: "reject" })).toBe("reject");
  });

  it("gap only when apex enforces and effective np is none", () => {
    expect(hasNonExistentSubdomainGap({ policy: "reject", pct: 100, np: "none" })).toBe(true);
    expect(hasNonExistentSubdomainGap({ policy: "quarantine", pct: 100, sp: "none" })).toBe(true);
    expect(hasNonExistentSubdomainGap({ policy: "reject", pct: 100 })).toBe(false);
    expect(hasNonExistentSubdomainGap({ policy: "none", pct: 100, np: "none" })).toBe(false);
  });
});

describe("calculateEmailSecurityScore — RFC 9989", () => {
  const RUA = "; rua=mailto:d@acme.example";

  it("baseline reject unchanged (95, A+)", () => {
    expect(calculateEmailSecurityScore(scanFor(`v=DMARC1; p=reject${RUA}`))).toEqual({ score: 95, grade: "A+" });
  });

  it("pct is not scored on its own: pct=100 explicit == absent", () => {
    expect(score(`v=DMARC1; p=reject; pct=100${RUA}`)).toBe(score(`v=DMARC1; p=reject${RUA}`));
  });

  it("t=y and pct<100 get the same 'testing' treatment (one enforcement level lower)", () => {
    const testingT = score(`v=DMARC1; p=reject; t=y${RUA}`);
    const testingPct = score(`v=DMARC1; p=reject; pct=0${RUA}`);
    expect(testingT).toBe(testingPct);
    expect(testingT).toBe(87); // reject credited as quarantine: 95 - 8
    expect(score(`v=DMARC1; p=quarantine; t=y${RUA}`)).toBe(score(`v=DMARC1; p=none${RUA}`));
  });

  it("t=n is full enforcement", () => {
    expect(score(`v=DMARC1; p=reject; t=n${RUA}`)).toBe(95);
  });

  it("p=none is unaffected by t / pct", () => {
    expect(score(`v=DMARC1; p=none; t=y${RUA}`)).toBe(score(`v=DMARC1; p=none${RUA}`));
  });

  it("explicit np=none under enforcing p costs 5; missing np with enforcing fallback costs nothing", () => {
    expect(score(`v=DMARC1; p=reject; np=none${RUA}`)).toBe(90);
    expect(score(`v=DMARC1; p=reject; sp=none${RUA}`)).toBe(90);
    expect(score(`v=DMARC1; p=reject; sp=none; np=reject${RUA}`)).toBe(95);
    expect(score(`v=DMARC1; p=reject; np=quarantine${RUA}`)).toBe(95);
  });

  it("psd is parsed but never scored", () => {
    expect(score(`v=DMARC1; p=reject; psd=y${RUA}`)).toBe(95);
  });

  it("worst combined DMARCbis deduction is 13 points", () => {
    expect(score(`v=DMARC1; p=reject${RUA}`) - score(`v=DMARC1; p=reject; t=y; np=none${RUA}`)).toBe(13);
  });
});

describe("generateRecommendations — RFC 9989", () => {
  it("flags t=y, pct<100 and the np gap", () => {
    expect(generateRecommendations(scanFor("v=DMARC1; p=reject; t=y")).join("\n")).toMatch(/testing mode \(t=y\)/);
    expect(generateRecommendations(scanFor("v=DMARC1; p=reject; pct=25")).join("\n")).toMatch(/pct=25.*deprecated/);
    expect(generateRecommendations(scanFor("v=DMARC1; p=reject; np=none")).join("\n")).toMatch(/non-existent subdomains/);
  });

  it("no DMARCbis notes for a clean record", () => {
    const recs = generateRecommendations(scanFor("v=DMARC1; p=reject; rua=mailto:a@b.example")).join("\n");
    expect(recs).not.toMatch(/testing|pct|non-existent/);
  });
});
