/**
 * G26 — the social rules-only fallback never overwrites the rule-based
 * result and never stores "AI assessment unavailable" text.
 *
 * Covers the assessor (fallback reason + neutral text), the shared write
 * helper used by the scanner and the staff re-assess endpoint (real SQL
 * against the migration-derived social_profiles schema), and the 0287
 * repair migration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import type { AgentContext } from "../src/lib/agentRunner";

const { callJsonSpy } = vi.hoisted(() => ({ callJsonSpy: vi.fn() }));
vi.mock("../src/lib/anthropic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/anthropic")>();
  return { ...actual, callAnthropicJSON: callJsonSpy };
});

const { AiDisabledError, AnthropicError } = await import("../src/lib/anthropic");
const { socialAiAssessorAgent, algorithmicFallback } = await import("../src/agents/social-ai-assessor");
const {
  persistSocialAssessment,
  shouldApplySocialAssessment,
} = await import("../src/lib/social-assessment-persist");
type Output = import("../src/agents/social-ai-assessor").SocialAiAssessorOutput;
type Input = import("../src/agents/social-ai-assessor").SocialAiAssessorInput;

const INPUT: Input = {
  brandName: "Acme",
  brandDomain: "acme.example",
  brandAliases: [],
  brandKeywords: [],
  officialHandles: { twitter: "acme" },
  platform: "twitter",
  handle: "acme_support",
  profileUrl: "https://x.com/acme_support",
  displayName: null,
  bio: null,
  followersCount: null,
  verified: false,
  accountCreated: null,
  existingThreats: [],
  emailSecurityGrade: null,
  activeCampaigns: [],
  lookalikeDomainsFound: 0,
  otherImpersonationProfiles: 0,
};

function ctx(input: Input = INPUT): AgentContext {
  return {
    env: {} as Env,
    runId: "run_1",
    agentName: "social_ai_assessor",
    input: input as unknown as Record<string, unknown>,
    triggeredBy: null,
  };
}

const UNAVAILABLE = /unavailable/i;

function assertNeutral(out: Output): void {
  const text = [out.reasoning, ...out.signals, ...out.crossCorrelations].join(" | ");
  expect(text).not.toMatch(UNAVAILABLE);
  expect(text).not.toMatch(/\bAI\b/);
  // Verification is never observed by the scanner (HEAD-only check).
  expect(text).not.toMatch(/not verified/i);
  // The fallback computes no cross-references, so it claims none.
  expect(out.crossCorrelations).toEqual([]);
  expect(out.evidenceDraft).toBeNull();
}

beforeEach(() => {
  callJsonSpy.mockReset();
});

// ─── Assessor ───────────────────────────────────────────────────────

describe("social_ai_assessor fallback", () => {
  it("AI_MODE=rules_only → ai_skipped, neutral text, no diagnostic row", async () => {
    callJsonSpy.mockRejectedValue(new AiDisabledError("social_ai_assessor"));
    const res = await socialAiAssessorAgent.execute(ctx());
    const out = res.output as unknown as Output;
    expect(out.aiSucceeded).toBe(false);
    expect(out.fallbackReason).toBe("ai_skipped");
    expect(res.agentOutputs ?? []).toEqual([]);
    assertNeutral(out);
    expect(shouldApplySocialAssessment(out)).toBe(false);
  });

  it("a real API failure → ai_error with a diagnostic, still not applicable", async () => {
    callJsonSpy.mockRejectedValue(new AnthropicError("Anthropic HTTP 400 — credit balance too low", "social_ai_assessor", 400));
    const res = await socialAiAssessorAgent.execute(ctx());
    const out = res.output as unknown as Output;
    expect(out.fallbackReason).toBe("ai_error");
    expect((res.agentOutputs ?? []).length).toBe(1);
    assertNeutral(out);
    expect(shouldApplySocialAssessment(out)).toBe(false);
  });

  it("a malformed reply → ai_invalid, not applicable", async () => {
    callJsonSpy.mockResolvedValue({ parsed: { nope: true } });
    const res = await socialAiAssessorAgent.execute(ctx());
    const out = res.output as unknown as Output;
    expect(out.fallbackReason).toBe("ai_invalid");
    assertNeutral(out);
    expect(shouldApplySocialAssessment(out)).toBe(false);
  });

  it("a valid AI reply is applicable", async () => {
    callJsonSpy.mockResolvedValue({
      parsed: {
        classification: "impersonation",
        confidence: 0.92,
        action: "takedown",
        reasoning: "Uses the brand logo and a support-themed handle to solicit credentials.",
        evidence_draft: null,
        signals: ["Support-themed handle"],
        cross_correlations: [],
      },
    });
    const res = await socialAiAssessorAgent.execute(ctx());
    const out = res.output as unknown as Output;
    expect(out.aiSucceeded).toBe(true);
    expect(out.fallbackReason).toBeNull();
    expect(shouldApplySocialAssessment(out)).toBe(true);
  });

  it("every fallback branch is neutral and never reclassifies an unrecognised handle as legitimate", () => {
    const official = algorithmicFallback({ ...INPUT, handle: "acme" }, "ai_skipped");
    const similar = algorithmicFallback(INPUT, "ai_skipped");
    const other = algorithmicFallback({ ...INPUT, handle: "acmee" }, "ai_skipped");
    for (const out of [official, similar, other]) assertNeutral(out);
    expect(official.classification).toBe("official");
    expect(similar.classification).toBe("suspicious");
    expect(other.classification).not.toBe("legitimate");
  });
});

// ─── Write helper (real SQL) ─────────────────────────────────────────

function openDb(): SqliteDb {
  return openDerivedDb(["social_profiles"]);
}

function insertRuleRow(raw: SqliteDb, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: "p1",
    brand_id: "b1",
    platform: "twitter",
    handle: "acme_support",
    classification: "impersonation",
    classified_by: "ai",
    classification_confidence: 0.75,
    impersonation_score: 0.75,
    impersonation_signals: JSON.stringify(["Handle is a permutation of the official brand handle"]),
    severity: "HIGH",
    status: "active",
    ...over,
  };
  const cols = Object.keys(row);
  raw.prepare(`INSERT INTO social_profiles (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => row[c] as null));
}

function getRow(raw: SqliteDb, id = "p1"): Record<string, unknown> {
  return (raw.prepare("SELECT * FROM social_profiles WHERE id = ?").all(id) as Array<Record<string, unknown>>)[0]!;
}

describe.skipIf(!hasSqlite())("persistSocialAssessment", () => {
  for (const reason of ["ai_skipped", "ai_error", "ai_invalid"] as const) {
    for (const kind of ["handle", "id"] as const) {
      it(`${reason} fallback leaves the rule-based row untouched (target by ${kind})`, async () => {
        const raw = openDb();
        insertRuleRow(raw);
        const before = getRow(raw);
        const fallback = algorithmicFallback({ ...INPUT, handle: "zzz" }, reason);
        const target = kind === "handle"
          ? { kind, brandId: "b1", platform: "twitter", handle: "acme_support" } as const
          : { kind, brandId: "b1", profileId: "p1" } as const;
        const applied = await persistSocialAssessment(d1FromSqlite(raw), fallback, target, "2026-10-06T00:00:00Z");
        expect(applied).toBe(false);
        expect(getRow(raw)).toEqual(before);
      });
    }
  }

  it("a real AI assessment is written; a manual classification is kept", async () => {
    const raw = openDb();
    insertRuleRow(raw);
    insertRuleRow(raw, { id: "p2", handle: "acme_help", classified_by: "manual", classification: "legitimate", classification_confidence: 1 });
    const ai: Output = {
      classification: "impersonation",
      confidence: 0.95,
      action: "takedown",
      reasoning: "Uses the brand logo and a support-themed handle to solicit credentials.",
      evidenceDraft: null,
      signals: ["Support-themed handle"],
      crossCorrelations: ["Matches active phishing campaign X"],
      aiSucceeded: true,
      fallbackReason: null,
    };
    const db = d1FromSqlite(raw);
    expect(await persistSocialAssessment(db, ai, { kind: "id", brandId: "b1", profileId: "p1" }, "2026-10-06T00:00:00Z")).toBe(true);
    expect(await persistSocialAssessment(db, ai, { kind: "handle", brandId: "b1", platform: "twitter", handle: "acme_help" }, "2026-10-06T00:00:00Z")).toBe(true);

    const p1 = getRow(raw, "p1");
    expect(p1.classification).toBe("impersonation");
    expect(p1.severity).toBe("CRITICAL");
    expect(p1.classification_reason).toBe(ai.reasoning);
    expect(p1.ai_assessed_at).toBe("2026-10-06T00:00:00Z");
    expect(p1.impersonation_score).toBe(0.75); // never touched by the assessor

    const p2 = getRow(raw, "p2");
    expect(p2.classification).toBe("legitimate");
    expect(p2.classification_confidence).toBe(1);
  });
});

// ─── 0287 repair migration ───────────────────────────────────────────

const OLD_SIMILAR = "Handle resembles brand name but AI assessment was unavailable. Flagged for manual review.";
const OLD_OTHER = "AI assessment was unavailable. Low-confidence algorithmic fallback applied.";

describe.skipIf(!hasSqlite())("migration 0287 social fallback scrub", () => {
  const sql = readFileSync(resolve(__dirname, "..", "migrations", "0287_social_fallback_text_scrub.sql"), "utf8");

  function seed(raw: SqliteDb): void {
    // Impersonation-scan row reclassified 'legitimate' by the old fallback.
    insertRuleRow(raw, {
      id: "scan_hi", impersonation_score: 0.8, classification: "legitimate", classification_confidence: 0.3,
      severity: "LOW", classification_reason: OLD_OTHER, ai_assessment: OLD_OTHER, ai_confidence: 0.3,
      ai_action: "safe", ai_assessed_at: "2026-09-01T00:00:00Z",
      impersonation_signals: JSON.stringify(["AI assessment unavailable — algorithmic fallback"]),
    });
    insertRuleRow(raw, {
      id: "scan_mid", handle: "acme_mid", impersonation_score: 0.5, classification: "suspicious", classification_confidence: 0.4,
      severity: "MEDIUM", classification_reason: OLD_SIMILAR, ai_assessment: OLD_SIMILAR, ai_confidence: 0.4,
      ai_action: "review", ai_assessed_at: "2026-09-01T00:00:00Z",
      impersonation_signals: JSON.stringify(["Handle contains brand name", "Not verified", "AI assessment unavailable"]),
    });
    // Official-handle check row the fallback misread.
    insertRuleRow(raw, {
      id: "official", handle: "acme", classified_by: "system", impersonation_score: 0, classification: "legitimate",
      classification_confidence: 0.3, severity: "LOW", classification_reason: OLD_OTHER, ai_assessment: OLD_OTHER,
    });
    // Manual decision with fallback text: classification kept, text cleared.
    insertRuleRow(raw, {
      id: "manual", handle: "acme_m", classified_by: "manual", classification: "legitimate", classification_confidence: 1,
      classification_reason: OLD_OTHER, ai_assessment: OLD_OTHER,
    });
    // Real AI reasoning — untouched.
    insertRuleRow(raw, {
      id: "real_ai", handle: "acme_real", classification: "impersonation", classification_reason: "Real AI reasoning text here.",
      ai_assessment: "Real AI reasoning text here.", ai_confidence: 0.9,
    });
  }

  it("restores rule-based classification, clears the fallback text, leaves real data alone, and is idempotent", () => {
    const raw = openDb();
    seed(raw);
    const realBefore = getRow(raw, "real_ai");
    raw.exec(sql);

    const hi = getRow(raw, "scan_hi");
    expect(hi).toMatchObject({
      classification: "impersonation", classification_confidence: 0.8, severity: "HIGH",
      classification_reason: null, ai_assessment: null, ai_confidence: null, ai_action: null, ai_assessed_at: null,
      impersonation_signals: "[]",
    });
    expect(getRow(raw, "scan_mid")).toMatchObject({
      classification: "suspicious", classification_confidence: 0.5, severity: "MEDIUM",
      classification_reason: null, impersonation_signals: "[]",
    });
    expect(getRow(raw, "official")).toMatchObject({
      classification: "official", classification_confidence: null, severity: "LOW", classification_reason: null,
    });
    expect(getRow(raw, "manual")).toMatchObject({
      classification: "legitimate", classification_confidence: 1, classification_reason: null, ai_assessment: null,
    });
    expect(getRow(raw, "real_ai")).toEqual(realBefore);

    const snapshot = (raw.prepare("SELECT * FROM social_profiles ORDER BY id").all());
    raw.exec(sql);
    expect(raw.prepare("SELECT * FROM social_profiles ORDER BY id").all()).toEqual(snapshot);
  });
});
