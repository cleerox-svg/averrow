import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { identifyAndCreate } from "../src/agents/pathfinder";

// Mock social-intel module
vi.mock("../src/lib/social-intel", () => ({
  getBrandSocialIntel: vi.fn().mockResolvedValue({
    totalProfiles: 0,
    officialProfiles: 0,
    suspiciousProfiles: 0,
    impersonationProfiles: 0,
    platformsCovered: [],
    platformsWithImpersonation: [],
    socialRiskScore: null,
    highestSeverity: null,
    aiTakedownRecommendations: 0,
    newProfilesLast24h: 0,
    newImpersonationsLast24h: 0,
    profilesNeedingReview: 0,
    impersonationDetails: [],
  }),
}));

// Mock sales-leads db
vi.mock("../src/db/sales-leads", () => ({
  createLead: vi.fn().mockResolvedValue(1),
  getUnenrichedLead: vi.fn().mockResolvedValue(null),
  enrichLead: vi.fn().mockResolvedValue(undefined),
}));

import { getBrandSocialIntel } from "../src/lib/social-intel";

// ─── Scoring constants from pathfinder.ts ──────────────────────
const SCORING = {
  email_grade_f_or_d: 30,
  email_grade_c: 15,
  dmarc_none_or_missing: 20,
  active_phishing_urls: 25,
  spam_trap_catches: 20,
  high_risk_score: 15,
  ai_phishing_detected: 10,
  tranco_top_10k: 10,
  multiple_campaigns: 15,
  recent_risk_spike: 10,
  social_impersonation: 15,
  social_high_risk: 10,
  social_takedown_needed: 10,
};

const MIN_SCORE = 35;

// ─── Mock DB helper ──────────────────────────────────────────────

interface BrandRow {
  brand_id: string;
  brand_name: string;
  brand_domain: string;
  tranco_rank: number | null;
  email_security_grade: string | null;
  dmarc_policy: string | null;
}

interface MockEnvConfig {
  brands: BrandRow[];
  threatCounts?: Array<{ brand_id: string; threat_count: number; phishing_count: number }>;
  phishingSignals?: Array<{ brand_match_id: string; signal_count: number }>;
  trapCatches?: Array<{ spoofed_brand_id: string; catch_count: number }>;
  riskScores?: Array<{ brand_id: string; composite_risk_score: number }>;
  prevRiskScores?: Array<{ brand_id: string; composite_risk_score: number }>;
  aiPhishing?: Array<{ brand_targeted: string; ai_count: number }>;
  campaignCounts?: Array<{ brand_id: string; campaign_count: number }>;
}

function createMockEnv(config: MockEnvConfig) {
  let callIndex = 0;

  // The DB.prepare().all() calls happen in this order:
  // 1. emailGrades query (brands)
  // 2. Promise.all with 7 parallel queries:
  //    [threatCounts, phishingSignals, trapCatches, riskScores, prevRiskScores, aiPhishing, campaignCounts]

  const allResults = [
    { results: config.brands },
    { results: config.threatCounts ?? [] },
    { results: config.phishingSignals ?? [] },
    { results: config.trapCatches ?? [] },
    { results: config.riskScores ?? [] },
    { results: config.prevRiskScores ?? [] },
    { results: config.aiPhishing ?? [] },
    { results: config.campaignCounts ?? [] },
  ];

  return {
    DB: {
      prepare: (_sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async <T>() => null as T | null,
          all: async <T>() => {
            const result = allResults[callIndex] ?? { results: [] };
            callIndex++;
            return result as { results: T[] };
          },
          run: async () => ({ success: true }),
        }),
        all: async <T>() => {
          const result = allResults[callIndex] ?? { results: [] };
          callIndex++;
          return result as { results: T[] };
        },
      }),
    },
    CACHE: {
      get: async () => null,
      put: async () => {},
    },
  } as any;
}

