/**
 * Social rules path: scorer reason strings describe only observed facts,
 * the scanner writes a deterministic classification_reason, and no scan or
 * discovery upsert overwrites a person's classification (classified_by =
 * a user id — the only value the staff PATCH writes).
 */

import { describe, it, expect } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import { scoreImpersonation, type ImpersonationSignals } from "../src/scanners/impersonation-scorer";
import {
  HUMAN_CLASSIFIED_SQL,
  SOCIAL_DISCOVERY_UPSERT_SQL,
  buildRulesClassificationReason,
  isHumanClassifiedBy,
  socialScanClassification,
  upsertSocialScanImpersonation,
  type SocialScanImpersonationRow,
} from "../src/lib/social-scan-persist";

const STAFF_USER_ID = "usr_7f3a9c2e41d84b0f";

// ─── Scorer ──────────────────────────────────────────────────────────

/** What social-monitor passes for a HEAD-probed permutation hit. */
function headOnly(over: Partial<ImpersonationSignals> = {}): ImpersonationSignals {
  return {
    name_similarity: 0,
    uses_brand_keywords: false,
    account_age_suspicious: false,
    low_followers: false,
    verified: false,
    handle_is_permutation: true,
    ...over,
  };
}

describe("scoreImpersonation reason strings", () => {
  it("never claims an unobserved fact (verification, bio, display name)", () => {
    const r = scoreImpersonation(headOnly({ name_similarity: 0.9, uses_brand_keywords: true }));
    const text = r.reasons.join(" | ");
    expect(text).not.toMatch(/verified/i);
    expect(text).not.toMatch(/\bbio\b/i);
    expect(text).not.toMatch(/account name/i);
    expect(r.reasons).toEqual([
      "Handle is very similar to the brand name (90% match)",
      "Handle contains the brand name or domain",
      "Handle is a permutation of the brand name",
    ]);
  });

  it("keeps the score math identical (the unobserved not_verified weight still applies)", () => {
    // 0.9*0.30 + 0.15 + 0.10 (not_verified) + 0.25 = 0.77
    const full = scoreImpersonation(headOnly({ name_similarity: 0.9, uses_brand_keywords: true }));
    expect(full.score).toBeCloseTo(0.77, 10);
    expect(full.severity).toBe("HIGH");
    // permutation + not_verified only = 0.35
    const bare = scoreImpersonation(headOnly());
    expect(bare.score).toBeCloseTo(0.35, 10);
    expect(bare.reasons).toEqual(["Handle is a permutation of the brand name"]);
    // verified=true drops exactly the 0.10 weight
    expect(scoreImpersonation(headOnly({ verified: true })).score).toBeCloseTo(0.25, 10);
  });

  it("names the subject the handle was compared against", () => {
    const r = scoreImpersonation(headOnly({ name_similarity: 0.6 }), { subject: "the executive's name" });
    expect(r.reasons).toEqual([
      "Handle resembles the executive's name (60% match)",
      "Handle is a permutation of the executive's name",
    ]);
  });
});

// ─── Pure helpers ────────────────────────────────────────────────────

describe("social scan helpers", () => {
  it("isHumanClassifiedBy: user ids are people, machine writers and NULL are not", () => {
    expect(isHumanClassifiedBy(STAFF_USER_ID)).toBe(true);
    expect(isHumanClassifiedBy("manual")).toBe(true);
    for (const v of ["system", "ai", "auto_discovery", null, undefined]) {
      expect(isHumanClassifiedBy(v)).toBe(false);
    }
  });

  it("buildRulesClassificationReason joins the true signals into one sentence", () => {
    expect(buildRulesClassificationReason([
      "Handle is a permutation of the brand name",
      "Handle is very similar to the brand name (87% match)",
    ])).toBe("Handle is a permutation of the brand name; handle is very similar to the brand name (87% match).");
    expect(buildRulesClassificationReason([])).toBeNull();
    expect(buildRulesClassificationReason(["  "])).toBeNull();
  });

  it("socialScanClassification keeps the 0.7 threshold", () => {
    expect(socialScanClassification(0.7)).toBe("impersonation");
    expect(socialScanClassification(0.69)).toBe("suspicious");
  });
});

// ─── Upserts (real SQL) ──────────────────────────────────────────────

function openDb(): SqliteDb {
  const raw = openDerivedDb(["social_profiles"]);
  // The derived schema omits indexes; the upserts' ON CONFLICT target is
  // migration 0036's unique index, so recreate it verbatim.
  raw.exec("CREATE UNIQUE INDEX idx_social_profiles_brand_platform_handle ON social_profiles(brand_id, platform, handle)");
  return raw;
}

function getRow(raw: SqliteDb, brandId: string, handle: string): Record<string, unknown> {
  return (raw.prepare("SELECT * FROM social_profiles WHERE brand_id = ? AND handle = ?")
    .all(brandId, handle) as Array<Record<string, unknown>>)[0]!;
}

