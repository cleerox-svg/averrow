import { describe, it, expect } from "vitest";
import {
  buildTenantDigestEmail,
  type OrgDigestData,
  type BrandDigestData,
} from "../src/lib/tenant-digest-email";
import { isDigestLiveMode, isoWeekLabel, runWeeklyTenantDigest } from "../src/lib/tenant-digest";
import type { Env } from "../src/types";

function makeBrand(overrides: Partial<BrandDigestData> = {}): BrandDigestData {
  return {
    brandId:    "b1",
    brandName:  "Acme Corp",
    newThreats: 7,
    threatsBySeverity: { critical: 1, high: 2, medium: 4 },
    topThreats: [
      { indicator: "acme-login.top", threat_type: "phishing", severity: "critical" },
      { indicator: "acme-billing.xyz", threat_type: "typosquatting", severity: "high" },
    ],
    alertsOpened:   5,
    alertsResolved: 3,
    emailGrade:     "B",
    ...overrides,
  };
}

function makeData(overrides: Partial<OrgDigestData> = {}): OrgDigestData {
  return {
    orgName:      "Acme Holdings",
    weekStartIso: "2026-06-04",
    weekEndIso:   "2026-06-10",
    brands:       [makeBrand()],
    takedowns:    { submitted: 3, completed: 1, pending: 4 },
    ...overrides,
  };
}

describe("buildTenantDigestEmail", () => {
  it("subject carries total new threats and brand count", () => {
    const email = buildTenantDigestEmail(makeData({
      brands: [makeBrand({ newThreats: 7 }), makeBrand({ brandId: "b2", brandName: "Acme Bank", newThreats: 3 })],
    }));
    expect(email.subject).toContain("10 new threats");
    expect(email.subject).toContain("2 brands");
  });

  it("singularizes correctly for one threat and one brand", () => {
    const email = buildTenantDigestEmail(makeData({
      brands: [makeBrand({ newThreats: 1, threatsBySeverity: { high: 1 }, topThreats: [] })],
    }));
    expect(email.subject).toContain("1 new threat across 1 brand");
    expect(email.subject).not.toContain("threats");
  });

  it("renders brand sections with threat indicators and takedown totals", () => {
    const email = buildTenantDigestEmail(makeData());
    expect(email.html).toContain("Acme Corp");
    expect(email.html).toContain("acme-login.top");
    expect(email.html).toContain("Acme Holdings");
    // takedowns submitted
    expect(email.html).toContain("Takedowns submitted");
  });

  it("escapes HTML in org/brand/indicator strings", () => {
    const email = buildTenantDigestEmail(makeData({
      orgName: "Evil <script>alert(1)</script> Org",
      brands: [makeBrand({
        brandName: "B<img src=x>",
        topThreats: [{ indicator: "<b>bad</b>.example", threat_type: "phishing", severity: "high" }],
      })],
    }));
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).not.toContain("<img src=x>");
    expect(email.html).not.toContain("<b>bad</b>");
  });

  it("handles an empty week gracefully (no threats, no top list)", () => {
    const email = buildTenantDigestEmail(makeData({
      brands: [makeBrand({ newThreats: 0, threatsBySeverity: {}, topThreats: [], alertsOpened: 0, alertsResolved: 0 })],
      takedowns: { submitted: 0, completed: 0, pending: 0 },
    }));
    expect(email.subject).toContain("0 new threats");
    expect(email.html).not.toContain("Top new threats");
  });
});

describe("isDigestLiveMode", () => {
  it("is live only on the exact 'live' value", () => {
    expect(isDigestLiveMode({ TENANT_DIGEST_MODE: "live" } as unknown as Env)).toBe(true);
    expect(isDigestLiveMode({ TENANT_DIGEST_MODE: "off" } as unknown as Env)).toBe(false);
    expect(isDigestLiveMode({} as unknown as Env)).toBe(false);
  });
});

describe("isoWeekLabel", () => {
  it("computes ISO week labels across year boundaries", () => {
    expect(isoWeekLabel(new Date("2026-06-10T12:00:00Z"))).toBe("2026-W24");
    // Jan 1 2027 is a Friday — ISO week 53 of 2026.
    expect(isoWeekLabel(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeekLabel(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
  });
});

describe("runWeeklyTenantDigest mode gate", () => {
  it("is a no-op when TENANT_DIGEST_MODE is off — touches neither DB nor network", async () => {
    // Env deliberately has no DB/CACHE: any access would throw, proving
    // the mode gate short-circuits before any side effect.
    const result = await runWeeklyTenantDigest({ TENANT_DIGEST_MODE: "off" } as unknown as Env);
    expect(result.mode).toBe("off");
    expect(result.outcomes).toHaveLength(0);
  });

  it("is a no-op when the var is unset (safe default)", async () => {
    const result = await runWeeklyTenantDigest({} as unknown as Env);
    expect(result.mode).toBe("off");
  });
});
