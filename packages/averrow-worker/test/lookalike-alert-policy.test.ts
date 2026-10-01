/**
 * The shared lookalike alert policy — the floor, the phishing bar, and
 * the invariant that both producers use the SHARED definition rather
 * than each keeping a copy.
 *
 * That last one is the point of the file. A severity floor written twice
 * drifts, and drift here is silent: one producer keeps filing MEDIUMs
 * and nobody notices until the alert queue does. So the comparison is
 * asserted to live in exactly one place, the same way
 * `monitored-brands-predicate.test.ts` pins the brand gate.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  LOOKALIKE_ALERT_SEVERITY_FLOOR,
  THREAT_LEVEL_RANK,
  clearsLookalikeAlertFloor,
  pageVerdictClearsPhishingBar,
} from "../src/lib/lookalike-alert-policy";
import type { PagePhishingResult, PageThreatLevel } from "../src/lib/page-phishing-scorer";

/** Drop // line comments and block comments so assertions test CODE. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function source(rel: string): string {
  return stripComments(readFileSync(resolve(__dirname, "..", "src", rel), "utf8"));
}

function phishing(over: Partial<PagePhishingResult> = {}): PagePhishingResult {
  return {
    score: 0,
    signals: [],
    credentialHarvest: false,
    antiBotWallFamily: null,
    aiSignals: [],
    scoreDelta: 0,
    evidence: {},
    pageGenerator: null,
    exfilSink: null,
    exfilSinkId: null,
    ...over,
  };
}

// ─── The floor ────────────────────────────────────────────────────

describe("clearsLookalikeAlertFloor", () => {
  it("admits HIGH and CRITICAL only", () => {
    const verdicts: Array<[PageThreatLevel, boolean]> = [
      ["LOW", false],
      ["MEDIUM", false],
      ["HIGH", true],
      ["CRITICAL", true],
    ];
    for (const [level, expected] of verdicts) {
      expect(clearsLookalikeAlertFloor(level), level).toBe(expected);
    }
  });

  it("is HIGH — the user's decision, stated once", () => {
    // Pinned as a value so a change to the floor is a deliberate,
    // reviewable edit and not a side effect of touching a comparison.
    expect(LOOKALIKE_ALERT_SEVERITY_FLOOR).toBe("HIGH");
  });

  it("tracks the constant rather than hardcoding HIGH's rank", () => {
    // Property, not a row list: whatever the floor is set to, it and
    // everything above it clear, and everything below it does not.
    const floorRank = THREAT_LEVEL_RANK[LOOKALIKE_ALERT_SEVERITY_FLOOR];
    for (const level of Object.keys(THREAT_LEVEL_RANK) as PageThreatLevel[]) {
      expect(clearsLookalikeAlertFloor(level), level).toBe(
        THREAT_LEVEL_RANK[level] >= floorRank,
      );
    }
  });
});

// ─── The phishing bar ─────────────────────────────────────────────

describe("pageVerdictClearsPhishingBar", () => {
  it("clears on credential harvest and on a strong score", () => {
    expect(pageVerdictClearsPhishingBar(phishing({ credentialHarvest: true }))).toBe(true);
    expect(pageVerdictClearsPhishingBar(phishing({ score: 60 }))).toBe(true);
    expect(pageVerdictClearsPhishingBar(phishing({ score: 100 }))).toBe(true);
  });

  it("does NOT clear on a moderate score or a bare anti-bot wall", () => {
    // Both mean "worth looking at", which is what the row's own
    // threat_level records. Waking an analyst needs more.
    expect(pageVerdictClearsPhishingBar(phishing({ score: 30 }))).toBe(false);
    expect(pageVerdictClearsPhishingBar(phishing({ score: 59 }))).toBe(false);
    expect(pageVerdictClearsPhishingBar(phishing({
      score: 20, signals: ["anti_bot_wall"],
    }))).toBe(false);
    expect(pageVerdictClearsPhishingBar(phishing())).toBe(false);
  });

  it("ignores the level the row already carries", () => {
    // The bar is about the PAGE. A row already HIGH for unrelated
    // infrastructure reasons must not make a score-zero page 'clear' it,
    // which is why the predicate escalates from the LOW floor.
    expect(pageVerdictClearsPhishingBar(phishing({ score: 0 }))).toBe(false);
  });

  it("reads no Lane 3 shadow field — shadow stays shadow", () => {
    // A verdict whose ONLY content is shadow signal weight must not
    // clear the bar (spec §4.3: nothing shadow may feed a live decision).
    expect(pageVerdictClearsPhishingBar(phishing({
      score: 0,
      aiSignals: ["covert_exfil_sink", "llm_refusal_leakage"],
      scoreDelta: 95,
    }))).toBe(false);
  });
});

// ─── The one-definition invariant ─────────────────────────────────

describe("both alert producers use the shared floor", () => {
  const CHECKER = "scanners/lookalike-domains.ts";
  const PAGE_PASS = "scanners/lookalike-page-analysis.ts";

  it("each producer imports and calls clearsLookalikeAlertFloor", () => {
    for (const file of [CHECKER, PAGE_PASS]) {
      const code = source(file);
      expect(code, file).toMatch(/from ['"]\.\.\/lib\/lookalike-alert-policy['"]/);
      expect(code, file).toMatch(/clearsLookalikeAlertFloor\(/);
    }
  });

  it("neither producer compares against the floor itself", () => {
    // The failure mode this guards: someone "inlines it for clarity" in
    // one file, the two drift, and the drift is invisible. So the floor
    // CONSTANT may only be read for logging — never ranked, compared or
    // list-tested at a producer. The single call above is the gate.
    for (const file of [CHECKER, PAGE_PASS]) {
      const code = source(file);
      expect(code, file).not.toMatch(/[<>=]=?\s*THREAT_LEVEL_RANK\[\s*LOOKALIKE_ALERT_SEVERITY_FLOOR/);
      expect(code, file).not.toMatch(/LOOKALIKE_ALERT_SEVERITY_FLOOR\s*[<>=!]/);
      expect(code, file).not.toMatch(/[<>=!]=*\s*LOOKALIKE_ALERT_SEVERITY_FLOOR/);
      // Exactly one gate per producer — a second call site would mean two
      // places deciding, which is the thing being prevented.
      expect(code.match(/clearsLookalikeAlertFloor\(/g), file).toHaveLength(1);
    }
  });

  it("the policy module imports nothing from the scanners it serves", () => {
    // The whole reason it lives in lib/: `lookalike-domains.ts` already
    // imports from `lookalike-page-analysis.ts`, so policy hosted in
    // either scanner would close a cycle. A floor read through a cycle's
    // temporal dead zone is `undefined`, every comparison against it is
    // false, and the failure is a silent alert blackout — see
    // `lib/monitored-brands.ts` for the same hazard, same answer.
    const code = source("lib/lookalike-alert-policy.ts");
    expect(code).not.toMatch(/from ['"][^'"]*scanners\//);
  });
});