function scanRow(over: Partial<SocialScanImpersonationRow> = {}): SocialScanImpersonationRow {
  const scored = scoreImpersonation(headOnly({ name_similarity: 0.87, uses_brand_keywords: true }));
  return {
    brandId: "b1",
    platform: "twitter",
    handle: "acme_support",
    profileUrl: "https://x.com/acme_support",
    displayName: "acme_support",
    score: scored.score,
    signals: scored.reasons,
    severity: scored.severity,
    ...over,
  };
}

describe.skipIf(!hasSqlite())("upsertSocialScanImpersonation", () => {
  it("a new hit is stored with a deterministic reason built from the signals", async () => {
    const raw = openDb();
    const row = scanRow();
    await upsertSocialScanImpersonation(d1FromSqlite(raw), "p1", row);
    const got = getRow(raw, "b1", "acme_support");
    expect(got).toMatchObject({
      classification: "impersonation",
      classified_by: "ai",
      classification_confidence: row.score,
      impersonation_score: row.score,
      severity: "HIGH",
      classification_reason:
        "Handle is very similar to the brand name (87% match); handle contains the brand name or domain; handle is a permutation of the brand name.",
    });
    expect(JSON.parse(String(got.impersonation_signals))).toEqual(row.signals);
  });

  it("a re-scan refreshes a machine-classified row", async () => {
    const raw = openDb();
    const db = d1FromSqlite(raw);
    await upsertSocialScanImpersonation(db, "p1", scanRow());
    const lower = scoreImpersonation(headOnly());
    await upsertSocialScanImpersonation(db, "p2", scanRow({ score: lower.score, signals: lower.reasons, severity: lower.severity }));
    const got = getRow(raw, "b1", "acme_support");
    expect(got.id).toBe("p1");
    expect(got.classification).toBe("suspicious");
    expect(got.classification_reason).toBe("Handle is a permutation of the brand name.");
    expect(got.severity).toBe("LOW");
  });

  it("a re-scan never overwrites a person's classification, confidence or reason", async () => {
    const raw = openDb();
    const db = d1FromSqlite(raw);
    await upsertSocialScanImpersonation(db, "p1", scanRow());
    // The staff PATCH writes classification + the user's id.
    raw.prepare("UPDATE social_profiles SET classification = 'legitimate', classified_by = ?, classification_confidence = 1, classification_reason = ? WHERE id = 'p1'")
      .run(STAFF_USER_ID, "Partner reseller account.");

    const rescored = scanRow({ score: 0.95, severity: "CRITICAL", signals: ["Handle is a permutation of the brand name"] });
    await upsertSocialScanImpersonation(db, "p2", rescored);
    const got = getRow(raw, "b1", "acme_support");
    expect(got).toMatchObject({
      classification: "legitimate",
      classified_by: STAFF_USER_ID,
      classification_confidence: 1,
      classification_reason: "Partner reseller account.",
      // Observations still refresh.
      impersonation_score: 0.95,
      severity: "CRITICAL",
    });
  });
});

describe.skipIf(!hasSqlite())("SOCIAL_DISCOVERY_UPSERT_SQL", () => {
  async function discover(db: ReturnType<typeof d1FromSqlite>, id: string): Promise<void> {
    await db.prepare(SOCIAL_DISCOVERY_UPSERT_SQL)
      .bind(id, "b1", "twitter", "acme_support", "https://x.com/acme_support", 0.8).run();
  }

  it("marks a machine-classified row official", async () => {
    const raw = openDb();
    const db = d1FromSqlite(raw);
    await upsertSocialScanImpersonation(db, "p1", scanRow());
    await discover(db, "p2");
    expect(getRow(raw, "b1", "acme_support")).toMatchObject({
      classification: "official", classified_by: "auto_discovery", classification_confidence: 0.8,
    });
  });

  it("keeps a person's classification", async () => {
    const raw = openDb();
    const db = d1FromSqlite(raw);
    await upsertSocialScanImpersonation(db, "p1", scanRow());
    raw.prepare("UPDATE social_profiles SET classification = 'impersonation', classified_by = ?, classification_confidence = 1 WHERE id = 'p1'")
      .run(STAFF_USER_ID);
    await discover(db, "p2");
    expect(getRow(raw, "b1", "acme_support")).toMatchObject({
      classification: "impersonation", classified_by: STAFF_USER_ID, classification_confidence: 1,
    });
  });
});

describe("HUMAN_CLASSIFIED_SQL", () => {
  it("lists exactly the machine writers", () => {
    expect(HUMAN_CLASSIFIED_SQL).toContain("classified_by IS NOT NULL");
    expect(HUMAN_CLASSIFIED_SQL).toContain("NOT IN ('system', 'ai', 'auto_discovery')");
  });
});
