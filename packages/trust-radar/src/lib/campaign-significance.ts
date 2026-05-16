/**
 * Campaign significance rule — when is a threat campaign "worth pinging
 * the operator and the impacted tenants about"?
 *
 * NX4 (RESTRUCTURE_SPEC.md § NOTIFICATIONS RESTRUCTURE). Single pure
 * function so the thresholds live in one place and can be unit-tested
 * without spinning up the strategist agent. Callers in
 * agents/strategist.ts gate `intel_campaign_emerging` notifications +
 * `createBrandAlertsForCampaign` fan-out on this rule.
 *
 * The three branches (any one is sufficient):
 *
 *   1. Volume threshold     — total threat_count ≥ 20
 *   2. Sudden spike         — threat_count is ≥3× the count 24h ago
 *                             AND the absolute delta is ≥ 8 threats
 *   3. Wide net at discovery — campaign already touches ≥ 10 distinct
 *                              brands at first detection
 *
 * Branches are independent. A campaign with 25 threats targeting 2
 * brands is significant (branch 1). A campaign with 9 threats today
 * vs 1 yesterday is significant (branch 2 — 9 ≥ 3×1 and delta=8).
 * A campaign with 12 threats across 11 brands is significant
 * (branch 3).
 *
 * Thresholds are exported so the diagnostics endpoint + operator UI
 * can show them. Future tuning happens here, not at call sites.
 */

export const CAMPAIGN_SIGNIFICANCE_TOTAL_THREATS = 20;
export const CAMPAIGN_SIGNIFICANCE_SPIKE_MULTIPLIER = 3;
export const CAMPAIGN_SIGNIFICANCE_SPIKE_MIN_DELTA = 8;
export const CAMPAIGN_SIGNIFICANCE_BRAND_COUNT_AT_FIRST = 10;

export interface CampaignSignificanceInput {
  /** Current count of threats linked to this campaign. */
  threat_count: number;
  /** Count of threats linked to this campaign as of 24 hours ago.
   *  Pass 0 at first-detection time (no "before" state). For ongoing
   *  campaigns, query: `SELECT COUNT(*) FROM threats WHERE campaign_id=?
   *  AND created_at < datetime('now','-24 hours')`. */
  threat_count_24h_ago: number;
  /** Distinct brand_id count among the threats that triggered the
   *  campaign's creation. Stored in `campaigns.brand_count_at_first_detection`
   *  (migration 0192). For ongoing campaigns the row's stored value is
   *  the source of truth — do not recompute. */
  brand_count_at_first_detection: number;
}

export type CampaignSignificanceReason =
  | 'volume_threshold'
  | 'sudden_spike'
  | 'wide_net_at_first_detection';

export interface CampaignSignificanceResult {
  significant: boolean;
  reasons: CampaignSignificanceReason[];
}

export function evaluateCampaignSignificance(input: CampaignSignificanceInput): CampaignSignificanceResult {
  const reasons: CampaignSignificanceReason[] = [];

  if (input.threat_count >= CAMPAIGN_SIGNIFICANCE_TOTAL_THREATS) {
    reasons.push('volume_threshold');
  }

  if (
    input.threat_count_24h_ago > 0 &&
    input.threat_count >= CAMPAIGN_SIGNIFICANCE_SPIKE_MULTIPLIER * input.threat_count_24h_ago &&
    input.threat_count - input.threat_count_24h_ago >= CAMPAIGN_SIGNIFICANCE_SPIKE_MIN_DELTA
  ) {
    reasons.push('sudden_spike');
  }

  if (input.brand_count_at_first_detection >= CAMPAIGN_SIGNIFICANCE_BRAND_COUNT_AT_FIRST) {
    reasons.push('wide_net_at_first_detection');
  }

  return { significant: reasons.length > 0, reasons };
}

/** Convenience boolean for callers that don't care about the reason set. */
export function isCampaignSignificant(input: CampaignSignificanceInput): boolean {
  return evaluateCampaignSignificance(input).significant;
}
