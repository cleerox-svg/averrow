// Shared feed-risk severity tiering.
//
// Single source of truth for mapping a feed-failures `per_feed` row to a
// coarse risk tier. Both the admin dashboard's "feeds needing attention"
// band (handleAdminDashboard) and the Feeds-tab metrics endpoint
// (handleMetricsFeedFailures) consume this so the two surfaces can never
// drift. The client-side `feedRiskTier` in FeedFailures.tsx is a thin
// consumer of the `severity` field the metrics endpoint now stamps from
// this helper — it no longer recomputes the tiers.
//
// Tier rules (order matters — first match wins):
//   - auto-paused from consecutive failures  → 'critical' (a dead feed is a
//     signal even though enabled=0)
//   - manually paused / disabled / orphaned  → null (operator intent, not a
//     signal; excluded from the at-risk view)
//   - >= 80% of the way to auto-pause        → 'critical'
//   - 60-79% of the way to auto-pause        → 'high'
//   - high failure rate on a meaningful pull
//     sample (>= 30% over >= 10 pulls)       → 'high'
//   - otherwise                              → null

export type FeedSeverity = "critical" | "high";

export interface FeedSeverityInput {
  enabled: boolean;
  paused_reason: string | null;
  pct_to_auto_pause: number;
  failure_rate_pct: number;
  pulls: number;
}

export function computeFeedSeverity(f: FeedSeverityInput): FeedSeverity | null {
  if (f.paused_reason === "auto:consecutive_failures") return "critical";
  if (!f.enabled || f.paused_reason) return null;
  if (f.pct_to_auto_pause >= 80) return "critical";
  if (f.pct_to_auto_pause >= 60) return "high";
  if (f.failure_rate_pct >= 30 && f.pulls >= 10) return "high";
  return null;
}
