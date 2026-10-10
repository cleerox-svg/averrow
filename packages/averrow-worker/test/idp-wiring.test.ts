// IdP impersonation wiring (docs/IDP_IMPERSONATION_PLAN_2026-10.md T2–T5):
// tagging glue, brand attribution on IdP tenant hosts, lookalike triage
// non-dismissal, dnstwist lure reservation, and the summary roll-up.
import { describe, it, expect } from "vitest";
import { tagThreat, needsBrandTokens, brandTokensFrom } from "../src/lib/idp-tagging";
import { fuzzyMatchBrandDetailed, type BrandRow } from "../src/lib/brandDetect";
import { decideLookalikeRegistrationTriage } from "../src/lib/alert-triage";
import { isUnderSharedHosting, resolveOfficialDomain, type OfficialDomainRow } from "../src/lib/safeDomains";
import { generatePermutations, IDP_LURE_PREFIXES, IDP_LURE_SUFFIXES } from "../src/lib/dnstwist";
import { STRONG_WORDS } from "../src/lib/nrd-brand-match";
import { IDP_TENANT_HOSTS, IDP_MITRE } from "../src/lib/idp-impersonation";
import { computeIdentityThreats, parseIdentityWindow } from "../src/handlers/identityThreats";
import { parseIdpBackfillLimit } from "../src/handlers/admin/idpBackfill";
import type { Env } from "../src/types";

describe("tagThreat", () => {
  it("stamps an IdP tenant host", () => {
    expect(tagThreat({ malicious_domain: "acme-sso.okta.com", malicious_url: "https://acme-sso.okta.com/login" }))
      .toEqual({ technique: "idp_tenant_abuse", impersonated_idp: "okta" });
  });
  it("never overwrites a non-family technique", () => {
    expect(tagThreat({ malicious_domain: "acme-okta.com", technique: "clickfix" }))
      .toEqual({ technique: "clickfix", impersonated_idp: null });
  });
  it("keeps an existing device-code technique and refines the idp", () => {
    expect(tagThreat({ malicious_domain: "example.org", technique: "device_code_phishing" }))
      .toEqual({ technique: "device_code_phishing", impersonated_idp: "entra" });
  });
  it("passes through untouched when nothing matches", () => {
    expect(tagThreat({ malicious_domain: "example.org" })).toEqual({ technique: null, impersonated_idp: null });
    expect(tagThreat({ malicious_domain: null, malicious_url: null })).toEqual({ technique: null, impersonated_idp: null });
  });
  it("admits a weak lure only with brand tokens", () => {
    const row = { malicious_domain: "acme-servicedesk.com" };
    expect(tagThreat(row).impersonated_idp).toBeNull();
    expect(needsBrandTokens(row)).toBe(true);
    expect(tagThreat(row, brandTokensFrom("Acme Corp", "acme.com")))
      .toEqual({ technique: "idp_lookalike", impersonated_idp: "generic_sso" });
  });
  it("needsBrandTokens is false for strong lures, plain hosts and set techniques", () => {
    expect(needsBrandTokens({ malicious_domain: "acme-okta.com" })).toBe(false);
    expect(needsBrandTokens({ malicious_domain: "example.org" })).toBe(false);
    expect(needsBrandTokens({ malicious_domain: "acme-helpdesk.com", technique: "clickfix" })).toBe(false);
  });
});

describe("brand attribution on IdP tenant hosts (T3)", () => {
  const BRANDS: BrandRow[] = [
    { id: "b_okta", name: "Okta", canonical_domain: "okta.com", tier: "monitored" },
    { id: "b_acme", name: "Acmecorp", canonical_domain: "acmecorp.com", tier: "monitored" },
  ] as BrandRow[];
  it.each([
    "acmecorp-sso.okta.com",
    "acmecorp.oktapreview.com",
    "acmecorp-admin.okta.com",
    "acmecorp.eu.auth0.com",
    "acmecorp.onelogin.com",
    "openam-acmecorp.forgeblocks.com",
  ])("%s → the tenant brand, not the IdP", (host) => {
    expect(fuzzyMatchBrandDetailed([host], BRANDS)?.brandId).toBe("b_acme");
  });
  it("an unbranded tenant does not credit the IdP vendor", () => {
    expect(fuzzyMatchBrandDetailed(["randomtenant.okta.com"], BRANDS)?.brandId ?? null).not.toBe("b_okta");
  });
});

describe("lookalike triage never dismisses an IdP tenant as an official subdomain (T3)", () => {
  const trustedOkta: OfficialDomainRow = {
    domain: "okta.com", brand_id: "b_okta", brand_name: "Okta", source: "canonical_domain", trusted: 1,
  };
  it("every IdP tenant suffix is shared hosting", () => {
    for (const suffix of Object.keys(IDP_TENANT_HOSTS)) {
      expect(isUnderSharedHosting(`acme.${suffix}`), suffix).toBe(true);
    }
  });
  it("acme-sso.okta.com is not a trusted subdomain of okta.com", () => {
    expect(resolveOfficialDomain("acme-sso.okta.com", [trustedOkta]).trusted).toBeNull();
  });
  it("keeps the alert", () => {
    const d = decideLookalikeRegistrationTriage(
      { lookalike_domain: "acme-sso.okta.com" },
      { officialRows: [trustedOkta], nowMs: Date.parse("2026-10-10T00:00:00Z") },
    );
    expect(d.action).toBe("keep");
  });
  it("the apex itself still matches exactly", () => {
    expect(resolveOfficialDomain("okta.com", [trustedOkta]).trusted?.brand_id).toBe("b_okta");
  });
});

