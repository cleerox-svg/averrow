import { describe, it, expect } from "vitest";
import { isOverRunBudget, RUN_BUDGET_MS } from "../src/agents/strategist";

/**
 * Unit coverage for the strategist per-run wall-clock budget guard.
 *
 * The end-to-end "does the run finish before the worker is killed" behavior is
 * timing-dependent and covered by qa-verifier against the live mesh. What we can
 * test cheaply and deterministically is the pure predicate every AI-loop guard
 * calls (`isOverRunBudget`) and the documented budget constant — the piece most
 * likely to regress if someone flips the comparison or edits the threshold.
 */
describe("strategist RUN_BUDGET_MS", () => {
  it("is ~3.5 min — safely under the ~300s worker cpu budget and the 45-min reap floor", () => {
    expect(RUN_BUDGET_MS).toBe(210_000);
    // Under the CF worker cpu_ms=300000 ceiling with headroom for the tail SQL.
    expect(RUN_BUDGET_MS).toBeLessThan(300_000);
    // Well under the fixed 45-min (2_700_000 ms) orphan-reap floor.
    expect(RUN_BUDGET_MS).toBeLessThan(45 * 60 * 1000);
  });
});

describe("strategist isOverRunBudget", () => {
  it("is false at run start (zero elapsed)", () => {
    expect(isOverRunBudget(1_000, 1_000)).toBe(false);
  });

  it("is false while under budget", () => {
    const start = 1_000;
    expect(isOverRunBudget(start, start + RUN_BUDGET_MS - 1)).toBe(false);
  });

  it("is false exactly at the budget (strict greater-than, not >=)", () => {
    const start = 1_000;
    expect(isOverRunBudget(start, start + RUN_BUDGET_MS)).toBe(false);
  });

  it("is true once elapsed exceeds the budget by 1ms", () => {
    const start = 1_000;
    expect(isOverRunBudget(start, start + RUN_BUDGET_MS + 1)).toBe(true);
  });

  it("is true well past the budget (slow-gateway tick)", () => {
    const start = 1_000;
    expect(isOverRunBudget(start, start + 290_000)).toBe(true);
  });

  it("honors an explicit budgetMs override", () => {
    expect(isOverRunBudget(0, 5_000, 10_000)).toBe(false);
    expect(isOverRunBudget(0, 15_000, 10_000)).toBe(true);
  });

  it("defaults budgetMs to RUN_BUDGET_MS when omitted", () => {
    const start = 0;
    expect(isOverRunBudget(start, RUN_BUDGET_MS + 500)).toBe(
      isOverRunBudget(start, RUN_BUDGET_MS + 500, RUN_BUDGET_MS),
    );
  });
});
