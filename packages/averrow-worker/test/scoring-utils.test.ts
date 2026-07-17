import { describe, it, expect } from "vitest";
import { computeExposureScore, computePriorityScore } from "../src/lib/scoring-utils";

describe("computeExposureScore", () => {
  it("returns 0 or low score when all components are zero/neutral", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
      trapCatches: 0,
    });
    // A+ = 100, exposure from email = (100-100)*0.35 = 0, everything else 0
    expect(score).toBe(0);
  });

  it("gives maximum email exposure for grade F", () => {
    const scoreF = computeExposureScore({
      threatCount: 0,
      emailGrade: "F",
      socialRisk: 0,
      domainRisk: 0,
    });
    // F = 10, exposure = Math.round((100-10)*0.35) = Math.round(31.499...) = 31
    expect(scoreF).toBe(31);
  });

  it("gives less email exposure for grade A", () => {
    const scoreA = computeExposureScore({
      threatCount: 0,
      emailGrade: "A",
      socialRisk: 0,
      domainRisk: 0,
    });
    // A = 95, exposure = (100-95)*0.35 = 1.75 → round = 2
    expect(scoreA).toBe(2);
  });

  it("gives moderate email exposure for grade C", () => {
    const scoreC = computeExposureScore({
      threatCount: 0,
      emailGrade: "C",
      socialRisk: 0,
      domainRisk: 0,
    });
    // C = 65, exposure = (100-65)*0.35 = 12.25 → round = 12
    expect(scoreC).toBe(12);
  });

  it("handles null email grade with default score", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: null,
      socialRisk: 0,
      domainRisk: 0,
    });
    // null → '' → not in map → defaults to 50
    // exposure = (100-50)*0.35 = 17.5 → round = 18
    expect(score).toBe(18);
  });

  // Threat count tiers
  it("adds 6 points for 1-2 threats", () => {
    const score = computeExposureScore({
      threatCount: 1,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
    });
    expect(score).toBe(6);
  });

  it("adds 12 points for 3-5 threats", () => {
    const score = computeExposureScore({
      threatCount: 3,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
    });
    expect(score).toBe(12);
  });

  it("adds 18 points for 6-10 threats", () => {
    const score = computeExposureScore({
      threatCount: 6,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
    });
    expect(score).toBe(18);
  });

  it("adds 25 points for 11+ threats", () => {
    const score = computeExposureScore({
      threatCount: 100,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
    });
    expect(score).toBe(25);
  });

  // Domain risk (lookalikes) tiers
  it("adds 8 points for 1-2 lookalike domains", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 1,
    });
    expect(score).toBe(8);
  });

  it("adds 15 points for 3-5 lookalike domains", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 3,
    });
    expect(score).toBe(15);
  });

  it("adds 22 points for 6-10 lookalike domains", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 6,
    });
    expect(score).toBe(22);
  });

  it("adds 30 points for 11+ lookalike domains", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 15,
    });
    expect(score).toBe(30);
  });

  // Social risk
  it("adds social risk points (2x multiplier, capped at 7)", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 3,
      domainRisk: 0,
    });
    expect(score).toBe(6); // min(7, 3*2) = 6
  });

  it("caps social risk at 7 points", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 10,
      domainRisk: 0,
    });
    expect(score).toBe(7);
  });

  // Trap catches
  it("adds trap catch points (1 per catch, capped at 3)", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
      trapCatches: 2,
    });
    expect(score).toBe(2);
  });

  it("caps trap catches at 3 points", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
      trapCatches: 100,
    });
    expect(score).toBe(3);
  });

  it("ignores trapCatches when undefined", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
    });
    expect(score).toBe(0);
  });

  // Combined high risk
  it("combines all risk factors near maximum", () => {
    const score = computeExposureScore({
      threatCount: 100,  // +25
      emailGrade: "F",   // +32 (rounded from 31.5)
      socialRisk: 10,    // +7 (capped)
      domainRisk: 20,    // +30
      trapCatches: 10,   // +3 (capped)
    });
    // 25 + 31 + 7 + 30 + 3 = 96
    expect(score).toBe(96);
  });

  it("caps total score at 100", () => {
    // Even if somehow components exceed 100, it should cap
    const score = computeExposureScore({
      threatCount: 100,
      emailGrade: "F",
      socialRisk: 100,
      domainRisk: 100,
      trapCatches: 100,
    });
    expect(score).toBeLessThanOrEqual(100);
  });

  it("never returns below 0", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "A+",
      socialRisk: 0,
      domainRisk: 0,
      trapCatches: 0,
    });
    expect(score).toBeGreaterThanOrEqual(0);
  });

  // Email grade case insensitivity
  it("handles lowercase email grade", () => {
    const lower = computeExposureScore({
      threatCount: 0,
      emailGrade: "f",
      socialRisk: 0,
      domainRisk: 0,
    });
    const upper = computeExposureScore({
      threatCount: 0,
      emailGrade: "F",
      socialRisk: 0,
      domainRisk: 0,
    });
    expect(lower).toBe(upper);
  });

  it("handles unknown email grade with default", () => {
    const score = computeExposureScore({
      threatCount: 0,
      emailGrade: "X",
      socialRisk: 0,
      domainRisk: 0,
    });
    // Unknown → default 50, exposure = (100-50)*0.35 = 17.5 → 18
    expect(score).toBe(18);
  });
});

describe("computePriorityScore", () => {
  it("returns 90 for CRITICAL", () => {
    expect(computePriorityScore("CRITICAL")).toBe(90);
  });

  it("returns 70 for HIGH", () => {
    expect(computePriorityScore("HIGH")).toBe(70);
  });

  it("returns 50 for MEDIUM", () => {
    expect(computePriorityScore("MEDIUM")).toBe(50);
  });

  it("returns 30 for LOW", () => {
    expect(computePriorityScore("LOW")).toBe(30);
  });

  it("is case insensitive — lowercase critical", () => {
    expect(computePriorityScore("critical")).toBe(90);
  });

  it("is case insensitive — mixed case High", () => {
    expect(computePriorityScore("High")).toBe(70);
  });

  it("returns default 50 for empty string", () => {
    expect(computePriorityScore("")).toBe(50);
  });

  it("returns default 50 for null", () => {
    expect(computePriorityScore(null)).toBe(50);
  });

  it("returns default 50 for undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(computePriorityScore(undefined as any)).toBe(50);
  });

  it("returns default 50 for unknown severity", () => {
    expect(computePriorityScore("unknown")).toBe(50);
  });

  it("returns default 50 for arbitrary string", () => {
    expect(computePriorityScore("urgent")).toBe(50);
  });
});
