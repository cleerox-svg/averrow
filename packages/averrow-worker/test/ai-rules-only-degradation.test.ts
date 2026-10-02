/**
 * AI_MODE=rules_only degradation — the paths that have no rule-based
 * substitute must SKIP cleanly (leave work queued for when AI returns),
 * and the paths that do have a fallback must use it QUIETLY (a deliberate
 * skip is not a failure worth a diagnostic row or a console.error).
 *
 *   - abuse mailbox: no attempt bump, no 'ambiguous' graduation, row stays
 *     'pending', no determination email.
 *   - news watcher: no RSS fetch, no news_articles insert.
 *   - sentinel social assessment: returns before touching D1.
 *   - public_trust_check (anonymous homepage widget): deterministic answer,
 *     never an error, no diagnostic row.
 *   - social_ai_assessor / evidence_assembler: fallback, no medium
 *     diagnostic row.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/types";
import type { AgentContext } from "../src/lib/agentRunner";
import { runAbuseClassifierBackfill } from "../src/lib/abuse-mailbox-classifier";
import { newsWatcherAgent } from "../src/agents/news-watcher";
import { runSentinelSocialAssessment } from "../src/agents/sentinel";
import { publicTrustCheckAgent } from "../src/agents/public-trust-check";
import { socialAiAssessorAgent } from "../src/agents/social-ai-assessor";
import { evidenceAssemblerAgent } from "../src/agents/evidence-assembler";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";

const realFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** A D1 stand-in that fails the test if anything is prepared. */
function untouchableDb(): { db: D1Database; prepare: ReturnType<typeof vi.fn> } {
  const prepare = vi.fn((sql: string) => {
    throw new Error(`unexpected D1 access: ${sql.slice(0, 80)}`);
  });
  return { db: { prepare } as unknown as D1Database, prepare };
}

function agentCtx(env: unknown, input: Record<string, unknown> = {}): AgentContext {
  return { env: env as Env, runId: "run_test", agentName: "test", input, triggeredBy: null };
}

