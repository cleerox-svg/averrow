/**
 * `pageScoreBand` (handlers/diagnostics.ts) — the counterfactual band
 * model behind `page_analysis.ai_build.escalations_attributable`.
 *
 * Spec §6 names `escalations_attributable` as THE gate deciding whether
 * Lane 3's Class A signals are promoted out of shadow mode or demoted to
 * metadata-only. Passing that gate on phantom escalations is the worst
 * failure available to this lane, so the band model must be an exact
 * mirror of the real escalation function rather than an approximation
 * of it.
 *
 * The shipped model was NOT exact: it modelled only `>= 60` and `>= 30`
 * and omitted `credentialHarvest → CRITICAL` and the bare-anti-bot-wall
 * `→ MEDIUM` floor. Anti-bot walls are the most common finding on this
 * population, so a page already floored to MEDIUM by a bare wall was
 * counted as a Class A escalation Class A did not cause — and that class
 * of row can dominate the metric.
 *
 * These tests pin the mirror DIRECTLY against
 * `escalateThreatLevelForPage`, so the two cannot drift silently.
 */

import { describe, it, expect } from "vitest";
import { pageScoreBand } from "../src/handlers/diagnostics";
import {
  escalateThreatLevelForPage,
  type PageThreatLevel,
} from "../src/lib/page-phishing-scorer";

const ORDER: Record<PageThreatLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** The band the REAL escalation function lands on, from a LOW base. */
function realBand(score: number, credentialHarvest: boolean, antiBotWall: boolean): number {
  return ORDER[escalateThreatLevelForPage("LOW", { score, credentialHarvest, antiBotWall })];
}

describe("pageScoreBand mirrors escalateThreatLevelForPage exactly", () => {
  const scores = [0, 10, 20, 29, 30, 37, 45, 59, 60, 75, 100, 120];

  it.each(scores)("score %i — all four (credentialHarvest × antiBotWall) combinations agree", (score) => {
    for (const credentialHarvest of [false, true]) {
      for (const antiBotWall of [false, true]) {
        expect(pageScoreBand(score, credentialHarvest, antiBotWall)).toBe(
          realBand(score, credentialHarvest, antiBotWall),
        );
      }
    }
  });

  it("models the credentialHarvest → CRITICAL branch the old two-branch model omitted", () => {
    expect(pageScoreBand(0, true, false)).toBe(3);
    expect(pageScoreBand(100, true, true)).toBe(3);
  });

  it("models the bare-anti-bot-wall → MEDIUM floor the old two-branch model omitted", () => {
    // anti_bot_wall alone is worth 20 — below the >= 30 branch, so only
    // the floor puts it at MEDIUM.
    expect(pageScoreBand(20, false, true)).toBe(1);
    expect(pageScoreBand(20, false, false)).toBe(0);
  });
});

describe("escalations_attributable is not inflated by pre-existing floors", () => {
  /** Restatement of the aggregator's per-row decision. */
  function attributable(
    base: number,
    classBCSum: number,
    delta: number,
    credentialHarvest: boolean,
    antiBotWall: boolean,
  ): boolean {
    const withAll = pageScoreBand(base + delta, credentialHarvest, antiBotWall);
    const withoutA = pageScoreBand(base + classBCSum, credentialHarvest, antiBotWall);
    return withAll > withoutA;
  }

  it("a page ALREADY at MEDIUM via the bare-wall floor is not credited to Class A", () => {
    // base 20 (anti_bot_wall only), Class A contributes its full cap 20,
    // Class B/C nothing. Old model: band(20)=0 → band(40)=1, counted.
    // Correct model: the wall floor already put it at MEDIUM, and
    // 20 + 20 = 40 is still MEDIUM — no escalation at all.
    expect(attributable(20, 0, 20, false, true)).toBe(false);
  });

  it("a page ALREADY at CRITICAL via credential harvest is not credited to Class A", () => {
    expect(attributable(75, 0, 20, true, false)).toBe(false);
  });

  it("a genuine Class A band lift IS still counted", () => {
    // base 45, Class B/C 0, Class A cap 20 → 65 crosses into HIGH.
    expect(attributable(45, 0, 20, false, false)).toBe(true);
  });

  it("a lift that Class B/C would have produced ANYWAY is not credited to Class A", () => {
    // base 45, Class B/C 20 (covert_exfil_sink) already reaches HIGH;
    // adding Class A's cap changes nothing about the band.
    expect(attributable(45, 20, 40, false, false)).toBe(false);
  });
});
