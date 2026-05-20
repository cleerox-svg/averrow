/**
 * Tests for the Phase 2 D1-write-budget review reminder (PR-BK).
 *
 * Covers the pure template renderer + the projection math added to
 * BillingCycleMetrics. The FC date-gated emit logic is exercised at
 * the integration level; the bug surface here is the rendered
 * message + the projection arithmetic.
 */

import { describe, it, expect } from "vitest";
import { renderPlatformD1WritesPhase2Review } from "../src/lib/platform-templates";
import { WRITES_INCLUDED_QUOTA } from "../src/lib/d1-budget";

describe("renderPlatformD1WritesPhase2Review", () => {
  it("surfaces the projection in the title in millions", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    expect(r.title).toContain("78.4M/mo projected");
  });

  it("computes overage dollars at $1/M above the 50M quota", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    // 78.4M - 50M = 28.4M overage at $1/M = $28.40
    expect(r.message).toContain("$28.4/mo overage");
  });

  it("shows $0 overage when projection equals the quota (boundary)", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 50_000_000,
      pct_of_50m_write_quota: 100,
      rows_written_cycle: 16_666_666,
      cycle_pct_elapsed: 33,
    });
    expect(r.message).toContain("$0/mo overage");
  });

  it("clamps overage at zero when projection is below quota — but the FC gate normally prevents this template from firing in that case", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 45_000_000,
      pct_of_50m_write_quota: 90,
      rows_written_cycle: 15_000_000,
      cycle_pct_elapsed: 33,
    });
    expect(r.message).toContain("$0/mo overage");
  });

  it("emits at medium severity to super_admin audience", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    expect(r.severity).toBe("medium");
    expect(r.audience).toBe("super_admin");
  });

  it("uses today's date in the group_key so dedup is per-day", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    expect(r.group_key).toMatch(/^platform_d1_writes_phase2_review:\d{4}-\d{2}-\d{2}$/);
  });

  it("includes the cycle elapsed percentage so the operator can weigh projection confidence", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    expect(r.message).toContain("32% elapsed");
  });

  it("recommends running platform-diagnostics with the 168h window for fresh signal", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    expect(r.recommended_action).toContain("platform-diagnostics.sh 168");
  });

  it("references the PR-1406 Phase 2 candidate list in recommended_action", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    expect(r.recommended_action).toMatch(/PR #1406|cube state|telemetry/i);
  });

  it("documents self-disable behavior so the operator knows it'll stop on its own", () => {
    const r = renderPlatformD1WritesPhase2Review({
      cycle_projection_rows_written: 78_400_000,
      pct_of_50m_write_quota: 156.8,
      rows_written_cycle: 25_000_000,
      cycle_pct_elapsed: 32,
    });
    expect(r.recommended_action).toMatch(/self-disable|self-disables/);
  });
});

describe("WRITES_INCLUDED_QUOTA constant", () => {
  it("equals 50M — the Workers Paid plan included write quota", () => {
    // Anchored as a constant so a future plan change (or accidental
    // edit) becomes a deliberate test update rather than a silent
    // accounting drift on the reminder.
    expect(WRITES_INCLUDED_QUOTA).toBe(50_000_000);
  });
});
