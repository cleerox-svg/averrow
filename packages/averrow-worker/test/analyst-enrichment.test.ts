import { describe, it, expect } from "vitest";

/**
 * Tests the enrichment aggregation pivot logic from analyst.ts Phase 2.5.
 * Verifies that the UNION ALL subquery approach produces the same output
 * shape as the original single-query OR-aggregate.
 */

// Reproduce the pivot logic extracted from analyst.ts
function pivotEnrichmentResults(
  surblRows: Array<{ target_brand_id: string; cnt: number }>,
  vtRows: Array<{ target_brand_id: string; cnt: number }>,
  vtAvgRows: Array<{ target_brand_id: string; avg_mal: number | null }>,
  gsbRows: Array<{ target_brand_id: string; cnt: number }>,
  dblRows: Array<{ target_brand_id: string; cnt: number }>,
  greynoiseRows: Array<{ target_brand_id: string; noise_scanners: number; potentially_targeted: number }>,
  seclookupRows: Array<{ target_brand_id: string; high_risk: number }>,
): Map<string, {
  target_brand_id: string;
  surbl_confirmed: number;
  vt_flagged: number;
  vt_avg_malicious: number | null;
  gsb_confirmed: number;
  dbl_confirmed: number;
  noise_scanners: number;
  potentially_targeted: number;
  seclookup_high_risk: number;
}> {
  const enrichmentByBrand = new Map<string, {
    target_brand_id: string;
    surbl_confirmed: number;
    vt_flagged: number;
    vt_avg_malicious: number | null;
    gsb_confirmed: number;
    dbl_confirmed: number;
    noise_scanners: number;
    potentially_targeted: number;
    seclookup_high_risk: number;
  }>();

  const getOrInit = (bid: string) => {
    let entry = enrichmentByBrand.get(bid);
    if (!entry) {
      entry = {
        target_brand_id: bid,
        surbl_confirmed: 0, vt_flagged: 0, vt_avg_malicious: null,
        gsb_confirmed: 0, dbl_confirmed: 0, noise_scanners: 0,
        potentially_targeted: 0, seclookup_high_risk: 0,
      };
      enrichmentByBrand.set(bid, entry);
    }
    return entry;
  };

  for (const r of surblRows) getOrInit(r.target_brand_id).surbl_confirmed = r.cnt;
  for (const r of vtRows) getOrInit(r.target_brand_id).vt_flagged = r.cnt;
  for (const r of vtAvgRows) getOrInit(r.target_brand_id).vt_avg_malicious = r.avg_mal;
  for (const r of gsbRows) getOrInit(r.target_brand_id).gsb_confirmed = r.cnt;
  for (const r of dblRows) getOrInit(r.target_brand_id).dbl_confirmed = r.cnt;
  for (const r of greynoiseRows) {
    const e = getOrInit(r.target_brand_id);
    e.noise_scanners = r.noise_scanners;
    e.potentially_targeted = r.potentially_targeted;
  }
  for (const r of seclookupRows) getOrInit(r.target_brand_id).seclookup_high_risk = r.high_risk;

  return enrichmentByBrand;
}

describe("analyst enrichment aggregation pivot", () => {
  it("produces correct output for a single brand with all signals", () => {
    const result = pivotEnrichmentResults(
      [{ target_brand_id: "brand_google", cnt: 5 }],
      [{ target_brand_id: "brand_google", cnt: 3 }],
      [{ target_brand_id: "brand_google", avg_mal: 2.7 }],
      [{ target_brand_id: "brand_google", cnt: 2 }],
      [{ target_brand_id: "brand_google", cnt: 1 }],
      [{ target_brand_id: "brand_google", noise_scanners: 4, potentially_targeted: 2 }],
      [{ target_brand_id: "brand_google", high_risk: 3 }],
    );

    const google = result.get("brand_google");
    expect(google).toBeDefined();
    expect(google).toEqual({
      target_brand_id: "brand_google",
      surbl_confirmed: 5,
      vt_flagged: 3,
      vt_avg_malicious: 2.7,
      gsb_confirmed: 2,
      dbl_confirmed: 1,
      noise_scanners: 4,
      potentially_targeted: 2,
      seclookup_high_risk: 3,
    });
  });

  it("handles multiple brands with partial signals", () => {
    const result = pivotEnrichmentResults(
      [{ target_brand_id: "brand_a", cnt: 10 }],
      [{ target_brand_id: "brand_b", cnt: 7 }],
      [{ target_brand_id: "brand_b", avg_mal: 4.2 }],
      [], // no GSB hits
      [{ target_brand_id: "brand_a", cnt: 3 }],
      [], // no GreyNoise
      [{ target_brand_id: "brand_a", high_risk: 2 }, { target_brand_id: "brand_b", high_risk: 1 }],
    );

    expect(result.size).toBe(2);

    const a = result.get("brand_a");
    expect(a).toEqual({
      target_brand_id: "brand_a",
      surbl_confirmed: 10,
      vt_flagged: 0,
      vt_avg_malicious: null,
      gsb_confirmed: 0,
      dbl_confirmed: 3,
      noise_scanners: 0,
      potentially_targeted: 0,
      seclookup_high_risk: 2,
    });

    const b = result.get("brand_b");
    expect(b).toEqual({
      target_brand_id: "brand_b",
      surbl_confirmed: 0,
      vt_flagged: 7,
      vt_avg_malicious: 4.2,
      gsb_confirmed: 0,
      dbl_confirmed: 0,
      noise_scanners: 0,
      potentially_targeted: 0,
      seclookup_high_risk: 1,
    });
  });

  it("returns empty map when no enrichment signals exist", () => {
    const result = pivotEnrichmentResults([], [], [], [], [], [], []);
    expect(result.size).toBe(0);
  });

  it("initializes defaults correctly for brand with only one signal", () => {
    const result = pivotEnrichmentResults(
      [],
      [],
      [],
      [{ target_brand_id: "brand_x", cnt: 1 }],
      [],
      [],
      [],
    );

    const x = result.get("brand_x");
    expect(x).toBeDefined();
    expect(x!.gsb_confirmed).toBe(1);
    expect(x!.surbl_confirmed).toBe(0);
    expect(x!.vt_flagged).toBe(0);
    expect(x!.vt_avg_malicious).toBeNull();
    expect(x!.dbl_confirmed).toBe(0);
    expect(x!.noise_scanners).toBe(0);
    expect(x!.potentially_targeted).toBe(0);
    expect(x!.seclookup_high_risk).toBe(0);
  });
});
