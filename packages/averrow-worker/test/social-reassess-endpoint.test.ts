/**
 * POST /api/brands/:id/social-profiles/:profileId/assess
 *
 * When the assessor falls back (no AI assessment ran), the endpoint is a
 * 409 `{ success:false, error:'No assessment available', reason }`, writes
 * nothing to the row, and audits the attempt. A real assessment is a 200
 * and is audited too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const { runSyncAgentSpy, auditSpy } = vi.hoisted(() => ({
  runSyncAgentSpy: vi.fn(),
  auditSpy: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/agentRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/agentRunner")>();
  return { ...actual, runSyncAgent: runSyncAgentSpy };
});
vi.mock("../src/lib/audit", () => ({ audit: auditSpy }));

const { handleReassessSocialProfile } = await import("../src/handlers/brands");
const { algorithmicFallback } = await import("../src/agents/social-ai-assessor");
type Output = import("../src/agents/social-ai-assessor").SocialAiAssessorOutput;
type Input = import("../src/agents/social-ai-assessor").SocialAiAssessorInput;

const STAFF_USER_ID = "usr_7f3a9c2e41d84b0f";

function seed(): SqliteDb {
  const raw = openDerivedDb([
    "social_profiles", "brands", "monitored_brands", "users", "threats",
    "campaigns", "lookalike_domains",
  ]);
  raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Acme', 'acme.example')").run();
  raw.prepare("INSERT INTO users (id, email, name, role) VALUES (?, 'staff@averrow.test', 'Staff', 'admin')").run(STAFF_USER_ID);
  raw.prepare(`INSERT INTO social_profiles
      (id, brand_id, platform, handle, classification, classified_by, classification_confidence,
       classification_reason, impersonation_score, impersonation_signals, severity, status)
    VALUES ('p1', 'b1', 'twitter', 'acme_support', 'impersonation', 'ai', 0.77,
       'Handle is a permutation of the brand name.', 0.77, '["Handle is a permutation of the brand name"]', 'HIGH', 'active')`).run();
  return raw;
}

function row(raw: SqliteDb): Record<string, unknown> {
  return (raw.prepare("SELECT * FROM social_profiles WHERE id = 'p1'").all() as Array<Record<string, unknown>>)[0]!;
}

function call(raw: SqliteDb): Promise<Response> {
  // `email_security_posture` (read for the assessor's email-grade input) is
  // not created by any migration, so the derived schema cannot build it.
  // Swallow only that read (empty result) so the test exercises the rest.
  const db = d1FromSqlite(raw, { swallow: (sql) => sql.includes("email_security_posture") });
  const env = { DB: db } as unknown as Env;
  const req = new Request("https://averrow.test/api/brands/b1/social-profiles/p1/assess", { method: "POST" });
  return handleReassessSocialProfile(req, env, "b1", "p1", STAFF_USER_ID);
}

const INPUT_STUB = { brandName: "Acme", handle: "zzz", officialHandles: {} } as unknown as Input;

beforeEach(() => {
  runSyncAgentSpy.mockReset();
  auditSpy.mockClear();
});

describe.skipIf(!hasSqlite())("handleReassessSocialProfile", () => {
  for (const reason of ["ai_skipped", "ai_error", "ai_invalid"] as const) {
    it(`${reason} → 409, row untouched, attempt audited`, async () => {
      const raw = seed();
      const before = row(raw);
      runSyncAgentSpy.mockResolvedValue({ data: algorithmicFallback({ ...INPUT_STUB }, reason) });

      const res = await call(raw);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: "No assessment available", reason });
      expect(row(raw)).toEqual(before);

      expect(auditSpy).toHaveBeenCalledTimes(1);
      const entry = (auditSpy.mock.calls[0] as unknown as [Env, Record<string, unknown>])[1];
      expect(entry).toMatchObject({
        action: "social_profile_ai_reassess",
        userId: STAFF_USER_ID,
        resourceId: "p1",
        outcome: "failure",
        details: { brand_id: "b1", ai_applied: false, reason },
      });
    });
  }

  it("a real assessment → 200, written, audited as success", async () => {
    const raw = seed();
    const ai: Output = {
      classification: "impersonation",
      confidence: 0.93,
      action: "takedown",
      reasoning: "Support-themed handle soliciting account credentials.",
      evidenceDraft: null,
      signals: [],
      crossCorrelations: [],
      aiSucceeded: true,
      fallbackReason: null,
    };
    runSyncAgentSpy.mockResolvedValue({ data: ai });

    const res = await call(raw);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { ai_applied: boolean } };
    expect(body.success).toBe(true);
    expect(body.data.ai_applied).toBe(true);
    expect(row(raw).ai_assessment).toBe(ai.reasoning);

    const entry = (auditSpy.mock.calls[0] as unknown as [Env, Record<string, unknown>])[1];
    expect(entry).toMatchObject({ outcome: "success", details: { ai_applied: true, classification: "impersonation" } });
  });
});
