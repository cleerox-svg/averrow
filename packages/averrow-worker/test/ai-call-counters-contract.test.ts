/**
 * The shared strictly-API counter contract in `lib/haiku.ts`.
 *
 * Instrumented agents record through `recordAiCall` (analyst today —
 * sentinel and cartographer were moved onto rules in AI_STRATEGY_2026-10
 * Phase 1), and Flight Control + the diagnostics `ai_health` block read the
 * resulting key names back out of `agent_outputs.details` via json_extract. So this is
 * the single definition of "did a request actually leave, and did it come
 * back usable" — the question three months of outage went unanswered.
 *
 * End-to-end coverage lives in analyst-ai-counters.test.ts /
 * ai-outage-counters.test.ts (writer) and
 * flight-control-ai-calls-failing.test.ts (reader). This file pins the
 * contract itself plus which agents may carry the counters at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  newAiCallCounters, recordAiCall, mergeAiCallCounters, isAiAllFailing,
  isDeliberateAiSkip, AI_OUTAGE_MIN_ATTEMPTS,
} from "../src/lib/haiku";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("recordAiCall", () => {
  it("a usable response is one attempt and one success", () => {
    const c = newAiCallCounters();
    recordAiCall(c, { success: true }, true);
    expect(c).toMatchObject({ aiCallsAttempted: 1, aiCallsSucceeded: 1, aiCallsSkipped: 0 });
    expect(c.aiFirstError).toBeNull();
  });

  it("a 2xx whose body is unusable is an ATTEMPT that failed, not a skip — the call was billed", () => {
    const c = newAiCallCounters();
    recordAiCall(c, { success: false, error: "Anthropic JSON parse failed: x", failure_kind: "parse_error" }, false);
    expect(c).toMatchObject({ aiCallsAttempted: 1, aiCallsSucceeded: 0, aiCallsSkipped: 0 });
    expect(c.aiFirstFailureKind).toBe("parse_error");
  });

  it.each(["throttled", "budget_cap"] as const)(
    "a %s result is SKIPPED, never attempted — no request left the Worker",
    (kind) => {
      const c = newAiCallCounters();
      recordAiCall(c, { success: false, error: `${kind}: ...`, failure_kind: kind }, false);
      // This is the whole false-positive guard: if a deliberate cost
      // throttle counted as an attempt, the budget guard doing its job
      // would be indistinguishable from an outage.
      expect(c).toMatchObject({ aiCallsAttempted: 0, aiCallsSucceeded: 0, aiCallsSkipped: 1 });
      expect(c.aiFirstError).toBeNull();
      expect(isAiAllFailing(c)).toBe(false);
      expect(isDeliberateAiSkip(kind)).toBe(true);
    },
  );

  it.each(["api_error", "network", "parse_error"] as const)(
    "a %s result is NOT a deliberate skip",
    (kind) => {
      expect(isDeliberateAiSkip(kind)).toBe(false);
    },
  );

  it("an undefined failure_kind is treated as a real failure, not a skip", () => {
    // The default must never be benign: a novel failure shape reading as
    // "we chose to skip" is the exact defect being fixed.
    const c = newAiCallCounters();
    recordAiCall(c, { success: false, error: "something new" }, false);
    expect(c.aiCallsAttempted).toBe(1);
    expect(c.aiCallsSkipped).toBe(0);
  });

  it("keeps only the FIRST error across a whole failing batch", () => {
    const c = newAiCallCounters();
    for (let i = 0; i < 25; i++) {
      recordAiCall(c, { success: false, error: `failure ${i}`, failure_kind: "api_error" }, false);
    }
    expect(c.aiCallsAttempted).toBe(25);
    expect(c.aiFirstError).toBe("failure 0");
  });

  it("succeeded can never exceed attempted, however the outcomes interleave", () => {
    const c = newAiCallCounters();
    const outcomes: Array<[boolean, "api_error" | "throttled" | undefined]> = [
      [true, undefined], [false, "api_error"], [false, "throttled"],
      [true, undefined], [false, "throttled"], [true, undefined],
    ];
    for (const [ok, kind] of outcomes) {
      recordAiCall(c, ok ? { success: true } : { success: false, error: "e", failure_kind: kind }, ok);
    }
    expect(c.aiCallsSucceeded).toBeLessThanOrEqual(c.aiCallsAttempted);
    expect(c).toMatchObject({ aiCallsAttempted: 4, aiCallsSucceeded: 3, aiCallsSkipped: 2 });
  });
});

describe("isAiAllFailing", () => {
  it("a run that made no call is NOT failing (a quiet platform is not an outage)", () => {
    expect(isAiAllFailing({ aiCallsAttempted: 0, aiCallsSucceeded: 0 })).toBe(false);
  });

  it("one partial success clears it — AI is demonstrably alive", () => {
    expect(isAiAllFailing({ aiCallsAttempted: 40, aiCallsSucceeded: 1 })).toBe(false);
  });

  it("carries NO attempts floor: the floor is Flight Control's, so it cannot become a detection ceiling", () => {
    // A run that made 2 calls and had both refused really did fall back to
    // rules for everything it was asked to do. Its consequences are all
    // internal (a severity-high output + status 'partial', which the public
    // status page counts as a success). Nobody is paged by this.
    expect(isAiAllFailing({ aiCallsAttempted: 1, aiCallsSucceeded: 0 })).toBe(true);
    expect(isAiAllFailing({ aiCallsAttempted: 2, aiCallsSucceeded: 0 })).toBe(true);
    expect(AI_OUTAGE_MIN_ATTEMPTS).toBe(3);
  });
});

describe("mergeAiCallCounters", () => {
  it("sums the counts and prefers the FIRST argument's first-failure", () => {
    const required = newAiCallCounters();
    recordAiCall(required, { success: false, error: "required path died", failure_kind: "api_error" }, false);
    const opportunistic = newAiCallCounters();
    recordAiCall(opportunistic, { success: false, error: "best-effort died", failure_kind: "network" }, false);

    const merged = mergeAiCallCounters(required, opportunistic);
    expect(merged).toMatchObject({ aiCallsAttempted: 2, aiCallsSucceeded: 0 });
    expect(merged.aiFirstError).toBe("required path died");
    expect(merged.aiFirstFailureKind).toBe("api_error");
  });

  it("falls back to the second argument's failure when the first path never failed", () => {
    const required = newAiCallCounters();
    recordAiCall(required, { success: true }, true);
    const opportunistic = newAiCallCounters();
    recordAiCall(opportunistic, { success: false, error: "apt died", failure_kind: "api_error" }, false);

    const merged = mergeAiCallCounters(required, opportunistic);
    expect(merged).toMatchObject({ aiCallsAttempted: 2, aiCallsSucceeded: 1 });
    expect(merged.aiFirstError).toBe("apt died");
  });
});

/**
 * Which agents are instrumented. AI_STRATEGY_2026-10 Phase 1 (Batch B)
 * moved sentinel and cartographer onto rules: neither makes an Anthropic
 * call from `execute()` any more, so neither may carry the counters — a
 * permanent `aiCallsAttempted: 0` from an agent that CANNOT call AI would
 * dilute the Flight Control / ai_health rollups with rows that look like
 * "quiet" but are really "not applicable". Analyst is the remaining
 * instrumented agent.
 */
