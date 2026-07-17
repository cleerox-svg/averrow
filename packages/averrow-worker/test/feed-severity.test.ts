/**
 * Unit tests for lib/feed-severity.ts — computeFeedSeverity.
 *
 * This is the single source of truth for feed-risk tiering, consumed by
 * BOTH handleAdminDashboard's at-risk band (Tier-2a) and
 * handleMetricsFeedFailures' per_feed `severity` field. The client-side
 * `feedRiskTier` in FeedFailures.tsx is now a thin consumer of this
 * field. Locking the thresholds here prevents the two backend codepaths
 * from drifting apart.
 */

import { describe, it, expect } from "vitest";
import { computeFeedSeverity, type FeedSeverityInput } from "../src/lib/feed-severity";

function feed(overrides: Partial<FeedSeverityInput>): FeedSeverityInput {
  return {
    enabled: true,
    paused_reason: null,
    pct_to_auto_pause: 0,
    failure_rate_pct: 0,
    pulls: 0,
    ...overrides,
  };
}

describe("computeFeedSeverity", () => {
  it("auto-paused from consecutive failures → critical even when disabled", () => {
    // The "OPERATIONAL while a feed is dead" guard: enabled=0 but the
    // auto-pause reason must still escalate.
    expect(
      computeFeedSeverity(feed({ enabled: false, paused_reason: "auto:consecutive_failures" })),
    ).toBe("critical");
  });

  it("auto-pause reason wins even if it would otherwise be excluded", () => {
    expect(
      computeFeedSeverity(
        feed({ enabled: false, paused_reason: "auto:consecutive_failures", pct_to_auto_pause: 0 }),
      ),
    ).toBe("critical");
  });

  it("manually paused/disabled feed → null (operator intent, not a signal)", () => {
    expect(computeFeedSeverity(feed({ enabled: false, paused_reason: "operator: seasonal" }))).toBeNull();
  });

  it("disabled with no paused_reason → null", () => {
    expect(computeFeedSeverity(feed({ enabled: false, paused_reason: null }))).toBeNull();
  });

  it("orphan (enabled=false, orphan reason) → null", () => {
    expect(
      computeFeedSeverity(feed({ enabled: false, paused_reason: "orphan: no feed_configs row" })),
    ).toBeNull();
  });

  it(">= 80% of the way to auto-pause → critical", () => {
    expect(computeFeedSeverity(feed({ pct_to_auto_pause: 80 }))).toBe("critical");
    expect(computeFeedSeverity(feed({ pct_to_auto_pause: 100 }))).toBe("critical");
  });

  it("60-79% of the way to auto-pause → high", () => {
    expect(computeFeedSeverity(feed({ pct_to_auto_pause: 60 }))).toBe("high");
    expect(computeFeedSeverity(feed({ pct_to_auto_pause: 79 }))).toBe("high");
  });

  it("high failure rate over a meaningful pull sample (>=30%, >=10 pulls) → high", () => {
    expect(computeFeedSeverity(feed({ failure_rate_pct: 30, pulls: 10 }))).toBe("high");
    expect(computeFeedSeverity(feed({ failure_rate_pct: 90, pulls: 20 }))).toBe("high");
  });

  it("high failure rate but tiny pull sample (<10 pulls) → null (not enough signal)", () => {
    expect(computeFeedSeverity(feed({ failure_rate_pct: 90, pulls: 9 }))).toBeNull();
  });

  it("failure rate below 30% → null even with a large sample", () => {
    expect(computeFeedSeverity(feed({ failure_rate_pct: 29, pulls: 100 }))).toBeNull();
  });

  it("healthy feed (enabled, no failures) → null", () => {
    expect(computeFeedSeverity(feed({ enabled: true, pulls: 40 }))).toBeNull();
  });

  it("pct_to_auto_pause takes precedence over failure-rate tier", () => {
    // 80% auto-pause is critical regardless of a merely-high failure rate.
    expect(
      computeFeedSeverity(feed({ pct_to_auto_pause: 80, failure_rate_pct: 40, pulls: 20 })),
    ).toBe("critical");
  });
});
