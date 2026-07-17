/**
 * Phase 4 Step 2D — Ledger coverage regression test.
 *
 * The Phase 4 Step 2 wrapper refactor's whole point is that every
 * Anthropic call site in the worker now writes a budget_ledger row
 * automatically. This test proves it end-to-end: it mocks fetch with
 * canned Anthropic responses, drives one representative call from
 * each migrated surface (haiku.ts helpers, lib helpers, handlers,
 * direct-fetch agents that were rewritten), and asserts that
 * budget_ledger received exactly the expected rows with the right
 * agent_id, model, and non-zero cost.
 *
 * If anyone in the future adds an AI code path that bypasses the
 * canonical wrapper, the surface they touch loses its ledger row
 * here and the corresponding assertion fails.
 *
 * Surfaces covered:
 *   1. haiku.ts.classifyThreat       → agentId from caller
 *   2. haiku.ts.callHaikuRaw          → agentId from caller
 *   3. agents/social-ai-assessor      → agentId="social_ai_assessor"
 *   4. agents/evidence-assembler      → agentId="evidence_assembler"
 *   5. lib/brand-enricher.classifySector → agentId="brand-enricher"
 *   6. honeypot-generator             → agentId="honeypot-generator"
 *   7. canonical wrapper directly     → arbitrary agentId
 *
 * The Architect analyzer + synthesizer have their own happy-path
 * tests that already exercise the wrapper (they log the "env.DB
 * missing — ledger row skipped" warning when run with a stub env;
 * here we run with a real DB stub so the row lands).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

import { classifyThreat, callHaikuRaw } from "../src/lib/haiku";
import { socialAiAssessorAgent, type SocialAiAssessorInput } from "../src/agents/social-ai-assessor";
import { evidenceAssemblerAgent, type EvidenceAssemblerInput } from "../src/agents/evidence-assembler";
import { classifySector } from "../src/lib/brand-enricher";
import { generateHoneypotSite } from "../src/honeypot-generator";
import { callAnthropic } from "../src/lib/anthropic";

// ─── Fake D1 ─────────────────────────────────────────────────────

interface LedgerRow {
  agent_id: string;
  run_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

function makeFakeDb() {
  const rows: LedgerRow[] = [];
  // Phase 5.1: BudgetManager.recordCost now also UPSERTs an
  // agent_budget_rollups row inside the same db.batch(). The fake
  // db tracks rollups too so the gate's getAgentMonthlyTokens()
  // returns realistic numbers in tests that drive a full call cycle.
  const rollups = new Map<string, { tokens: number; cost: number; calls: number }>();

  function captureLedger(args: readonly unknown[]) {
    rows.push({
      agent_id: String(args[1]),
      run_id: args[2] == null ? null : String(args[2]),
      model: String(args[3]),
      input_tokens: Number(args[4]),
      output_tokens: Number(args[5]),
      cost_usd: Number(args[6]),
    });
  }
  function captureRollup(args: readonly unknown[]) {
    const agentId = String(args[0]);
    const inTok = Number(args[1] ?? 0);
    const outTok = Number(args[2] ?? 0);
    const cost = Number(args[3] ?? 0);
    const prev = rollups.get(agentId) ?? { tokens: 0, cost: 0, calls: 0 };
    rollups.set(agentId, {
      tokens: prev.tokens + inTok + outTok,
      cost: prev.cost + cost,
      calls: prev.calls + 1,
    });
  }

  const stmt = (sql: string, args: readonly unknown[] = []) => ({
    bind: (...nextArgs: unknown[]) => stmt(sql, nextArgs),
    run: async () => {
      if (/INSERT INTO budget_ledger/i.test(sql)) captureLedger(args);
      else if (/INSERT INTO agent_budget_rollups/i.test(sql)) captureRollup(args);
      return { meta: {} };
    },
    first: async () => {
      // Per-agent monthly tokens lookup used by the gate.
      if (/FROM agent_budget_rollups/i.test(sql) && /agent_id = \?/.test(sql)) {
        const agentId = String(args[0]);
        const r = rollups.get(agentId);
        return r ? { tokens: r.tokens } : null;
      }
      return null;
    },
    all: async () => ({ results: [] }),
  });

  const db = {
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      // D1 batch — sequential per Cloudflare semantics; the fake just
      // fires .run() on each.
      for (const s of statements) await s.run();
      return statements.map(() => ({ meta: {} }));
    },
  } as unknown as D1Database;
  return { db, rows, rollups };
}

function makeFakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
}

function makeEnv(db: D1Database) {
  return {
    ANTHROPIC_API_KEY: "sk-ant-test",
    LRX_API_KEY: undefined,
    CF_ACCOUNT_ID: undefined,
    DB: db,
    CACHE: makeFakeKv(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildJsonReply(jsonString: string, model = "claude-haiku-4-5-20251001", inputTokens = 100, outputTokens = 50) {
  return {
    id: "msg_test",
    model,
    stop_reason: "end_turn",
    content: [{ type: "text", text: jsonString }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function buildTextReply(text: string, model = "claude-haiku-4-5-20251001", inputTokens = 100, outputTokens = 50) {
  return {
    id: "msg_test",
    model,
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("budget_ledger coverage — every migrated surface lands a row", () => {
  let fetchSpy: Mock;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("haiku.ts classifyThreat writes a ledger row attributed to the caller's agentId", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        buildJsonReply(
          '{"threat_type":"phishing","confidence":92,"severity":"high","reasoning":"x","ioc_indicators":[]}',
          "claude-haiku-4-5-20251001",
          400,
          120,
        ),
      ),
    );

    const { db, rows } = makeFakeDb();
    const result = await classifyThreat(
      makeEnv(db) as never,
      { agentId: "sentinel", runId: "run-1" },
      { malicious_domain: "evil.example", source_feed: "phishtank" },
    );

    expect(result.success).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("sentinel");
    expect(rows[0]!.run_id).toBe("run-1");
    expect(rows[0]!.model).toBe("claude-haiku-4-5-20251001");
    expect(rows[0]!.cost_usd).toBeGreaterThan(0);
  });

  it("haiku.ts callHaikuRaw writes a ledger row with caller-provided agentId/runId", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(buildTextReply("YES")),
    );

    const { db, rows } = makeFakeDb();
    const result = await callHaikuRaw(
      makeEnv(db) as never,
      { agentId: "brand-deep-scan", runId: null },
      "Reply YES or NO.",
      "Is this brand impersonation?",
    );

    expect(result.success).toBe(true);
    expect(result.text).toBe("YES");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("brand-deep-scan");
    expect(rows[0]!.run_id).toBeNull();
    expect(rows[0]!.cost_usd).toBeGreaterThan(0);
  });

  it("agents/social-ai-assessor writes a ledger row with agentId='social_ai_assessor'", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        buildJsonReply(
          '{"classification":"impersonation","confidence":0.9,"action":"takedown","reasoning":"clearly fake — handle squats the official acme namespace and bio claims partnership","evidence_draft":"draft","signals":[],"cross_correlations":[]}',
        ),
      ),
    );

    const input: SocialAiAssessorInput = {
      brandName: "Acme",
      brandDomain: "acme.com",
      brandAliases: [],
      brandKeywords: [],
      officialHandles: {},
      platform: "twitter",
      handle: "acme_official_real",
      profileUrl: "https://twitter.com/acme_official_real",
      displayName: "Acme",
      bio: "we are acme",
      followersCount: 12,
      verified: false,
      accountCreated: null,
      existingThreats: [],
      emailSecurityGrade: null,
      activeCampaigns: [],
      lookalikeDomainsFound: 0,
      otherImpersonationProfiles: 0,
    };

    const { db, rows } = makeFakeDb();
    const result = await socialAiAssessorAgent.execute({
      env: makeEnv(db) as never,
      runId: "run-social-1",
      agentName: "social_ai_assessor",
      input: input as unknown as Record<string, unknown>,
      triggeredBy: null,
    });

    const output = result.output as { classification: string };
    expect(output.classification).toBe("impersonation");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("social_ai_assessor");
    expect(rows[0]!.run_id).toBe("run-social-1");
    expect(rows[0]!.cost_usd).toBeGreaterThan(0);
  });

  it("lib/brand-enricher.classifySector writes a ledger row with agentId='brand-enricher'", async () => {
    // First fetch is the website title fetch (best-effort, can fail).
    // Second fetch is the Anthropic call. Make the first throw so we
    // skip the title fetch path entirely, then return a clean sector.
    fetchSpy.mockRejectedValueOnce(new Error("title fetch unavailable"));
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildTextReply("finance", "claude-haiku-4-5-20251001", 80, 5)));

    const { db, rows } = makeFakeDb();
    const sector = await classifySector(makeEnv(db) as never, "examplebank.com", "Example Bank");

    expect(sector).toBe("finance");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("brand-enricher");
    expect(rows[0]!.run_id).toBeNull();
    expect(rows[0]!.cost_usd).toBeGreaterThan(0);
  });

  it("honeypot-generator writes THREE ledger rows (index + contact + team) with agentId='honeypot-generator'", async () => {
    // honeypot-generator dispatches the three Haiku calls via Promise.all.
    // Each call awaits crypto.subtle.digest (idempotency key) before reaching
    // fetch, so the order the three fetch invocations consume the mock queue
    // is non-deterministic. Route by inspecting the user message — the
    // prompts contain "MAIN PAGE", "CONTACT PAGE", and "TEAM PAGE" markers.
    fetchSpy.mockImplementation(async (_input: unknown, init?: { body?: string }) => {
      const body = init?.body ?? "";
      let text = "<!DOCTYPE html><html>unknown</html>";
      if (body.includes("MAIN PAGE"))         text = "<!DOCTYPE html><html>index</html>";
      else if (body.includes("CONTACT PAGE")) text = "<!DOCTYPE html><html>contact</html>";
      else if (body.includes("TEAM/STAFF"))   text = "<!DOCTYPE html><html>team</html>";
      return jsonResponse(buildTextReply(text));
    });

    const { db, rows } = makeFakeDb();
    const out = await generateHoneypotSite(makeEnv(db) as never, {
      hostname: "novaridge.example",
      businessName: "Novaridge",
      businessType: "consulting",
      city: "Vancouver, BC",
      trapAddresses: [{ address: "info@novaridge.example", role: "Info" }],
      teamMembers: [{ name: "Sarah Chen", title: "MD", email: "info@novaridge.example" }],
    });

    expect(out.index).toContain("index");
    expect(out.contact).toContain("contact");
    expect(out.team).toContain("team");

    // One row per generated page — three pages, three rows.
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.agent_id).toBe("honeypot-generator");
      expect(row.cost_usd).toBeGreaterThan(0);
    }
  });

  it("canonical wrapper accepts arbitrary agentId and writes one row per call (regression for the wrapper contract)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(buildTextReply("ok", "claude-sonnet-4-5-20250929", 1000, 200)));

    const { db, rows } = makeFakeDb();
    const response = await callAnthropic(makeEnv(db), {
      agentId: "ai-attribution",
      runId: null,
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 64,
    });

    expect(response.usage.input_tokens).toBe(1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("ai-attribution");
    expect(rows[0]!.model).toBe("claude-sonnet-4-5-20250929");
    // Sonnet 4.5: $3 in / $15 out per M tokens.
    // 1000 in → $0.003, 200 out → $0.003, total → $0.006
    expect(rows[0]!.cost_usd).toBeCloseTo(0.006, 6);
  });

  it("agents/evidence-assembler writes a ledger row with agentId='evidence_assembler'", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        buildJsonReply(
          JSON.stringify({
            target_summary:
              "The reported account is impersonating Acme on Twitter using a near-identical handle and copied profile photo to harvest customer credentials.",
            brand_impact:
              "End-users redirected to phishing pages believing they're contacting Acme support; trust loss + credential harvest hits the bank's customers directly.",
            technical_evidence:
              "Profile created 2026-04-12, hosted IPs trace to AS39501 (known phishing infrastructure), threat-feed signals: 14 active phishing URLs cross-referencing the lookalike domain.",
            recommended_action:
              "File abuse report with Twitter under impersonation policy; request immediate suspension and preservation of activity logs.",
            provider_submission_draft:
              "Subject: Brand-impersonation takedown — @acme_official_real on Twitter. Hello, Averrow has confirmed the account in question is impersonating our customer Acme. Evidence is available on request. Please remove the account under your impersonation policy.",
          }),
        ),
      ),
    );

    const input: EvidenceAssemblerInput = {
      takedownId: "td-test-1",
      targetType: "social_account",
      targetValue: "@acme_official_real",
      targetPlatform: "twitter",
      targetUrl: "https://twitter.com/acme_official_real",
      brandJson: JSON.stringify({ name: "Acme", canonical_domain: "acme.com" }),
      relatedThreatsJson: JSON.stringify([{ type: "phishing", count: 14 }]),
      urlScanJson: JSON.stringify("None"),
      socialProfileJson: JSON.stringify({ platform: "twitter", handle: "acme_official_real" }),
      whoisJson: JSON.stringify({ asn: "AS39501" }),
      existingEvidenceJson: JSON.stringify([]),
      providerJson: JSON.stringify({ provider_name: "twitter" }),
    };

    const { db, rows } = makeFakeDb();
    const result = await evidenceAssemblerAgent.execute({
      env: makeEnv(db) as never,
      runId: "run-evidence-1",
      agentName: "evidence_assembler",
      input: input as unknown as Record<string, unknown>,
      triggeredBy: null,
    });

    const output = result.output as { aiSucceeded: boolean; targetSummary: string };
    expect(output.aiSucceeded).toBe(true);
    expect(output.targetSummary.length).toBeGreaterThan(20);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("evidence_assembler");
    expect(rows[0]!.run_id).toBe("run-evidence-1");
    expect(rows[0]!.cost_usd).toBeGreaterThan(0);
  });
});

// ─── Phase 5.1 — per-agent budget enforcement gate ──────────────

describe("checkAgentBudget — Phase 5.1 pre-flight enforcement", () => {
  beforeEach(() => {
    // Fresh fetch spy each test — same shape the suite above uses.
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes through when an agent is registered + under cap", async () => {
    const { checkAgentBudget } = await import("../src/lib/per-agent-budget");
    const { db } = makeFakeDb();
    // public_trust_check has monthlyTokenCap: 1_000_000; the fake's
    // rollup is empty so getAgentMonthlyTokens returns 0.
    const decision = await checkAgentBudget(makeEnv(db) as never, "public_trust_check");
    expect(decision.ok).toBe(true);
  });

  it("rejects exempt agents (cap=0) on any AI call attempt", async () => {
    const { checkAgentBudget } = await import("../src/lib/per-agent-budget");
    const { db } = makeFakeDb();
    // flight_control / cube_healer / navigator / enricher all
    // have monthlyTokenCap: 0 — the call attempt itself is the
    // signal that something regressed.
    const decision = await checkAgentBudget(makeEnv(db) as never, "flight_control");
    expect(decision.ok).toBe(false);
    if (decision.ok === false) {
      expect(decision.reason).toMatch(/exempt/);
    }
  });

  it("rejects agents over their declared monthly token cap", async () => {
    const { checkAgentBudget } = await import("../src/lib/per-agent-budget");
    const { db, rollups } = makeFakeDb();
    // Pre-load the rollup as if public_trust_check has already
    // burned through its 1M token cap.
    rollups.set("public_trust_check", { tokens: 1_500_000, cost: 1.5, calls: 50 });

    const decision = await checkAgentBudget(makeEnv(db) as never, "public_trust_check");
    expect(decision.ok).toBe(false);
    if (decision.ok === false) {
      expect(decision.reason).toMatch(/over monthly token cap/);
      expect(decision.reason).toMatch(/1,500,000/);
    }
  });

  it("passes through unregistered agentIds (legacy kebab attribution)", async () => {
    const { checkAgentBudget } = await import("../src/lib/per-agent-budget");
    const { db } = makeFakeDb();
    // 'admin-classify' (kebab) is no longer in agentModules; the
    // gate should not enforce a cap on it.
    const decision = await checkAgentBudget(makeEnv(db) as never, "admin-classify");
    expect(decision.ok).toBe(true);
  });

  it("recordCost UPSERT updates the rollup so subsequent gate reads see new total", async () => {
    const { db, rollups } = makeFakeDb();
    const { BudgetManager } = await import("../src/lib/budgetManager");
    const budget = new BudgetManager(db);

    await budget.recordCost("public_trust_check", "run-1", "claude-haiku-4-5-20251001", 10_000, 5_000);
    await budget.recordCost("public_trust_check", "run-2", "claude-haiku-4-5-20251001", 20_000, 10_000);

    const r = rollups.get("public_trust_check");
    expect(r?.tokens).toBe(45_000);
    expect(r?.calls).toBe(2);
    // public_trust_check cap is 1M tokens — should still pass.
    const { checkAgentBudget } = await import("../src/lib/per-agent-budget");
    const decision = await checkAgentBudget(makeEnv(db) as never, "public_trust_check");
    expect(decision.ok).toBe(true);
  });
});
