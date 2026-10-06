/**
 * G26 — the social rules-only fallback never overwrites the rule-based
 * result and never stores "AI assessment unavailable" text.
 *
 * Covers the assessor (fallback reason + neutral text) and the shared write
 * helper used by the scanner and the staff re-assess endpoint (real SQL
 * against the migration-derived social_profiles schema).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

  // The staff PATCH (handlers/brands.ts handleUpdateSocialProfile) stores
  // the acting user's id in classified_by — never the literal 'manual'.
  const STAFF_USER_ID = "usr_7f3a9c2e41d84b0f";

  it("a real AI assessment is written; a person's classification (user id) is kept", async () => {
    const raw = openDb();
    insertRuleRow(raw);
    insertRuleRow(raw, {
      id: "p2", handle: "acme_help", classified_by: STAFF_USER_ID, classification: "legitimate",
      classification_confidence: 1, classification_reason: "Partner account, confirmed with the brand.",
    });
    insertRuleRow(raw, { id: "p3", handle: "acme", classified_by: "system", classification: "official", classification_confidence: null });
    insertRuleRow(raw, { id: "p4", handle: "acme_hq", classified_by: "auto_discovery", classification: "official", classification_confidence: 0.6 });
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
    const now = "2026-10-06T00:00:00Z";
    expect(await persistSocialAssessment(db, ai, { kind: "id", brandId: "b1", profileId: "p1" }, now)).toBe(true);
    expect(await persistSocialAssessment(db, ai, { kind: "handle", brandId: "b1", platform: "twitter", handle: "acme_help" }, now)).toBe(true);
    expect(await persistSocialAssessment(db, ai, { kind: "id", brandId: "b1", profileId: "p3" }, now)).toBe(true);
    expect(await persistSocialAssessment(db, ai, { kind: "id", brandId: "b1", profileId: "p4" }, now)).toBe(true);

    const p1 = getRow(raw, "p1");
    expect(p1.classification).toBe("impersonation");
    expect(p1.severity).toBe("CRITICAL");
    expect(p1.classification_reason).toBe(ai.reasoning);
    expect(p1.ai_assessed_at).toBe(now);
    expect(p1.impersonation_score).toBe(0.75); // never touched by the assessor

    const p2 = getRow(raw, "p2");
    expect(p2.classified_by).toBe(STAFF_USER_ID);
    expect(p2.classification).toBe("legitimate");
    expect(p2.classification_confidence).toBe(1);
    expect(p2.classification_reason).toBe("Partner account, confirmed with the brand.");
    // The AI's own view is still recorded in the ai_* columns.
    expect(p2.ai_assessment).toBe(ai.reasoning);
    expect(p2.ai_assessed_at).toBe(now);

    // Machine writers are not people: their classification is replaceable.
    expect(getRow(raw, "p3").classification).toBe("impersonation");
    expect(getRow(raw, "p4").classification).toBe("impersonation");
  });
});
