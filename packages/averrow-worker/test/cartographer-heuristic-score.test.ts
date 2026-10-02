/**
 * Cartographer provider reputation after AI_STRATEGY_2026-10 Phase 1
 * (Batch B): `computeHeuristicScore` is the sole score, and an `insight`
 * row is emitted only on a meaningful change (`shouldEmitProviderInsight`).
 */
import { describe, it, expect } from "vitest";
import {
  computeHeuristicScore, shouldEmitProviderInsight, topThreatTypes, renderProviderInsightSummary,
  type ProviderHeuristicInput,
} from "../src/agents/cartographer";

const base: ProviderHeuristicInput = {
  activeThreats: 0, totalThreats: 0, avgResponseTime: null, campaignCount: 0, trend7d: 0, trend30d: 0,
};
const score = (over: Partial<ProviderHeuristicInput>) => computeHeuristicScore({ ...base, ...over });

describe("computeHeuristicScore", () => {
  it.each([
    // [label, input, score, risk factors]
    ["clean provider", {}, 100, []],
    ["1 active", { activeThreats: 1 }, 90, ["active_threats_present"]],
    ["11 active", { activeThreats: 11 }, 80, ["active_threats_over_10"]],
    ["51 active", { activeThreats: 51 }, 70, ["active_threats_over_50"]],
    ["101 active", { activeThreats: 101 }, 60, ["active_threats_over_100"]],
    ["boundary: exactly 10 active is the >0 band", { activeThreats: 10 }, 90, ["active_threats_present"]],
    ["101 total", { totalThreats: 101 }, 90, ["total_volume_over_100"]],
    ["1001 total", { totalThreats: 1001 }, 85, ["total_volume_over_1000"]],
    ["slow response > 1d", { avgResponseTime: 25 }, 90, ["slow_takedown_response_over_1d"]],
    ["slow response > 3d", { avgResponseTime: 73 }, 85, ["slow_takedown_response_over_3d"]],
    ["slow response > 1w", { avgResponseTime: 169 }, 80, ["slow_takedown_response_over_1w"]],
    ["fast response is no penalty", { avgResponseTime: 2 }, 100, []],
  ] as const)("%s", (_label, over, expected, factors) => {
    const r = score(over);
    expect(r.score).toBe(expected);
    expect(r.riskFactors).toEqual(factors);
  });

  describe("repeat-offender penalty (−15 at >= 3 campaigns)", () => {
    it.each([[2, 100, false], [3, 85, true], [9, 85, true]] as const)("%i campaigns → %i", (campaignCount, expected, repeat) => {
      const r = score({ campaignCount });
      expect(r.score).toBe(expected);
      expect(r.repeatOffender).toBe(repeat);
      expect(r.riskFactors.includes("repeat_offender")).toBe(repeat);
    });
  });

  describe("7-day surge penalty (−10 when trend_7d >= 10 AND trend_7d × 30/7 > 1.5 × trend_30d)", () => {
    it.each([
      // trend7d, trend30d, fires?
      [10, 0, true],     // 42.9 > 0
      [10, 28, true],    // 42.86 > 42
      [10, 29, false],   // 42.86 < 43.5
      [9, 0, false],     // under the absolute floor
      [70, 200, false],  // 300 == 300, not strictly greater
      [71, 200, true],   // 304.3 > 300
      [100, 1000, false],
    ] as const)("trend_7d=%i trend_30d=%i → fires=%s", (trend7d, trend30d, fires) => {
      const r = score({ trend7d, trend30d });
      expect(r.score).toBe(fires ? 90 : 100);
      expect(r.riskFactors.includes("surge_7d")).toBe(fires);
    });

    it("null trends never fire", () => {
      expect(score({ trend7d: null, trend30d: null }).riskFactors).not.toContain("surge_7d");
    });
  });

  it("stacks every penalty and clamps at 0", () => {
    const r = score({ activeThreats: 500, totalThreats: 5000, avgResponseTime: 500, campaignCount: 5, trend7d: 50, trend30d: 10 });
    // 100 − 40 − 20 − 15 − 15 − 10 = 0
    expect(r.score).toBe(0);
    expect(r.riskFactors).toEqual([
      "active_threats_over_100", "slow_takedown_response_over_1w", "total_volume_over_1000", "repeat_offender", "surge_7d",
    ]);
  });

  it("a typical bad provider", () => {
    // 100 − 30 (51-100 active) − 10 (101-1000 total) − 15 (repeat) − 10 (surge) = 35
    const r = score({ activeThreats: 60, totalThreats: 400, campaignCount: 4, trend7d: 30, trend30d: 40 });
    expect(r.score).toBe(35);
  });
});

describe("shouldEmitProviderInsight", () => {
  it.each([
    // score, lastScore, repeatOffender, emit?, why
    [65, null, false, true, "first score ever, bad"],
    [85, null, false, false, "first score ever, good and not repeat"],
    [85, null, true, true, "first score ever, repeat offender"],
    [65, 66, false, false, "bad but stable (delta 1, no crossing)"],
    [55, 65, false, true, "bad and moved 10"],
    [56, 65, false, false, "bad and moved 9"],
    [69, 70, false, true, "crossed 70 downward (delta 1)"],
    [70, 69, true, true, "repeat offender crossed 70 upward"],
    [70, 69, false, false, "good now and not repeat — not reportable at all"],
    [80, 80, true, false, "repeat offender, stable"],
    [95, 80, true, true, "repeat offender, moved 15"],
    [0, 0, false, false, "worst score, unchanged"],
  ] as const)("score=%i last=%s repeat=%s → %s (%s)", (s, last, repeat, expected) => {
    expect(shouldEmitProviderInsight(s, last, repeat)).toBe(expected);
  });
});

describe("insight summary template", () => {
  it("top types are by count desc, alphabetical on ties, capped at 3", () => {
    expect(topThreatTypes({ phishing: 5, c2: 9, malware_distribution: 5, scanning: 1 }, 3))
      .toEqual(["c2", "malware_distribution", "phishing"]);
    expect(topThreatTypes({}, 3)).toEqual([]);
    expect(topThreatTypes({ phishing: 0 }, 3)).toEqual([]);
  });

  it("renders the documented shape", () => {
    expect(renderProviderInsightSummary({
      name: "AS666 BadHost", score: 35, repeatOffender: true, activeThreats: 60, totalThreats: 400,
      topTypes: ["phishing", "c2"], campaignCount: 4,
    })).toBe("AS666 BadHost: reputation 35/100 [REPEAT OFFENDER] — 60 active / 400 total; top types: phishing, c2; 4 campaigns");

    expect(renderProviderInsightSummary({
      name: "Quiet", score: 60, repeatOffender: false, activeThreats: 12, totalThreats: 12,
      topTypes: [], campaignCount: 0,
    })).toBe("Quiet: reputation 60/100 — 12 active / 12 total; top types: none; 0 campaigns");
  });
});
