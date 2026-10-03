import { describe, it, expect } from "vitest";
import { extractJsonObject, isAbuseWorkersAiEnabled } from "../src/lib/workers-ai";
import { clampWorkersAiVerdict } from "../src/lib/abuse-mailbox-classifier";
import type { Env } from "../src/types";

describe("extractJsonObject", () => {
  it("accepts an object (JSON mode) or the first {...} in a string", () => {
    expect(extractJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(extractJsonObject('Sure! {"a":1} done')).toEqual({ a: 1 });
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("{broken")).toBeNull();
  });
});

describe("isAbuseWorkersAiEnabled", () => {
  it("needs both the binding and the provider switch", () => {
    const ai = { run: async () => ({}) };
    expect(isAbuseWorkersAiEnabled({ AI: ai, ABUSE_AI_PROVIDER: "workers_ai" } as unknown as Env)).toBe(true);
    expect(isAbuseWorkersAiEnabled({ AI: ai } as unknown as Env)).toBe(false);
    expect(isAbuseWorkersAiEnabled({ ABUSE_AI_PROVIDER: "workers_ai" } as unknown as Env)).toBe(false);
  });
});

describe("clampWorkersAiVerdict", () => {
  const v = (classification: "phishing" | "spam" | "benign" | "malware" | "ambiguous", confidence: number) =>
    clampWorkersAiVerdict({ classification, action: "takedown", confidence, reasoning: "r" });

  it("phishing/malware at >=70 become 'likely': HIGH, escalate, confidence capped at 80", () => {
    expect(v("phishing", 95)).toMatchObject({ classification: "phishing", severity: "HIGH", action: "escalate", confidence: 80, likely: true });
    expect(v("malware", 70)).toMatchObject({ classification: "malware", severity: "HIGH", likely: true });
  });
  it("below 70 stays in review", () => {
    expect(v("phishing", 69)).toMatchObject({ classification: "ambiguous", action: "review", likely: false });
  });
  it("benign never survives; spam needs >=85", () => {
    expect(v("benign", 100)).toMatchObject({ classification: "ambiguous", action: "review" });
    expect(v("spam", 84)).toMatchObject({ classification: "ambiguous" });
    expect(v("spam", 90)).toMatchObject({ classification: "spam", severity: "LOW", action: "review" });
  });
  it("never emits 'safe' or 'takedown'", () => {
    for (const c of ["phishing", "spam", "benign", "malware", "ambiguous"] as const) {
      for (const conf of [0, 50, 75, 90, 100]) {
        expect(["safe", "takedown"]).not.toContain(v(c, conf).action);
      }
    }
  });
});