describe("detection widening (T5)", () => {
  const lures = (name: string, tld = "com") => [
    ...IDP_LURE_PREFIXES.map((p) => `${p}${name}.${tld}`),
    ...IDP_LURE_SUFFIXES.map((s) => `${name}${s}.${tld}`),
  ];
  it.each(["acme.com", "paypal.com", "bankofamerica.com", "microsoft.com"])(
    "%s reserves every IdP lure inside the 30-cap",
    (domain) => {
      const perms = generatePermutations(domain);
      expect(perms.length).toBeLessThanOrEqual(30);
      const got = new Set(perms.map((p) => p.domain));
      const name = domain.split(".")[0]!;
      for (const l of lures(name)) expect(got.has(l), l).toBe(true);
      // IDN slots are untouched by the reservation.
      expect(perms.some((p) => p.type === "idn_homoglyph")).toBe(true);
    },
  );
  it("NRD matcher treats okta / vpn / servicedesk as strong lures", () => {
    for (const w of ["okta", "vpn", "servicedesk", "sso", "helpdesk"]) expect(STRONG_WORDS.has(w), w).toBe(true);
  });
});

describe("endpoint params", () => {
  it("parses window", () => {
    expect(parseIdentityWindow(null)).toBe("7d");
    expect(parseIdentityWindow("30d")).toBe("30d");
    expect(parseIdentityWindow("90d")).toBeNull();
    expect(parseIdentityWindow("7")).toBeNull();
  });
  it("clamps backfill limit", () => {
    expect(parseIdpBackfillLimit(null)).toBe(500);
    expect(parseIdpBackfillLimit("abc")).toBe(500);
    expect(parseIdpBackfillLimit("-5")).toBe(500);
    expect(parseIdpBackfillLimit("200")).toBe(200);
    expect(parseIdpBackfillLimit("5000")).toBe(1000);
  });
});

describe("computeIdentityThreats roll-up (T4)", () => {
  type Row = Record<string, unknown>;
  const current: Row[] = [
    { technique: "idp_tenant_abuse", idp: "okta", brand_id: "b1", day: "2026-10-09", status: "active", n: 3 },
    { technique: "idp_lookalike", idp: "generic_sso", brand_id: "b1", day: "2026-10-10", status: "down", n: 2 },
    { technique: "idp_lookalike", idp: "okta", brand_id: "b2", day: "2026-10-10", status: "remediated", n: 1 },
    { technique: "device_code_phishing", idp: null, brand_id: null, day: "2026-10-08", status: "active", n: 4 },
  ];
  const prev: Row[] = [
    { technique: "idp_tenant_abuse", idp: "okta", n: 5 },
    { technique: "oauth_consent_phishing", idp: null, n: 1 },
  ];
  const recent: Row[] = [
    { id: "t1", malicious_domain: null, malicious_url: "https://acme-sso.okta.com/x", target_brand_id: "b1",
      brand_name: "Acme", impersonated_idp: "okta", technique: "idp_tenant_abuse", status: "active",
      created_at: "2026-10-10 09:00:00" },
  ];
  const binds: unknown[][] = [];
  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => {
      binds.push(args);
      return {
        all: async () => ({
          results: sql.includes("FROM brands WHERE id IN")
            ? [{ id: "b1", name: "Acme" }, { id: "b2", name: "Globex" }]
            : sql.includes("LEFT JOIN brands") ? recent
            : sql.includes("created_at < ?") ? prev
            : current,
        }),
        first: async () => ({ n: 9 }),
      };
    },
  });
  const env = { DB: { withSession: () => ({ prepare: stmt }) } } as unknown as Env;

  it("matches the ops contract", async () => {
    const data = await computeIdentityThreats(env, { bookmark: null }, "7d", new Date("2026-10-10T12:00:00Z"));
    expect(data.window).toBe("7d");
    expect(data.kpis).toEqual({
      detections: 10, detections_prev: 6, brands_targeted: 2, idps_impersonated: 3,
      live: 7, taken_down: 3, lookalikes_flagged: 9,
    });
    expect(data.trend).toHaveLength(7);
    expect(data.trend[0]).toEqual({ day: "2026-10-04", count: 0 });
    expect(data.trend[6]).toEqual({ day: "2026-10-10", count: 3 });
    expect(data.by_vector.map((v) => [v.vector, v.count, v.prev])).toEqual([
      ["device_code", 4, 1], ["idp_tenant", 3, 5], ["idp_lookalike", 3, 0],
    ]);
    expect(data.by_idp.find((i) => i.idp === "okta")).toEqual({ idp: "okta", label: "Okta", count: 4, brands: 2, prev: 5 });
    expect(data.by_idp.find((i) => i.idp === "entra")).toMatchObject({ count: 4, prev: 1 });
    expect(data.top_brands[0]).toEqual({ brand_id: "b1", brand_name: "Acme", count: 5, idps: ["Okta", "Generic SSO"] });
    expect(data.recent[0]).toEqual({
      threat_id: "t1", domain: "acme-sso.okta.com", brand_id: "b1", brand_name: "Acme", idp: "Okta",
      vector: "idp_tenant", status: "active", created_at: "2026-10-10T09:00:00Z",
    });
    expect(data.mitre).toHaveLength(IDP_MITRE.length);
    expect(data.mitre.find((m) => m.id === "T1528")?.count).toBe(4);
    expect(data.mitre.find((m) => m.id === "T1566.002")?.count).toBe(10);
    // Window starts at the UTC day 6 days before today; previous window is 7 days earlier.
    expect(binds[0]).toContain("2026-10-04 00:00:00");
    expect(binds[1]).toEqual(expect.arrayContaining(["2026-09-27 00:00:00", "2026-10-04 00:00:00"]));
  });
});
