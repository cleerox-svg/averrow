/**
 * AI_STRATEGY_2026-10 Phase 1 (Batch B): sentinel and cartographer run on
 * rules. Driven end to end through `executeAgent` against a REAL SQLite
 * instance whose schema is derived from migrations/, with `fetch` stubbed
 * to record every outbound request. The property under test is the
 * strongest one available: not one request reaches Anthropic (direct or
 * via the AI Gateway), even with an API key configured and work that the
 * old code would have sent to Haiku.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeAgent } from "../src/lib/agentRunner";
import { sentinelAgent } from "../src/agents/sentinel";
import { cartographerAgent } from "../src/agents/cartographer";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { SENTINEL_TABLES, seedThreats, distinct, MODEL_BOUND } from "./ai-fixtures";

const AI_HOSTS = new Set(["api.anthropic.com", "gateway.ai.cloudflare.com"]);

interface FetchRecorder {
  fn: ReturnType<typeof vi.fn>;
  aiCalls: string[];
  allCalls: string[];
}

/** Records every URL; AI hosts answer 500 so an accidental call is loud, everything else 404s. */
function recordFetch(): FetchRecorder {
  const aiCalls: string[] = [];
  const allCalls: string[] = [];
  const fn = vi.fn(async (input: unknown) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    allCalls.push(url.toString());
    if (AI_HOSTS.has(url.hostname)) {
      aiCalls.push(url.toString());
      return new Response("unexpected AI call", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, aiCalls, allCalls };
}

const quiet = () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
};

describe.skipIf(!hasSqlite())("sentinel — rules only, zero Anthropic requests (real SQLite)", () => {
  let raw: SqliteDb;
  let net: FetchRecorder;

  beforeEach(() => {
    raw = openDerivedDb(SENTINEL_TABLES);
    raw.exec(`INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('sentinel', 'approved', datetime('now'))`);
    net = recordFetch();
    quiet();
  });
  afterEach(() => vi.restoreAllMocks());

  async function run() {
    const env = { DB: d1FromSqlite(raw), CACHE: fakeKv(), ANTHROPIC_API_KEY: "sk-ant-test" } as never;
    const out = await executeAgent(env, sentinelAgent);
    expect(out.runId, "executeAgent refused to run").not.toBe("");
    const summary = (raw
      .prepare(`SELECT summary, severity, details FROM agent_outputs WHERE agent_id = 'sentinel' AND type = 'classification'`)
      .all() as Array<{ summary: string; severity: string; details: string }>)
      .find((r) => "rulesClassified" in (JSON.parse(r.details) as object));
    expect(summary, "no sentinel summary output").toBeDefined();
    return { out, summary: summary!, details: JSON.parse(summary!.details) as Record<string, unknown> };
  }

  it("classifies every threat — including ones the old code sent to Haiku — without a single AI request", async () => {
    // MODEL_BOUND (unknown feed) and unknown-type threats were the AI path before Phase 1.
    seedThreats(raw, [
      ...distinct(12),
      { id: "p1", domain: "kit-zq.net", feed: "phishtank", type: "phishing" },
      { id: "u1", domain: "odd-zq.net", feed: "ct_logs", type: "typosquatting" },
      { id: "s1", domain: "scan-zq.net", feed: "dshield", type: "scanning" },
    ]);
    // (threats.threat_type is NOT NULL with a CHECK that excludes 'unknown',
    // so the −10 unknown-type branch is covered by the pure table test.)

    const { out, summary, details } = await run();

    expect(net.aiCalls).toEqual([]);
    expect(net.allCalls).toEqual([]); // sentinel makes no outbound request at all
    expect(out.status).toBe("success");
    expect(summary.severity).toBe("info");
    expect(summary.summary).toMatch(/rules=15\b/);
    expect(summary.summary).not.toMatch(/haiku=/);
    // Not a counter-instrumented agent any more.
    expect(Object.keys(details).filter((k) => k.startsWith("aiCalls") || k.startsWith("aiFirst"))).toEqual([]);
    expect(details.rulesClassified).toBe(15);

    const rows = raw.prepare(`SELECT id, confidence_score, severity FROM threats ORDER BY id`).all() as Array<{ id: string; confidence_score: number; severity: string }>;
    expect(rows.every((r) => r.confidence_score !== null)).toBe(true);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.u1).toMatchObject({ confidence_score: 50, severity: "medium" });
    expect(byId.s1).toMatchObject({ confidence_score: 60, severity: "low" });
    expect(byId.p1).toMatchObject({ confidence_score: 90, severity: "medium" });
    // site0-zq.net: unknown feed 60 / phishing medium, then the (unchanged)
    // homoglyph rule fires on the "0" → high, +10.
    expect(byId.t0).toMatchObject({ confidence_score: 70, severity: "high" });
  });

  it("persists the credential-path escalation for a brand-attributed threat", async () => {
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, threat_count, first_seen) VALUES ('b1', 'Zorbex', 'zorbex.com', 0, datetime('now'))`);
    raw.exec(`INSERT INTO threats (id, source_feed, threat_type, malicious_domain, malicious_url, target_brand_id, status, created_at)
              VALUES ('c1', 'openphish', 'phishing', 'acct-zq.net', 'https://acct-zq.net/account/verify?x=1', 'b1', 'active', datetime('now')),
                     ('c2', 'openphish', 'phishing', 'other-zq.net', 'https://other-zq.net/account/verify', NULL, 'active', datetime('now'))`);

    const { details } = await run();

    expect(net.aiCalls).toEqual([]);
    expect(details.credentialPathEscalations).toBe(1);
    const sev = Object.fromEntries((raw.prepare(`SELECT id, severity FROM threats`).all() as Array<{ id: string; severity: string }>).map((r) => [r.id, r.severity]));
    expect(sev.c1).toBe("high");
    expect(sev.c2).toBe("medium"); // same path, but no brand match
  });

  it("an empty queue still makes no request and reports cleanly", async () => {
    const { out, summary } = await run();
    expect(net.allCalls).toEqual([]);
    expect(out.status).toBe("success");
    expect(summary.summary).toMatch(/found 0 unclassified threats/);
  });
});

// Tables cartographer's provider-scoring path reads/writes. Anything else
// it touches (email security, DMARC, geopolitical, cubes) is absent and
// answered as empty via the harness's "no such table" swallow.
const CARTOGRAPHER_TABLES = [
  "threats", "hosting_providers", "brands", "provider_threat_stats",
  "agent_runs", "agent_outputs", "agent_configs", "agent_approvals",
  "budget_ledger", "budget_config", "agent_budget_rollups",
];

describe.skipIf(!hasSqlite())("cartographer — heuristic scoring, zero Anthropic requests (real SQLite)", () => {
  let raw: SqliteDb;
  let net: FetchRecorder;

  beforeEach(() => {
    raw = openDerivedDb(CARTOGRAPHER_TABLES);
    raw.exec(`INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('cartographer', 'approved', datetime('now'))`);
    net = recordFetch();
    quiet();
  });
  afterEach(() => vi.restoreAllMocks());

  const provider = (id: string, active: number, total: number, lastScore: number | null, t7 = 0, t30 = 0): void => {
    raw.prepare(
      `INSERT INTO hosting_providers (id, name, asn, active_threat_count, total_threat_count, trend_7d, trend_30d, last_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, `Provider ${id}`, `AS${id.replace(/\D/g, "") || "1"}`, active, total, t7, t30, lastScore);
  };

  async function run() {
    const env = {
      DB: d1FromSqlite(raw, { swallow: (_sql: string, err: Error) => /no such table/i.test(err.message) }),
      CACHE: fakeKv(),
      ANTHROPIC_API_KEY: "sk-ant-test",
    } as never;
    const out = await executeAgent(env, cartographerAgent, {}, "cron", "scheduled");
    expect(out.runId, "executeAgent refused to run").not.toBe("");
    return out;
  }

  it("scores every provider with the heuristic, emits insights only on meaningful change, and never calls AI", async () => {
    provider("hp1", 60, 400, null, 30, 40); // bad, first score → insight
    provider("hp2", 60, 400, 36, 30, 40);   // bad, stable vs last → no insight
    provider("hp3", 3, 3, null);            // good, first score → no insight
    for (let i = 0; i < 4; i++) {
      raw.prepare(
        `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, hosting_provider_id, campaign_id, status, created_at, enriched_at)
         VALUES (?, 'openphish', 'phishing', ?, 'hp1', ?, 'active', datetime('now'), datetime('now'))`,
      ).run(`th${i}`, `d${i}-zq.net`, `camp${i}`);
    }

    const out = await run();

    expect(net.aiCalls).toEqual([]);
    expect(out.status).toBe("success");
    expect(out.result?.degraded).toBeUndefined();

    const scores = Object.fromEntries((raw.prepare(`SELECT id, reputation_score, last_score FROM hosting_providers`).all() as Array<{ id: string; reputation_score: number; last_score: number }>)
      .map((r) => [r.id, r]));
    // hp1: 100 − 30 (active>50) − 10 (total>100) − 15 (4 campaigns) − 10 (surge) = 35
    expect(scores.hp1).toMatchObject({ reputation_score: 35, last_score: 35 });
    // hp2: no campaigns → 100 − 30 − 10 − 10 = 50
    expect(scores.hp2).toMatchObject({ reputation_score: 50, last_score: 50 });
    expect(scores.hp3).toMatchObject({ reputation_score: 90, last_score: 90 });

    const insights = raw.prepare(`SELECT summary, severity, details FROM agent_outputs WHERE agent_id = 'cartographer' AND type = 'insight'`)
      .all() as Array<{ summary: string; severity: string; details: string }>;
    // hp2 moved 36 → 50 (>= 10) so it IS news; hp3 is good.
    expect(insights.map((i) => JSON.parse(i.details).provider).sort()).toEqual(["Provider hp1", "Provider hp2"]);
    const hp1 = insights.find((i) => i.summary.startsWith("Provider hp1"))!;
    expect(hp1.summary).toBe("Provider hp1: reputation 35/100 [REPEAT OFFENDER] — 60 active / 400 total; top types: phishing; 4 campaigns");
    expect(hp1.severity).toBe("high");
    expect(JSON.parse(hp1.details).risk_factors).toEqual(["active_threats_over_50", "total_volume_over_100", "repeat_offender", "surge_7d"]);

    const diag = raw.prepare(`SELECT details FROM agent_outputs WHERE agent_id = 'cartographer' AND type = 'diagnostic'`).all() as Array<{ details: string }>;
    const summaryDetails = diag.map((d) => JSON.parse(d.details) as Record<string, unknown>).find((d) => "provider_insights_emitted" in d);
    expect(summaryDetails).toBeDefined();
    expect(Object.keys(summaryDetails!).filter((k) => k.startsWith("aiCalls"))).toEqual([]);
    expect(summaryDetails!.provider_insights_emitted).toBe(2);
  });

  it("a stable bad provider does not re-announce itself", async () => {
    provider("hp9", 60, 400, 58); // scores 100 − 30 − 10 = 60; last 58 → delta 2, no crossing

    await run();

    expect(net.aiCalls).toEqual([]);
    const insights = raw.prepare(`SELECT 1 FROM agent_outputs WHERE agent_id = 'cartographer' AND type = 'insight'`).all();
    expect(insights).toHaveLength(0);
  });
});
