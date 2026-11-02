// Averrow — per-brand external-validation aggregates for Analyst Phase 3.5.
//
// D1 read-spend (2026-11): Analyst used to compute these seven signals for
// EVERY brand — seven `GROUP BY target_brand_id` scans over all active,
// brand-linked threats (~314K rows read each) behind one 3h cachedValue —
// and then read the result for at most five brands (the
// `matchedBrandIds.slice(0, 5)` loop that writes the "External Validation"
// insights). In prod the shared entry still missed 44–52×/day (~44M
// reads/day): the payload is a whole-catalog snapshot, so every miss paid
// the full fan-out no matter how few brands the run needed.
//
// Now: one statement per brand the run actually reports on, seeking
// idx_threats_brand_status (target_brand_id, status) and computing all seven
// signals in a single pass over that brand's active threats (conditional
// aggregates — the vt count and vt average share one pass). Each brand's
// result is cached for 3h under its own key, so a brand that recurs across
// hourly runs (the big, frequently-targeted ones) is read once per 3h.
// The values equal the old per-signal queries' (pinned by
// test/d1-read-spend-analyst-email.test.ts on a seeded SQLite).

import type { Env } from '../types';
import { cachedValue } from './cached-value';

export interface BrandEnrichment {
  target_brand_id: string;
  surbl_confirmed: number;
  vt_flagged: number;
  vt_avg_malicious: number | null;
  gsb_confirmed: number;
  dbl_confirmed: number;
  noise_scanners: number;
  potentially_targeted: number;
  seclookup_high_risk: number;
}

/** 3h — same staleness budget the old catalog-wide entry had. */
export const BRAND_ENRICHMENT_TTL_S = 10800;
export const brandEnrichmentCacheKey = (brandId: string): string => `analyst.enrichment_brand.${brandId}`;

/**
 * Single-brand, single-pass form of the old seven per-signal queries. Each
 * old query's own filter becomes the CASE condition; `vt_avg_malicious`
 * averages only vt_malicious > 0 rows (AVG ignores the NULL branch) exactly
 * like the old `... AND vt_malicious > 0` AVG. Returns no row when the brand
 * has no active threats.
 */
export const BRAND_ENRICHMENT_SQL = `
  SELECT target_brand_id,
    SUM(CASE WHEN surbl_listed = 1 THEN 1 ELSE 0 END) AS surbl_confirmed,
    SUM(CASE WHEN vt_malicious > 0 THEN 1 ELSE 0 END) AS vt_flagged,
    ROUND(AVG(CASE WHEN vt_malicious > 0 THEN vt_malicious END), 1) AS vt_avg_malicious,
    SUM(CASE WHEN gsb_flagged = 1 THEN 1 ELSE 0 END) AS gsb_confirmed,
    SUM(CASE WHEN dbl_listed = 1 THEN 1 ELSE 0 END) AS dbl_confirmed,
    SUM(CASE WHEN greynoise_checked = 1 AND greynoise_noise = 1 AND greynoise_classification = 'benign' THEN 1 ELSE 0 END) AS noise_scanners,
    SUM(CASE WHEN greynoise_checked = 1 AND greynoise_noise = 0 THEN 1 ELSE 0 END) AS potentially_targeted,
    SUM(CASE WHEN seclookup_checked = 1 AND seclookup_risk_score >= 80 THEN 1 ELSE 0 END) AS seclookup_high_risk
  FROM threats
  WHERE target_brand_id = ? AND status = 'active'
  GROUP BY target_brand_id
`;

/**
 * Enrichment aggregates for exactly `brandIds` (deduped). Brands with no
 * active threats are absent from the map — the same "no entry" outcome the
 * old pivot produced for them.
 */
export async function loadBrandEnrichment(
  env: Env,
  brandIds: readonly string[],
): Promise<Map<string, BrandEnrichment>> {
  const unique = [...new Set(brandIds)];
  const rows = await Promise.all(unique.map((bid) =>
    cachedValue<BrandEnrichment | null>(env, brandEnrichmentCacheKey(bid), BRAND_ENRICHMENT_TTL_S, () =>
      env.DB.prepare(BRAND_ENRICHMENT_SQL).bind(bid).first<BrandEnrichment>())));
  const out = new Map<string, BrandEnrichment>();
  for (const r of rows) if (r) out.set(r.target_brand_id, r);
  return out;
}
