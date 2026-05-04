/**
 * Cadence-stallThreshold contract for weekly agents.
 *
 * FC's recovery sweeper re-dispatches any agent whose lastRunAge
 * exceeds stallThresholdMinutes (flightControl.ts line 159:
 * "Choose ≈ intended interval × 1.2"). For agents on a weekly
 * orchestrator gate, that means stallThresholdMinutes MUST exceed
 * 7 days × 1.2 = 12,096 min. Anything tighter causes FC to fire
 * the agent every few hours despite its cron-gate intent.
 *
 * Production evidence (2026-05-04): geoip_refresh shipped with
 * stallThresholdMinutes=240 (4h). FC re-fired it every 5h all
 * week long. Each dispatch hit the MaxMind sha256 probe and the
 * download workflow, exhausting the free-tier daily quota and
 * triggering an account-lockout email. Once 240 → 12100 the
 * dispatch cadence matched the weekly intent.
 *
 * This test protects both currently-weekly agents (auto_seeder
 * and geoip_refresh) — and any future weekly agent that imports
 * the WEEKLY_MIN_STALL_THRESHOLD_MINUTES constant.
 */

import { describe, it, expect } from "vitest";
import { autoSeederAgent } from "../src/agents/auto-seeder";
import { geoipRefreshAgent } from "../src/agents/geoip-refresh";

// 7 days × 1.2 = 12,096 minutes. Anything ≥ this value gives FC
// at least one weekly cycle of slack before flagging "stalled".
const WEEKLY_MIN_STALL_THRESHOLD_MINUTES = 7 * 24 * 60 * 1.2;

describe("weekly-agent stallThresholdMinutes", () => {
  it("auto_seeder honors the weekly cadence", () => {
    expect(autoSeederAgent.stallThresholdMinutes).toBeGreaterThanOrEqual(
      WEEKLY_MIN_STALL_THRESHOLD_MINUTES,
    );
  });

  it("geoip_refresh honors the weekly cadence", () => {
    expect(geoipRefreshAgent.stallThresholdMinutes).toBeGreaterThanOrEqual(
      WEEKLY_MIN_STALL_THRESHOLD_MINUTES,
    );
  });

  // Belt-and-suspenders: pin both to the same value so future tweaks
  // to one have to land a deliberate decision about the other.
  it("auto_seeder and geoip_refresh use identical thresholds (both Sunday-only weekly)", () => {
    expect(geoipRefreshAgent.stallThresholdMinutes).toBe(
      autoSeederAgent.stallThresholdMinutes,
    );
  });
});
