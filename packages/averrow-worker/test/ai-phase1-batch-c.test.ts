/**
 * AI Strategy Phase 1 — Batch C (docs/AI_STRATEGY_2026-10.md #6, #8, #10, #13).
 *
 *   * attributor       — no AI; still stamps attribution_attempted_at and
 *                        runs the OTX → cluster inheritance; the actor-name
 *                        hint never attributes.
 *   * strategist       — the "coordinated campaigns" Haiku block is gone.
 *   * seed_strategist  — rule-based recommendations, no AI, no inserts.
 *   * narrator         — severity + alert gate come from rules.
 *
 * DB-backed lanes run against a REAL SQLite instance whose schema is derived
 * from migrations/ (sqlite-d1-harness), so a query naming a column that does
 * not exist fails here instead of in production. `fetch` is stubbed and every
 * Anthropic-bound request is recorded; the assertions require zero.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";
import type { AgentContext } from "../src/lib/agentRunner";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { attributorAgent, clusterHasActorHint, buildActorNeedles } from "../src/agents/attributor";
import { strategistAgent } from "../src/agents/strategist";
import {
  seedStrategistAgent,
  buildSeedRecommendations,
  median,
  seedStrategistSeverity,
} from "../src/agents/seed-strategist";
import {
  computeNarrativeSeverity,
  shouldCreateNarrativeAlert,
  hasActiveCriticalThreat,
  generateNarrativesForBrand,
  isDuplicateNarrativeAlert,
  type NarrativeContext,
  type NarrativeThreatRow,
} from "../src/agents/narrator";
import { handleAttributionBacklog } from "../src/handlers/admin/attribution";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ─── fetch stub: records every outbound request ──────────────────────

interface FetchSpy {
  urls: string[];
  anthropic: string[];
}

function installFetchSpy(): FetchSpy {
  const spy: FetchSpy = { urls: [], anthropic: [] };
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    spy.urls.push(url);
    const host = new URL(url).hostname;
    if (host === "api.anthropic.com" || host === "gateway.ai.cloudflare.com") {
      spy.anthropic.push(url);
      // Simulate the real outage shape so a regression is loud, not silent.
      return new Response(
        '{"type":"error","error":{"type":"invalid_request_error","message":"credit balance too low"}}',
        { status: 400 },
      );
    }
    throw new Error(`unexpected egress: ${url}`);
  }) as unknown as typeof fetch;
  return spy;
}

const realFetch = globalThis.fetch;

function makeEnv(raw: SqliteDb): Env {
  return { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
}

function makeCtx(env: Env, agentName: string): AgentContext {
  return { env, runId: `run_${agentName}`, agentName, input: {}, triggeredBy: null };
}

const BUDGET_TABLES = ["budget_ledger", "budget_config", "agent_budget_rollups"];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
// ATTRIBUTOR
// ═══════════════════════════════════════════════════════════════════

describe("clusterHasActorHint (ranking hint only)", () => {
  const needles = buildActorNeedles([
    { name: "Lazarus Group", aliases: '["Hidden Cobra","APT38"]' },
    { name: "FIN7", aliases: "Carbanak, Navigator" },
    { name: "Panda", aliases: null }, // stopword — dropped
  ]);

  it("builds lowercased needles, drops short tokens and stopwords", () => {
    expect(needles).toContain("lazarus group");
    expect(needles).toContain("hidden cobra");
    expect(needles).toContain("apt38");
    expect(needles).toContain("carbanak");
    expect(needles).toContain("navigator");
    expect(needles).toContain("fin7");
    expect(needles).not.toContain("panda");
  });

  it("matches a needle in any free-text field, case-insensitively", () => {
    expect(clusterHasActorHint({ cluster_name: null, agent_notes: "dev: HIDDEN COBRA LLC", nexus_brief: null }, needles)).toBe(true);
    expect(clusterHasActorHint({ cluster_name: "carbanak-kit", agent_notes: null, nexus_brief: null }, needles)).toBe(true);
  });

  it("is false with no match or empty text", () => {
    expect(clusterHasActorHint({ cluster_name: "AS1234 phishing", agent_notes: null, nexus_brief: null }, needles)).toBe(false);
    expect(clusterHasActorHint({ cluster_name: null, agent_notes: null, nexus_brief: null }, needles)).toBe(false);
  });

  it("attributor source never names actors from text (no upsert / recordAttribution / AI)", () => {
    const s = src("../src/agents/attributor.ts");
    // Strip comments so the header's prose about the removed path doesn't count.
    const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/upsertActorByName/);
    expect(code).not.toMatch(/recordAttribution/);
    expect(code).not.toMatch(/callHaiku|callAnthropic|checkCostGuard/);
    expect(code).not.toMatch(/SET\s+actor_id/i);
  });
});

const ATTRIBUTOR_TABLES = ["infrastructure_clusters", "threats", "threat_attributions", "threat_actors"];

describe.skipIf(!hasSqlite())("attributor run (real SQLite)", () => {
  let raw: SqliteDb;
  let spy: FetchSpy;

  beforeEach(() => {
    raw = openDerivedDb(ATTRIBUTOR_TABLES);
    spy = installFetchSpy();
    raw.exec(`INSERT INTO threat_actors (id, name, aliases, status) VALUES ('act_laz', 'Lazarus Group', '["Hidden Cobra"]', 'active')`);
    // c_otx: one member OTX-attributed to Lazarus, one sibling un-attributed.
    raw.exec(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status) VALUES ('c_otx', 'AS9009 cluster', 2, 'active')`);
    // c_hint: free text names an actor (attacker-controlled), no OTX evidence.
    raw.exec(`INSERT INTO infrastructure_clusters (id, cluster_name, agent_notes, threat_count, status) VALUES ('c_hint', 'Lazarus Group apps', 'developer_name=Lazarus Group', 5, 'active')`);
    raw.exec(`INSERT INTO threats (id, source_feed, threat_type, status, cluster_id) VALUES ('t1','otx','phishing','active','c_otx')`);
    raw.exec(`INSERT INTO threats (id, source_feed, threat_type, status, cluster_id) VALUES ('t2','feedx','phishing','active','c_otx')`);
    raw.exec(`INSERT INTO threats (id, source_feed, threat_type, status, cluster_id) VALUES ('t3','appstore','phishing','active','c_hint')`);
    raw.exec(`INSERT INTO threat_attributions (id, threat_id, actor_id, source, confidence) VALUES ('tat_otx_t1', 't1', 'act_laz', 'otx', 'medium')`);
  });

  it("makes zero fetches, stamps attempts, and still applies OTX inheritance", async () => {
    const env = makeEnv(raw);
    const result = await attributorAgent.execute(makeCtx(env, "attributor"));

    expect(spy.urls).toEqual([]);
    expect(spy.anthropic).toEqual([]);

    const stamped = raw.prepare(
      `SELECT id FROM infrastructure_clusters WHERE attribution_attempted_at IS NOT NULL ORDER BY id`,
    ).all() as Array<{ id: string }>;
    expect(stamped.map((r) => r.id)).toEqual(["c_hint", "c_otx"]);

    // OTX inheritance onto sibling t2.
    const inherited = raw.prepare(
      `SELECT threat_id, actor_id FROM threat_attributions WHERE id LIKE 'tat_otxinherit_%'`,
    ).all() as Array<{ threat_id: string; actor_id: string }>;
    expect(inherited).toEqual([{ threat_id: "t2", actor_id: "act_laz" }]);
    const otxCluster = raw.prepare(`SELECT actor_id FROM infrastructure_clusters WHERE id = 'c_otx'`).all() as Array<{ actor_id: string | null }>;
    expect(otxCluster[0]!.actor_id).toBe("act_laz");

    expect((result.output as { otx_inheritance: { members_attributed: number } }).otx_inheritance.members_attributed).toBe(1);
  });

  it("an actor-name hint in cluster text never results in an attribution", async () => {
    const env = makeEnv(raw);
    await attributorAgent.execute(makeCtx(env, "attributor"));

    const hintCluster = raw.prepare(`SELECT actor_id FROM infrastructure_clusters WHERE id = 'c_hint'`).all() as Array<{ actor_id: string | null }>;
    expect(hintCluster[0]!.actor_id).toBeNull();
    const rows = raw.prepare(`SELECT id FROM threat_attributions WHERE threat_id = 't3'`).all();
    expect(rows).toEqual([]);
    // No actor rows minted.
    const actors = raw.prepare(`SELECT id FROM threat_actors`).all();
    expect(actors).toHaveLength(1);
  });

  it("Attribution Backlog ranks hinted clusters first and flags them", async () => {
    // KNOWN SCHEMA GAP: the backlog handler (pre-existing) SELECTs
    // `nexus_brief`, which no migration declares — `infrastructure_clusters`
    // predates migrations (0136 is CREATE TABLE IF NOT EXISTS) and the
    // column is assumed to exist in production from that earlier schema.
    // Added here to mirror production; flagged for a follow-up migration.
    raw.exec(`ALTER TABLE infrastructure_clusters ADD COLUMN nexus_brief TEXT`);
    const env = makeEnv(raw);
    // Bigger, un-hinted cluster that would otherwise sort first.
    raw.exec(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status) VALUES ('c_big', 'AS1 generic', 999, 'active')`);
    const res = await handleAttributionBacklog(new Request("https://x/api/admin/agents/attribution-backlog"), env);
    const body = await res.json() as { error?: string; data: { items: Array<{ id: string; actor_hint: boolean }> } };
    expect(body.error).toBeUndefined();
    expect(body.data.items[0]).toMatchObject({ id: "c_hint", actor_hint: true });
    expect(body.data.items.find((i) => i.id === "c_big")?.actor_hint).toBe(false);
    // Read-only: ranking never attributes.
    const hint = raw.prepare(`SELECT actor_id FROM infrastructure_clusters WHERE id = 'c_hint'`).all() as Array<{ actor_id: string | null }>;
    expect(hint[0]!.actor_id).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// STRATEGIST — coordination block removed
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!hasSqlite())("strategist coordination detection is gone", () => {
  it("source no longer carries the coordination prompt", () => {
    const s = src("../src/agents/strategist.ts");
    expect(s).not.toMatch(/callHaikuRaw/);
    expect(s).not.toMatch(/detect coordinated phishing/i);
    expect(s).not.toMatch(/Coordinated Attack Detected/);
  });

  it("a run with >= 5 active campaigns and nothing to name makes no Anthropic request", async () => {
    const raw = openDerivedDb(["campaigns", "threats", "brands", "hosting_providers", ...BUDGET_TABLES]);
    for (let i = 0; i < 6; i++) {
      raw.exec(`INSERT INTO campaigns (id, name, status, threat_count) VALUES ('camp${i}', 'Named Campaign ${i}', 'active', ${10 + i})`);
    }
    const spy = installFetchSpy();
    const result = await strategistAgent.execute(makeCtx(makeEnv(raw), "strategist"));
    expect(spy.anthropic).toEqual([]);
    expect(spy.urls).toEqual([]);
    expect((result.agentOutputs ?? []).some((o) => o.summary.includes("Coordinated"))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SEED STRATEGIST
// ═══════════════════════════════════════════════════════════════════

describe("seed-strategist rules (pure)", () => {
  it("median handles odd/even/empty", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("R1 keeps >= 10 active threats, top 10 by count", () => {
    const brands = Array.from({ length: 14 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, active_threat_count: 5 + i }));
    const items = buildSeedRecommendations({ uncoveredBrands: brands, channels: [], activeCampaigns: [] });
    expect(items).toHaveLength(9); // counts 10..18
    expect(items[0]).toMatchObject({ rule: "seed_brand", brand_id: "b13", active_threat_count: 18 });
  });

  it("R2 flags channels with >= 10 active seeds and zero 7d captures", () => {
    const items = buildSeedRecommendations({
      uncoveredBrands: [],
      channels: [
        { channel: "paste", active_seeds: 12, captures_7d: 0 },
        { channel: "spider", active_seeds: 12, captures_7d: 3 },
        { channel: "honeypot", active_seeds: 9, captures_7d: 0 },
      ],
      activeCampaigns: [],
    });
    expect(items).toEqual([{ rule: "review_channel", channel: "paste", active_seeds: 12, captures_7d: 0 }]);
  });

  it("R3 flags campaigns >= 2x median catch rate with >= 3 addresses", () => {
    const camp = (id: number, catches: number, seeded: number) =>
      ({ id, name: `c${id}`, channel: "paste", total_catches: catches, addresses_seeded: seeded });
    const items = buildSeedRecommendations({
      uncoveredBrands: [],
      channels: [],
      // rates: 1, 1, 1, 4 (seeded 2 — excluded from median AND output), 3
      // → median over the eligible set [1, 1, 1, 3] = 1
      activeCampaigns: [camp(1, 3, 3), camp(2, 3, 3), camp(3, 3, 3), camp(4, 8, 2), camp(5, 9, 3)],
    });
    expect(items.map((i) => i.rule === "expand_campaign" && i.campaign_id)).toEqual([5]);
  });

  it("R3 never recommends a zero-yield campaign when the median is 0", () => {
    const items = buildSeedRecommendations({
      uncoveredBrands: [],
      channels: [],
      activeCampaigns: [
        { id: 1, name: "a", channel: "paste", total_catches: 0, addresses_seeded: 5 },
        { id: 2, name: "b", channel: "paste", total_catches: 0, addresses_seeded: 5 },
      ],
    });
    expect(items).toEqual([]);
  });

  it("R3 median ignores zero-yield and tiny campaigns", () => {
    const camp = (id: number, catches: number, seeded: number) =>
      ({ id, name: `c${id}`, channel: "paste", total_catches: catches, addresses_seeded: seeded });
    // Eligible rates: 1, 1, 3 → median 1 → threshold 2 → only #3.
    // Under an all-campaigns median the four zero-yield rows would pull
    // the median to 0 and flag every catching campaign.
    const items = buildSeedRecommendations({
      uncoveredBrands: [],
      channels: [],
      activeCampaigns: [
        camp(1, 3, 3), camp(2, 3, 3), camp(3, 9, 3),
        camp(4, 0, 5), camp(5, 0, 5), camp(6, 0, 5), camp(7, 0, 5),
        camp(8, 50, 1),
      ],
    });
    expect(items.map((i) => i.rule === "expand_campaign" && i.campaign_id)).toEqual([3]);
    expect(items[0]).toMatchObject({ median_catch_rate: 1 });
  });

  it("severity is medium only when active seeds caught nothing in 7d", () => {
    expect(seedStrategistSeverity(0, 5)).toBe("medium");
    expect(seedStrategistSeverity(0, 0)).toBe("info");
    expect(seedStrategistSeverity(3, 5)).toBe("info");
  });
});

const SEED_TABLES = ["brands", "seed_addresses", "seed_campaigns", "spam_trap_captures"];

describe.skipIf(!hasSqlite())("seed-strategist run (real SQLite)", () => {
  let raw: SqliteDb;
  let spy: FetchSpy;

  beforeEach(() => {
    raw = openDerivedDb(SEED_TABLES);
    spy = installFetchSpy();
    // R1: monitored, 20 active threats, uncovered → recommended.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count, monitoring_status) VALUES ('b_mon', 'Mon', 'mon.example', 'monitored', 20, 'inactive')`);
    // Tracked tier — excluded even with threats / monitoring_status='active'.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count, monitoring_status) VALUES ('b_trk', 'Trk', 'trk.example', 'tracked', 50, 'active')`);
    // Monitored but already has an active brand seed → excluded.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count) VALUES ('b_seeded', 'Seeded', 'seeded.example', 'monitored', 40)`);
    raw.exec(`INSERT INTO seed_addresses (address, domain, channel, brand_target, status) VALUES ('seeded-support@averrow.com', 'averrow.com', 'brand', 'b_seeded', 'active')`);
    // Monitored but caught in 30d → excluded.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count) VALUES ('b_caught', 'Caught', 'caught.example', 'customer', 30)`);
    raw.exec(`INSERT INTO spam_trap_captures (trap_address, trap_domain, spoofed_brand_id, captured_at) VALUES ('x@averrow.com', 'averrow.com', 'b_caught', datetime('now', '-10 days'))`);
    // R2: 10 active paste seeds, no captures.
    for (let i = 0; i < 10; i++) {
      raw.exec(`INSERT INTO seed_addresses (address, domain, channel, status) VALUES ('p${i}@averrow.com', 'averrow.com', 'paste', 'active')`);
    }
    // Stale-dead seed → pruned.
    raw.exec(`INSERT INTO seed_addresses (address, domain, channel, status, total_catches, seeded_at) VALUES ('old@averrow.com', 'averrow.com', 'generic', 'active', 0, datetime('now', '-90 days'))`);
    // R3: campaigns.
    raw.exec(`INSERT INTO seed_campaigns (name, channel, status, total_catches, addresses_seeded) VALUES ('low1', 'paste', 'active', 1, 3)`);
    raw.exec(`INSERT INTO seed_campaigns (name, channel, status, total_catches, addresses_seeded) VALUES ('low2', 'paste', 'active', 1, 3)`);
    raw.exec(`INSERT INTO seed_campaigns (name, channel, status, total_catches, addresses_seeded) VALUES ('star', 'paste', 'active', 30, 3)`);
  });

  it("emits { recommendations, retired, items } with no AI and no inserts", async () => {
    const seedRowsBefore = (raw.prepare(`SELECT COUNT(*) AS n FROM seed_addresses`).all() as Array<{ n: number }>)[0]!.n;
    const campaignsBefore = (raw.prepare(`SELECT COUNT(*) AS n FROM seed_campaigns`).all() as Array<{ n: number }>)[0]!.n;

    const result = await seedStrategistAgent.execute(makeCtx(makeEnv(raw), "seed_strategist"));

    expect(spy.urls).toEqual([]);
    expect(spy.anthropic).toEqual([]);

    const insight = (result.agentOutputs ?? []).find((o) => o.type === "insight");
    expect(insight).toBeDefined();
    const details = insight!.details as {
      recommendations: number;
      retired: number;
      items: Array<Record<string, unknown>>;
    };
    expect(details.retired).toBe(1);
    expect(details.recommendations).toBe(details.items.length);
    expect(details.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "seed_brand", brand_id: "b_mon" }),
      expect.objectContaining({ rule: "review_channel", channel: "paste" }),
      expect.objectContaining({ rule: "expand_campaign", campaign_name: "star" }),
    ]));
    const brandIds = details.items.filter((i) => i.rule === "seed_brand").map((i) => i.brand_id);
    expect(brandIds).toEqual(["b_mon"]);
    expect(details.recommendations).toBe(3);

    // Zero 7d captures with active seeds → medium.
    expect(insight!.severity).toBe("medium");

    // Auto-seeder is the sole creator — nothing inserted.
    const seedRowsAfter = (raw.prepare(`SELECT COUNT(*) AS n FROM seed_addresses`).all() as Array<{ n: number }>)[0]!.n;
    const campaignsAfter = (raw.prepare(`SELECT COUNT(*) AS n FROM seed_campaigns`).all() as Array<{ n: number }>)[0]!.n;
    expect(seedRowsAfter).toBe(seedRowsBefore);
    expect(campaignsAfter).toBe(campaignsBefore);
  });

  it("severity is info when the traps caught something in 7d", async () => {
    raw.exec(`INSERT INTO spam_trap_captures (trap_address, trap_domain, captured_at) VALUES ('p0@averrow.com', 'averrow.com', datetime('now', '-1 day'))`);
    const result = await seedStrategistAgent.execute(makeCtx(makeEnv(raw), "seed_strategist"));
    const insight = (result.agentOutputs ?? []).find((o) => o.type === "insight");
    expect(insight!.severity).toBe("info");
    // paste channel caught → no review_channel item.
    const details = insight!.details as { items: Array<{ rule: string }> };
    expect(details.items.some((i) => i.rule === "review_channel")).toBe(false);
  });

  it("R1 semantics: stale captures / retired seeds do not count as coverage; multiple rows don't duplicate", async () => {
    // Capture OUTSIDE the 30d window → still uncovered.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count) VALUES ('b_old', 'Old', 'old.example', 'monitored', 25)`);
    raw.exec(`INSERT INTO spam_trap_captures (trap_address, trap_domain, spoofed_brand_id, captured_at) VALUES ('y@averrow.com', 'averrow.com', 'b_old', datetime('now', '-40 days'))`);
    // Only a RETIRED seed targets it → still uncovered.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count) VALUES ('b_ret', 'Ret', 'ret.example', 'monitored', 15)`);
    raw.exec(`INSERT INTO seed_addresses (address, domain, channel, brand_target, status) VALUES ('ret-support@averrow.com', 'averrow.com', 'brand', 'b_ret', 'retired')`);
    // Many captures AND many active seeds → covered, and must not blow up
    // into a cross product or duplicate rows.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count) VALUES ('b_busy', 'Busy', 'busy.example', 'monitored', 90)`);
    for (let i = 0; i < 3; i++) {
      raw.exec(`INSERT INTO spam_trap_captures (trap_address, trap_domain, spoofed_brand_id, captured_at) VALUES ('z${i}@averrow.com', 'averrow.com', 'b_busy', datetime('now', '-1 day'))`);
      raw.exec(`INSERT INTO seed_addresses (address, domain, channel, brand_target, status) VALUES ('busy${i}@averrow.com', 'averrow.com', 'brand', 'b_busy', 'active')`);
    }
    // Below the threshold → excluded.
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, active_threat_count) VALUES ('b_low', 'Low', 'low.example', 'monitored', 9)`);

    const result = await seedStrategistAgent.execute(makeCtx(makeEnv(raw), "seed_strategist"));
    const insight = (result.agentOutputs ?? []).find((o) => o.type === "insight");
    const items = (insight!.details as { items: Array<Record<string, unknown>> }).items;
    const brandIds = items.filter((i) => i.rule === "seed_brand").map((i) => i.brand_id);
    expect(brandIds).toEqual(["b_old", "b_mon", "b_ret"]);
  });

  it("source never filters on monitoring_status and has no AI path", () => {
    const s = src("../src/agents/seed-strategist.ts");
    const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/monitoring_status/);
    expect(code).not.toMatch(/callAnthropic|callHaiku|checkCostGuard/);
    expect(code).not.toMatch(/INSERT INTO (seed_campaigns|seed_addresses|agent_outputs)/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// NARRATOR — rule-based severity
// ═══════════════════════════════════════════════════════════════════

function threat(severity: string, status = "active", i = 0): NarrativeThreatRow {
  return {
    id: `t${i}`, threat_type: "phishing", malicious_domain: `d${i}.example`, malicious_url: null,
    severity, status, source_feed: "feed", created_at: null,
  };
}

function ctx(over: Partial<NarrativeContext> = {}): NarrativeContext {
  return {
    threats: [], emailSecurity: null, socialFindings: [], lookalikes: [],
    ctCertificates: [], appStoreListings: [], darkWebMentions: [],
    ...over,
  };
}

const many = (n: number, sev = "low", status = "active"): NarrativeThreatRow[] =>
  Array.from({ length: n }, (_, i) => threat(sev, status, i));

describe("computeNarrativeSeverity", () => {
  const cases: Array<[string, NarrativeContext, string[], string]> = [
    ["empty → LOW", ctx(), [], "LOW"],
    ["one high active threat → LOW (2 pts)", ctx({ threats: [threat("high")] }), ["threats"], "LOW"],
    ["one critical active threat → MEDIUM (3)", ctx({ threats: [threat("CRITICAL")] }), ["threats"], "MEDIUM"],
    ["critical but INACTIVE does not count", ctx({ threats: [threat("critical", "down")] }), ["threats"], "LOW"],
    ["50 active low threats → LOW (2)", ctx({ threats: many(50) }), ["threats"], "LOW"],
    ["50 inactive threats score nothing", ctx({ threats: many(50, "low", "remediated") }), ["threats"], "LOW"],
    ["10 active + high → MEDIUM (3)", ctx({ threats: [...many(9), threat("high", "active", 99)] }), ["threats"], "MEDIUM"],
    [
      "50 active incl. critical → HIGH (5)",
      ctx({ threats: [...many(49), threat("critical", "active", 99)] }),
      ["threats"],
      "HIGH",
    ],
    [
      "lookalike mx+web (2) + social 0.85 (2) + 1 extra signal type → HIGH (5)",
      ctx({
        lookalikes: [{ domain: "x", registered: 1, resolves_to: null, has_web: 1, has_mx: 1, first_seen: null }],
        socialFindings: [{ platform: "x", suspicious_account_name: "a", suspicious_account_url: null, impersonation_score: 0.85, status: "active", created_at: null }],
      }),
      ["lookalike_domains", "social_impersonation", "threats"],
      "HIGH",
    ],
    [
      "app store 'Impersonation' (case-insensitive) + dark web 'CONFIRMED' → MEDIUM (4)",
      ctx({
        appStoreListings: [{ store: "ios", app_name: "a", developer_name: null, bundle_id: null, app_url: null, impersonation_score: 0.9, severity: "HIGH", classification: "Impersonation", last_checked: null }],
        darkWebMentions: [{ source: "paste", source_url: null, match_type: null, matched_terms: null, severity: null, classification: "CONFIRMED", first_seen: null, last_seen: null }],
      }),
      ["app_store_impersonation", "dark_web_mention"],
      "MEDIUM",
    ],
    [
      "suspicious-only app/dark/ct + email (4) + 2 extra types → HIGH (6)",
      ctx({
        appStoreListings: [{ store: "ios", app_name: "a", developer_name: null, bundle_id: null, app_url: null, impersonation_score: 0.4, severity: null, classification: "suspicious", last_checked: null }],
        darkWebMentions: [{ source: "paste", source_url: null, match_type: null, matched_terms: null, severity: null, classification: "suspicious", first_seen: null, last_seen: null }],
        ctCertificates: [{ domain: "x", issuer: null, not_before: null, suspicious: 1, san_count: 1 }],
      }),
      ["app_store_impersonation", "dark_web_mention", "ct_certificates", "email_degradation"],
      "HIGH",
    ],
    [
      "social 0.6 → +1 only",
      ctx({ socialFindings: [{ platform: "x", suspicious_account_name: "a", suspicious_account_url: null, impersonation_score: 0.6, status: "active", created_at: null }] }),
      ["social_impersonation"],
      "LOW",
    ],
    [
      "everything maxed → CRITICAL",
      ctx({
        threats: [...many(49), threat("critical", "active", 99)],
        lookalikes: [{ domain: "x", registered: 1, resolves_to: null, has_web: 1, has_mx: 1, first_seen: null }],
      }),
      ["threats", "lookalike_domains", "email_degradation"],
      "CRITICAL", // 3 + 2 + 2 + 1 + 1 = 9
    ],
  ];

  for (const [name, c, signals, expected] of cases) {
    it(name, () => {
      expect(computeNarrativeSeverity(c, signals)).toBe(expected);
    });
  }

  it("score boundaries: 7 → HIGH, 8 → CRITICAL", () => {
    // critical(3) + 50 active(2) + email(1) + 1 extra type (3 types) = 7
    const base = ctx({ threats: [...many(49), threat("critical", "active", 99)] });
    expect(computeNarrativeSeverity(base, ["threats", "email_degradation", "x"])).toBe("HIGH");
    // + one more type → 8
    expect(computeNarrativeSeverity(base, ["threats", "email_degradation", "x", "y"])).toBe("CRITICAL");
  });
});

describe("narrator alert gate", () => {
  it("requires HIGH/CRITICAL", () => {
    expect(shouldCreateNarrativeAlert("MEDIUM", ["a", "b", "c"], true)).toBe(false);
    expect(shouldCreateNarrativeAlert("LOW", ["a", "b"], true)).toBe(false);
  });
  it("requires >= 2 signal types OR an active critical threat", () => {
    expect(shouldCreateNarrativeAlert("HIGH", ["threats"], false)).toBe(false);
    expect(shouldCreateNarrativeAlert("HIGH", ["threats"], true)).toBe(true);
    expect(shouldCreateNarrativeAlert("CRITICAL", ["threats", "lookalike_domains"], false)).toBe(true);
  });
  it("hasActiveCriticalThreat ignores inactive rows and is case-insensitive", () => {
    expect(hasActiveCriticalThreat(ctx({ threats: [threat("critical", "down")] }))).toBe(false);
    expect(hasActiveCriticalThreat(ctx({ threats: [threat("CRITICAL", "Active")] }))).toBe(true);
  });
  it("narrator source no longer reads parsed.severity", () => {
    expect(src("../src/agents/narrator.ts")).not.toMatch(/parsed\.severity/);
  });
});

const NARRATOR_TABLES = [
  "threats", "brands", "social_monitor_results", "lookalike_domains", "ct_certificates",
  "app_store_listings", "dark_web_mentions", "threat_narratives", "alerts", ...BUDGET_TABLES,
];

describe.skipIf(!hasSqlite())("narrator template fallback (real SQLite, AI failing)", () => {
  it("writes a rule-severity narrative from the template and leaves ai_assessment NULL", async () => {
    const raw = openDerivedDb(NARRATOR_TABLES);
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, email_security_grade) VALUES ('b1', 'Acme', 'acme.example', 'monitored', 'F')`);
    for (let i = 0; i < 50; i++) {
      raw.exec(`INSERT INTO threats (id, source_feed, threat_type, malicious_domain, severity, status, target_brand_id, created_at)
                VALUES ('t${i}', 'feed', 'phishing', 'd${i}.example', '${i === 0 ? "critical" : "low"}', 'active', 'b1', datetime('now'))`);
    }
    const spy = installFetchSpy(); // every Anthropic call → HTTP 400
    await generateNarrativesForBrand(makeEnv(raw), "b1");

    const rows = raw.prepare(`SELECT title, summary, narrative, severity, attack_stage, recommendations FROM threat_narratives`).all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    const n = rows[0]!;
    // critical 3 + 50 active 2 + email 1 + 0 extra (2 types) = 6 → HIGH
    expect(n.severity).toBe("HIGH");
    expect(n.attack_stage).toBe("reconnaissance");
    expect(n.title).toContain("Acme");
    expect(n.summary).toContain("HIGH");
    expect(n.recommendations).toBe("[]");

    const alerts = raw.prepare(`SELECT severity, ai_assessment FROM alerts`).all() as Array<{ severity: string; ai_assessment: string | null }>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity.toLowerCase()).toBe("high");
    expect(alerts[0]!.ai_assessment).toBeNull();
    // The prose call was attempted (and failed) — severity didn't depend on it.
    expect(spy.urls.every((u) => /anthropic|gateway\.ai\.cloudflare/.test(u))).toBe(true);
  });
});

describe("narrator alert dedupe (pure)", () => {
  const prior = (severity: string, types: string[]) => ({ severity, signal_types: JSON.stringify(types) });

  it("suppresses the same severity + same signal set", () => {
    expect(isDuplicateNarrativeAlert("HIGH", ["threats", "email_degradation"],
      [prior("high", ["email_degradation", "threats"])])).toBe(true);
  });
  it("suppresses when an open prior was MORE severe", () => {
    expect(isDuplicateNarrativeAlert("HIGH", ["threats"], [prior("critical", ["threats"])])).toBe(true);
  });
  it("alerts on escalation", () => {
    expect(isDuplicateNarrativeAlert("CRITICAL", ["threats"], [prior("high", ["threats"])])).toBe(false);
  });
  it("alerts on a new channel", () => {
    expect(isDuplicateNarrativeAlert("HIGH", ["threats", "lookalike_domains"],
      [prior("high", ["threats", "email_degradation"])])).toBe(false);
  });
  it("alerts with no priors, and treats unparseable details as no coverage", () => {
    expect(isDuplicateNarrativeAlert("HIGH", ["threats"], [])).toBe(false);
    expect(isDuplicateNarrativeAlert("HIGH", ["threats"], [{ severity: "high", signal_types: null }])).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("narrator alert dedupe (real SQLite)", () => {
  function seed(raw: SqliteDb): void {
    raw.exec(`INSERT INTO brands (id, name, canonical_domain, tier, email_security_grade) VALUES ('b1', 'Acme', 'acme.example', 'monitored', 'F')`);
    for (let i = 0; i < 50; i++) {
      raw.exec(`INSERT INTO threats (id, source_feed, threat_type, malicious_domain, severity, status, target_brand_id, created_at)
                VALUES ('t${i}', 'feed', 'phishing', 'd${i}.example', '${i === 0 ? "critical" : "low"}', 'active', 'b1', datetime('now'))`);
    }
  }
  const alertRows = (raw: SqliteDb) =>
    raw.prepare(`SELECT severity, status FROM alerts ORDER BY created_at`).all() as Array<{ severity: string; status: string }>;

  it("does not re-alert within 7d at the same severity + signals", async () => {
    const raw = openDerivedDb(NARRATOR_TABLES);
    seed(raw);
    installFetchSpy();
    const env = makeEnv(raw);
    await generateNarrativesForBrand(env, "b1");
    await generateNarrativesForBrand(env, "b1");
    // Two narratives (the 24h gate lives in the agent loop), ONE alert.
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM threat_narratives`).all() as Array<{ n: number }>)[0]!.n).toBe(2);
    expect(alertRows(raw)).toHaveLength(1);
  });

  it("re-alerts once the prior alert is resolved", async () => {
    const raw = openDerivedDb(NARRATOR_TABLES);
    seed(raw);
    installFetchSpy();
    const env = makeEnv(raw);
    await generateNarrativesForBrand(env, "b1");
    raw.exec(`UPDATE alerts SET status = 'resolved'`);
    await generateNarrativesForBrand(env, "b1");
    expect(alertRows(raw)).toHaveLength(2);
  });

  it("re-alerts on escalation (HIGH -> CRITICAL with a new channel)", async () => {
    const raw = openDerivedDb(NARRATOR_TABLES);
    seed(raw);
    installFetchSpy();
    const env = makeEnv(raw);
    await generateNarrativesForBrand(env, "b1");
    expect(alertRows(raw).map((a) => a.severity.toLowerCase())).toEqual(["high"]);
    // An operational (mail+web) lookalike: +2 points, +1 signal type
    // beyond 2 → 6 + 2 + 1 = 9 → CRITICAL.
    raw.exec(`INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, registered, has_mx, has_web, first_seen)
              VALUES ('l1', 'b1', 'acrne.example', 'replacement', 1, 1, 1, datetime('now'))`);
    await generateNarrativesForBrand(env, "b1");
    expect(alertRows(raw).map((a) => a.severity.toLowerCase())).toEqual(["high", "critical"]);
  });
});
