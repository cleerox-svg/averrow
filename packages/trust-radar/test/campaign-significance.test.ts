import { describe, it, expect } from "vitest";
import {
  evaluateCampaignSignificance,
  isCampaignSignificant,
  CAMPAIGN_SIGNIFICANCE_TOTAL_THREATS,
  CAMPAIGN_SIGNIFICANCE_SPIKE_MULTIPLIER,
  CAMPAIGN_SIGNIFICANCE_SPIKE_MIN_DELTA,
  CAMPAIGN_SIGNIFICANCE_BRAND_COUNT_AT_FIRST,
} from "../src/lib/campaign-significance";

const baseline = {
  threat_count: 0,
  threat_count_24h_ago: 0,
  brand_count_at_first_detection: 0,
};

describe("campaign-significance", () => {
  describe("volume_threshold branch", () => {
    it("fires when threat_count meets the threshold exactly", () => {
      const r = evaluateCampaignSignificance({ ...baseline, threat_count: CAMPAIGN_SIGNIFICANCE_TOTAL_THREATS });
      expect(r.significant).toBe(true);
      expect(r.reasons).toContain("volume_threshold");
    });

    it("does not fire one below threshold", () => {
      const r = evaluateCampaignSignificance({ ...baseline, threat_count: CAMPAIGN_SIGNIFICANCE_TOTAL_THREATS - 1 });
      expect(r.significant).toBe(false);
    });
  });

  describe("sudden_spike branch", () => {
    it("fires when count is 3x and delta >= 8", () => {
      // 24h ago=4, now=12 -> 12 = 3*4, delta = 8
      const r = evaluateCampaignSignificance({
        ...baseline,
        threat_count: 12,
        threat_count_24h_ago: 4,
      });
      expect(r.significant).toBe(true);
      expect(r.reasons).toContain("sudden_spike");
    });

    it("does not fire when delta is below 8 even if multiplier is met", () => {
      // 24h ago=2, now=6 -> 6 = 3*2 but delta=4 (below 8)
      const r = evaluateCampaignSignificance({
        ...baseline,
        threat_count: 6,
        threat_count_24h_ago: 2,
      });
      expect(r.significant).toBe(false);
    });

    it("does not fire when multiplier is below 3 even if delta is large", () => {
      // 24h ago=20, now=39 -> delta=19 but multiplier=1.95
      const r = evaluateCampaignSignificance({
        ...baseline,
        threat_count: 39,
        threat_count_24h_ago: 20,
      });
      // volume_threshold fires (39 >= 20) but NOT sudden_spike
      expect(r.reasons).toContain("volume_threshold");
      expect(r.reasons).not.toContain("sudden_spike");
    });

    it("does not fire when 24h_ago is 0 (no baseline to compare)", () => {
      const r = evaluateCampaignSignificance({
        ...baseline,
        threat_count: 100,
        threat_count_24h_ago: 0,
      });
      // volume_threshold fires; sudden_spike must not (zero baseline)
      expect(r.reasons).not.toContain("sudden_spike");
    });
  });

  describe("wide_net_at_first_detection branch", () => {
    it("fires when brand count meets the threshold exactly", () => {
      const r = evaluateCampaignSignificance({
        ...baseline,
        brand_count_at_first_detection: CAMPAIGN_SIGNIFICANCE_BRAND_COUNT_AT_FIRST,
      });
      expect(r.significant).toBe(true);
      expect(r.reasons).toContain("wide_net_at_first_detection");
    });

    it("does not fire one below threshold", () => {
      const r = evaluateCampaignSignificance({
        ...baseline,
        brand_count_at_first_detection: CAMPAIGN_SIGNIFICANCE_BRAND_COUNT_AT_FIRST - 1,
      });
      expect(r.significant).toBe(false);
    });
  });

  describe("multiple branches", () => {
    it("reports every branch that fires", () => {
      // 25 threats (volume), 24h_ago=5 -> 25=5x with delta=20 (spike),
      // 12 brands (wide net) — all three should fire.
      const r = evaluateCampaignSignificance({
        threat_count: 25,
        threat_count_24h_ago: 5,
        brand_count_at_first_detection: 12,
      });
      expect(r.significant).toBe(true);
      expect(r.reasons).toContain("volume_threshold");
      expect(r.reasons).toContain("sudden_spike");
      expect(r.reasons).toContain("wide_net_at_first_detection");
    });
  });

  describe("convenience helper", () => {
    it("isCampaignSignificant mirrors evaluateCampaignSignificance().significant", () => {
      expect(isCampaignSignificant({ ...baseline, threat_count: 100 })).toBe(true);
      expect(isCampaignSignificant({ ...baseline, threat_count: 1 })).toBe(false);
    });
  });

  describe("threshold constants", () => {
    it("exposes the four thresholds for diagnostics + UI", () => {
      expect(CAMPAIGN_SIGNIFICANCE_TOTAL_THREATS).toBe(20);
      expect(CAMPAIGN_SIGNIFICANCE_SPIKE_MULTIPLIER).toBe(3);
      expect(CAMPAIGN_SIGNIFICANCE_SPIKE_MIN_DELTA).toBe(8);
      expect(CAMPAIGN_SIGNIFICANCE_BRAND_COUNT_AT_FIRST).toBe(10);
    });
  });
});