describe("which agents record strictly-API counters", () => {
  it("analyst records at the one site a call is initiated", () => {
    const analyst = src("../src/agents/analyst.ts");
    expect(analyst).toMatch(/recordAiCall\(ai, result, result\.success && !!result\.data\)/);
  });

  it("analyst persists the counters under the key names the readers json_extract", () => {
    // `...ai` spreads AiCallCounters, so the field names come from one
    // type. A hand-written literal could drift from the queries in
    // flightControl.ts and diagnostics.ts silently.
    expect(src("../src/agents/analyst.ts")).toMatch(/\n\s*\.\.\.ai,\n/);
  });

  it.each(["../src/agents/sentinel.ts", "../src/agents/cartographer.ts"])(
    "%s has no haiku import, no counter helpers and no AI-classification path",
    (file) => {
      // Code only — comments may legitimately narrate the removed AI path.
      const code = src(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} must not import lib/haiku`).not.toMatch(/from ["']\.\.\/lib\/haiku["']/);
      expect(code).not.toMatch(/import\(["']\.\.\/lib\/haiku["']\)/);
      for (const sym of ["recordAiCall", "newAiCallCounters", "isAiAllFailing", "mergeAiCallCounters",
        "classifyThreat", "scoreProvider", "scoreProvidersBatch", "callHaikuRaw"]) {
        expect(code, `${file} still references ${sym}`).not.toMatch(new RegExp(`\\b${sym}\\b`));
      }
      // Counters are not spread into the summary details any more.
      expect(code).not.toMatch(/\n\s*\.\.\.(ai|aiTotals),\n/);
    },
  );

  it("cartographer no longer reaches the Message Batches path", () => {
    const cart = src("../src/agents/cartographer.ts");
    expect(cart).not.toMatch(/cartographer-batch/);
    expect(cart).not.toMatch(/anthropic-batches/);
  });
});