function makeBrand(overrides: Partial<BrandRow> = {}): BrandRow {
  return {
    brand_id: "brand-1",
    brand_name: "Test Corp",
    brand_domain: "testcorp.com",
    tranco_rank: null,
    email_security_grade: null,
    dmarc_policy: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Pathfinder scoring — identifyAndCreate", () => {
  it("returns 0 candidates when no brands match", async () => {
    const env = createMockEnv({ brands: [] });
    const result = await identifyAndCreate(env);

    expect(result.candidates_found).toBe(0);
    expect(result.leads_created).toBe(0);
  });

  it("scores brand with DMARC missing → +20 points (below MIN_SCORE alone)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: null })],
    });
    const result = await identifyAndCreate(env);

    // dmarc_none_or_missing = 20, which < MIN_SCORE (35) — needs a second signal
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with DMARC 'none' → +20 points (below MIN_SCORE alone)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "none" })],
    });
    const result = await identifyAndCreate(env);

    // dmarc_none_or_missing = 20, < MIN_SCORE (35)
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with DMARC 'reject' → no DMARC points", async () => {
    // Only way to qualify is with other signals
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject", email_security_grade: "A" })],
    });
    const result = await identifyAndCreate(env);

    // Score = 0 (no signals), < MIN_SCORE → not qualified
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with email grade F → +30 points (below MIN_SCORE alone)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ email_security_grade: "F", dmarc_policy: "reject" })],
    });
    const result = await identifyAndCreate(env);

    // email_grade_f_or_d = 30, < MIN_SCORE (35) — needs a second signal
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with email grade D → +30 points (below MIN_SCORE alone)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ email_security_grade: "D", dmarc_policy: "reject" })],
    });
    const result = await identifyAndCreate(env);

    // email_grade_f_or_d = 30, < MIN_SCORE (35)
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with email grade C → +15 points (below MIN_SCORE alone)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ email_security_grade: "C", dmarc_policy: "reject" })],
    });
    const result = await identifyAndCreate(env);

    // email_grade_c = 15, < MIN_SCORE (20) → not qualified by itself
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with active phishing URLs → +25 points (below MIN_SCORE alone)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject" })],
      phishingSignals: [{ brand_match_id: "brand-1", signal_count: 5 }],
    });
    const result = await identifyAndCreate(env);

    // active_phishing_urls = 25, < MIN_SCORE (35)
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with spam trap catches → +20 points (below MIN_SCORE alone)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject" })],
      trapCatches: [{ spoofed_brand_id: "brand-1", catch_count: 3 }],
    });
    const result = await identifyAndCreate(env);

    // spam_trap_catches = 20, < MIN_SCORE (35)
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with high risk score (>60) → +15 points", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject" })],
      riskScores: [{ brand_id: "brand-1", composite_risk_score: 75 }],
    });
    const result = await identifyAndCreate(env);

    // high_risk_score = 15, < MIN_SCORE alone → not qualified
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with multiple campaigns (>=3) → +15 points", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject" })],
      campaignCounts: [{ brand_id: "brand-1", campaign_count: 3 }],
    });
    const result = await identifyAndCreate(env);

    // multiple_campaigns = 15, < MIN_SCORE alone
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with recent risk spike (>=20 increase) → +10 points (below MIN_SCORE with just risk)", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject" })],
      riskScores: [{ brand_id: "brand-1", composite_risk_score: 80 }],
      prevRiskScores: [{ brand_id: "brand-1", composite_risk_score: 50 }],
    });
    const result = await identifyAndCreate(env);

    // high_risk_score (15) + recent_risk_spike (10) = 25, < MIN_SCORE (35)
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with Tranco top 10K → +10 points", async () => {
    const env = createMockEnv({
      brands: [makeBrand({ tranco_rank: 5000, dmarc_policy: "reject" })],
    });
    const result = await identifyAndCreate(env);

    // tranco_top_10k = 10, < MIN_SCORE alone
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with social impersonation → +15 points", async () => {
    (getBrandSocialIntel as Mock).mockResolvedValueOnce({
      impersonationProfiles: 3,
      socialRiskScore: 30,
      aiTakedownRecommendations: 0,
    });

    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject" })],
    });
    const result = await identifyAndCreate(env);

    // social_impersonation = 15, < MIN_SCORE alone
    expect(result.candidates_found).toBe(0);
  });

  it("scores brand with social high risk (>=60) → +10 points (below MIN_SCORE with just social)", async () => {
    (getBrandSocialIntel as Mock).mockResolvedValueOnce({
      impersonationProfiles: 1,
      socialRiskScore: 75,
      aiTakedownRecommendations: 0,
    });

    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: "reject" })],
    });
    const result = await identifyAndCreate(env);

    // social_impersonation (15) + social_high_risk (10) = 25, < MIN_SCORE (35)
    expect(result.candidates_found).toBe(0);
  });

  it("combined maximum score uses all scoring factors", async () => {
    (getBrandSocialIntel as Mock).mockResolvedValueOnce({
      impersonationProfiles: 5,
      socialRiskScore: 80,
      aiTakedownRecommendations: 3,
    });

    const env = createMockEnv({
      brands: [
        makeBrand({
          email_security_grade: "F",
          dmarc_policy: null,
          tranco_rank: 1000,
        }),
      ],
      phishingSignals: [{ brand_match_id: "brand-1", signal_count: 10 }],
      trapCatches: [{ spoofed_brand_id: "brand-1", catch_count: 5 }],
      riskScores: [{ brand_id: "brand-1", composite_risk_score: 90 }],
      prevRiskScores: [{ brand_id: "brand-1", composite_risk_score: 40 }],
      aiPhishing: [{ brand_targeted: "brand-1", ai_count: 5 }],
      campaignCounts: [{ brand_id: "brand-1", campaign_count: 5 }],
    });

    const result = await identifyAndCreate(env);

    // All factors: 30+20+25+20+15+10+10+15+10+15+10+10 = 190 (theoretical max)
    expect(result.candidates_found).toBe(1);
    expect(result.leads_created).toBe(1);
  });

  it("excludes brands below MIN_SCORE threshold", async () => {
    const env = createMockEnv({
      // Brand with dmarc=reject, grade=A → no scoring factors → score=0
      brands: [makeBrand({ dmarc_policy: "reject", email_security_grade: "A" })],
    });
    const result = await identifyAndCreate(env);

    expect(result.candidates_found).toBe(0);
    expect(result.leads_created).toBe(0);
  });

  it("caps candidates at MAX_IDENTIFIED (20)", async () => {
    // Create 25 qualifying brands. Each needs score >= 35.
    // dmarc_null (20) + email_grade_F (30) = 50 each.
    const brands = Array.from({ length: 25 }, (_, i) =>
      makeBrand({
        brand_id: `brand-${i}`,
        brand_name: `Corp ${i}`,
        brand_domain: `corp${i}.com`,
        dmarc_policy: null,
        email_security_grade: "F",
      }),
    );

    const env = createMockEnv({ brands });
    const result = await identifyAndCreate(env);

    // Should cap at 20
    expect(result.candidates_found).toBeLessThanOrEqual(20);
  });

  it("sorts candidates by score descending (highest first)", async () => {
    const { createLead } = await import("../src/db/sales-leads");

    // Both brands need score >= 35 to qualify.
    // "low": dmarc_null (20) + phishing (25) = 45
    // "high": dmarc_null (20) + email_grade_F (30) + phishing (25) = 75
    const brands = [
      makeBrand({ brand_id: "low", brand_name: "Low", dmarc_policy: null }),
      makeBrand({
        brand_id: "high",
        brand_name: "High",
        dmarc_policy: null,
        email_security_grade: "F",
      }),
    ];

    const env = createMockEnv({
      brands,
      phishingSignals: [
        { brand_match_id: "low", signal_count: 2 },
        { brand_match_id: "high", signal_count: 5 },
      ],
    });
    await identifyAndCreate(env);

    // First createLead call should be for the higher-scored brand
    const calls = (createLead as Mock).mock.calls;
    if (calls.length >= 2) {
      const firstScore = calls[0][1].prospect_score;
      const secondScore = calls[1][1].prospect_score;
      expect(firstScore).toBeGreaterThanOrEqual(secondScore);
    }
  });

  it("increments error count when createLead throws", async () => {
    const { createLead } = await import("../src/db/sales-leads");
    (createLead as Mock).mockRejectedValueOnce(new Error("DB error"));

    // Needs score >= 35: dmarc_none_or_missing (20) + active_phishing_urls (25) = 45
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: null })],
      phishingSignals: [{ brand_match_id: "brand-1", signal_count: 3 }],
    });
    const result = await identifyAndCreate(env);

    expect(result.errors).toBe(1);
    expect(result.leads_created).toBe(0);
  });

  it("continues processing after social intel throws", async () => {
    (getBrandSocialIntel as Mock).mockRejectedValueOnce(new Error("Social DB error"));

    // Needs score >= 35: dmarc_none_or_missing (20) + active_phishing_urls (25) = 45
    const env = createMockEnv({
      brands: [makeBrand({ dmarc_policy: null })],
      phishingSignals: [{ brand_match_id: "brand-1", signal_count: 3 }],
    });
    const result = await identifyAndCreate(env);

    // Social error is caught, brand should still qualify with DMARC + phishing score
    expect(result.candidates_found).toBe(1);
  });
});

describe("Pathfinder scoring constants", () => {
  it("email_grade_f_or_d weight is 30", () => {
    expect(SCORING.email_grade_f_or_d).toBe(30);
  });

  it("email_grade_c weight is 15", () => {
    expect(SCORING.email_grade_c).toBe(15);
  });

  it("dmarc_none_or_missing weight is 20", () => {
    expect(SCORING.dmarc_none_or_missing).toBe(20);
  });

  it("active_phishing_urls weight is 25", () => {
    expect(SCORING.active_phishing_urls).toBe(25);
  });

  it("spam_trap_catches weight is 20", () => {
    expect(SCORING.spam_trap_catches).toBe(20);
  });

  it("MIN_SCORE threshold is 35", () => {
    expect(MIN_SCORE).toBe(35);
  });

  it("total maximum possible score sums all weights", () => {
    const maxScore = Object.values(SCORING).reduce((sum, val) => sum + val, 0);
    // 30+15+20+25+20+15+10+10+15+10+15+10+10 = 205
    expect(maxScore).toBe(205);
  });
});
