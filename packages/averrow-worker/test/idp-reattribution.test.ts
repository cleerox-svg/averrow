import { describe, it, expect } from "vitest";
import {
  decideReattribution,
  handleIdpReattribution,
  type ReattributionRow,
} from "../src/handlers/admin/idpReattribution";
import { fuzzyMatchBrandDetailed, type BrandRow } from "../src/lib/brandDetect";
import type { Env } from "../src/types";

const CATALOG: BrandRow[] = [
  { id: "b_okta", name: "Okta", canonical_domain: "okta.com", tier: "monitored" },
  { id: "b_ms", name: "Microsoft", canonical_domain: "microsoft.com", tier: "monitored" },
  { id: "b_persona", name: "Persona", canonical_domain: "withpersona.com", tier: "monitored" },
  { id: "b_acme", name: "Acme", canonical_domain: "acme.com", tier: "monitored" },
];
const rematch = (h: string[]) => fuzzyMatchBrandDetailed(h, CATALOG);

const row = (domain: string, over: Partial<ReattributionRow> = {}): ReattributionRow => ({
  rid: 1, id: `t_${domain}`, malicious_domain: domain, malicious_url: null, ioc_value: null,
  source_feed: "phishtank", target_brand_id: "b_okta", brand_match_method: "token",
  brand_name: "Okta", brand_canonical: "okta.com", brand_tier: "monitored", ...over,
});

describe("decideReattribution", () => {
  it("relinks an Okta-credited lure lookalike to the targeted brand", () => {
    expect(decideReattribution(row("withpersona.okta-linksso.com"), rematch))
      .toEqual({ action: "relink", newBrandId: "b_persona", method: "token" });
    expect(decideReattribution(row("okta-acme.com"), rematch))
      .toEqual({ action: "relink", newBrandId: "b_acme", method: "token" });
  });

  it("relinks an Okta-credited tenant host to the tenant brand", () => {
    expect(decideReattribution(row("acme-sso.okta.com"), rematch).newBrandId).toBe("b_acme");
  });

  it("keeps the vendor credit on a vendor-only lure", () => {
    expect(decideReattribution(row("okta-login-secure.com"), rematch))
      .toMatchObject({ action: "keep", keptBecause: "still_matches" });
  });

  it("clears when the target brand is unknown", () => {
    expect(decideReattribution(row("contosoltd.okta-linksso.com"), rematch))
      .toEqual({ action: "clear", newBrandId: null, method: null });
  });

  it("leaves links the lure-token rule did not make", () => {
    // Microsoft credit on a host without "microsoft" (AI / page-context link).
    expect(decideReattribution(row("acme-adfs.com", {
      target_brand_id: "b_ms", brand_name: "Microsoft", brand_canonical: "microsoft.com",
    }), rematch)).toMatchObject({ action: "keep", keptBecause: "not_lure_credit" });
    expect(decideReattribution(row("okta-acme.com", { source_feed: "typosquat_scanner" }), rematch))
      .toMatchObject({ action: "keep", keptBecause: "protected_feed" });
  });
});

describe("handleIdpReattribution request guards", () => {
  const env = {} as Env;
  it("apply without the confirm token is a 400 (no DB access)", async () => {
    const res = await handleIdpReattribution(new URL("https://x/api/internal/backfills/idp-reattribution?apply=1"), env);
    expect(res.status).toBe(400);
  });
  it("rejects a malformed run_id", async () => {
    const res = await handleIdpReattribution(new URL("https://x/?run_id=bad%20id"), env);
    expect(res.status).toBe(400);
  });
});