// ═════════════════════════════════════════════════════════════════
// Abuse mailbox classifier
// ═════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("abuse mailbox classifier under rules_only", () => {
  let raw: SqliteDb;
  let db: D1Database;

  beforeEach(() => {
    raw = openDerivedDb(["abuse_inbox_messages"]);
    // brands / named_threats are outside the unit — answer empty.
    db = d1FromSqlite(raw, { swallow: (sql) => /named_threats|FROM brands/.test(sql) });
    raw.prepare(
      `INSERT INTO abuse_inbox_messages
         (id, org_id, original_from, original_subject, original_body_snippet,
          forwarded_by_email, classification, classification_attempts)
       VALUES ('m1', 1, 'x@evil.test', 'Verify your account', 'click here',
               'reporter@customer.test', 'pending', 2)`,
    ).run();
  });

  const row = () => raw.prepare(
    `SELECT classification, classification_attempts, classified_by,
            last_classify_error, determination_sent_at
       FROM abuse_inbox_messages WHERE id = 'm1'`,
  ).all()[0] as Record<string, unknown>;

  it("leaves classification_attempts unchanged and the row pending (no graduation at attempt cap)", async () => {
    // attempts=2 with MAX=3: one counted failure would graduate it to
    // 'ambiguous'. A deliberate skip must not.
    const env = { DB: db, CACHE: fakeKv(), AI_MODE: "rules_only" } as unknown as Env;

    const r1 = await runAbuseClassifierBackfill(env);
    const r2 = await runAbuseClassifierBackfill(env);

    for (const r of [r1, r2]) {
      expect(r.skipped_rules_only).toBe(true);
      expect(r).toMatchObject({ scanned: 0, classified: 0, failed: 0 });
      expect(r.by_classification.ambiguous).toBe(0);
    }
    expect(row()).toEqual({
      classification: "pending",
      classification_attempts: 2,
      classified_by: null,
      last_classify_error: null,
      determination_sent_at: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // no Anthropic call, no Resend determination email
  });

  it("AI switched off mid-pass (AiDisabledError from the call): attempt bump is undone, row stays pending", async () => {
    // First read of AI_MODE (the pass-level gate) sees AI on; the next
    // (inside callAnthropic) sees rules_only — the mid-pass flip.
    let reads = 0;
    const env = {
      DB: db,
      CACHE: fakeKv(),
      get AI_MODE() { return reads++ === 0 ? undefined : "rules_only"; },
    } as unknown as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await runAbuseClassifierBackfill(env);

    expect(r.skipped_rules_only).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.by_classification.parse_error).toBe(0);
    expect(row()).toMatchObject({
      classification: "pending",
      classification_attempts: 2,
      classified_by: null,
      last_classify_error: null,
      determination_sent_at: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════
// News watcher
// ═════════════════════════════════════════════════════════════════

describe("news_watcher under rules_only", () => {
  it("inserts no news_articles rows (no D1 access at all) and fetches no feed", async () => {
    const { db, prepare } = untouchableDb();
    const res = await newsWatcherAgent.execute(agentCtx({ DB: db, AI_MODE: "rules_only" }));

    expect(prepare).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res).toMatchObject({ itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0 });
    expect(res.output).toMatchObject({ skipped: true });
    expect(String(res.output.reason)).toMatch(/rules_only/);
  });
});

// ═════════════════════════════════════════════════════════════════
// Sentinel social assessment
// ═════════════════════════════════════════════════════════════════

describe("runSentinelSocialAssessment under rules_only", () => {
  it("returns before the SELECT — no D1, no fetch, no console.error", async () => {
    const { db, prepare } = untouchableDb();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runSentinelSocialAssessment({ DB: db, AI_MODE: "rules_only" } as unknown as Env);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════
// Sync agents with a deterministic fallback
// ═════════════════════════════════════════════════════════════════

describe("public_trust_check (anonymous homepage widget) under rules_only", () => {
  const input = {
    domain: "acme.com",
    threatCount: 12,
    providerCount: 3,
    campaignCount: 1,
    isMonitored: true,
    brandName: "Acme",
  };

  it("returns the deterministic assessment — no throw, no error output, no diagnostic row", async () => {
    const { db } = untouchableDb();
    const res = await publicTrustCheckAgent.execute(agentCtx({ DB: db, AI_MODE: "rules_only" }, input));

    expect(res.output).not.toHaveProperty("error");
    expect(res.output).toMatchObject({ trustScore: 76, grade: "C", aiSucceeded: false });
    expect(String(res.output.assessmentText)).toContain("Acme");
    expect(res.agentOutputs ?? []).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a REAL AI failure still writes the medium diagnostic row", async () => {
    // No AI_MODE, no API key → callAnthropic throws a non-skip error.
    const { db } = untouchableDb();
    const res = await publicTrustCheckAgent.execute(agentCtx({ DB: db }, input));
    expect(res.output).toMatchObject({ aiSucceeded: false });
    expect((res.agentOutputs ?? []).map((o) => o.severity)).toEqual(["medium"]);
  });
});

describe("social_ai_assessor / evidence_assembler under rules_only", () => {
  it("social_ai_assessor uses the algorithmic fallback without a diagnostic row", async () => {
    const { db } = untouchableDb();
    const res = await socialAiAssessorAgent.execute(agentCtx({ DB: db, AI_MODE: "rules_only" }, {
      brandName: "Acme", brandDomain: "acme.com", platform: "twitter", handle: "acme_support", verified: false,
    }));
    expect(res.output).toMatchObject({ aiSucceeded: false });
    expect(res.agentOutputs ?? []).toEqual([]);
  });

  it("evidence_assembler uses the deterministic fallback without a diagnostic row", async () => {
    const { db } = untouchableDb();
    const res = await evidenceAssemblerAgent.execute(agentCtx({ DB: db, AI_MODE: "rules_only" }, {
      takedownId: "td_1", targetType: "domain", targetValue: "acme-login.test",
      brandJson: "{}", relatedThreatsJson: "[]", urlScanJson: "{}", socialProfileJson: "{}",
      whoisJson: "{}", existingEvidenceJson: "[]", providerJson: "{}",
    }));
    expect(res.output).toMatchObject({ aiSucceeded: false });
    expect(res.agentOutputs ?? []).toEqual([]);
  });
});
