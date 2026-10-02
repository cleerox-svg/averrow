/**
 * Seed Strategist Agent — spam-trap coverage analysis on deterministic rules.
 *
 * Runs daily at 6am UTC (orchestrator hour === 6, alongside the Observer
 * briefing). Prunes stale-dead seeds, gathers trap metrics, and emits
 * rule-based seeding RECOMMENDATIONS. It no longer creates anything:
 * the auto-seeder (`agents/auto-seeder.ts`) is the sole creator of seed
 * campaigns and addresses.
 *
 * AI Strategy Phase 1 (#13, docs/AI_STRATEGY_2026-10.md): the former
 * Haiku "seeding plan" — which auto-inserted AI-invented campaigns and
 * addresses — was replaced with three SQL-backed rules:
 *
 *   R1 seed_brand       — monitored brand (MONITORED_BRAND_PREDICATE_SQL)
 *                         with active_threat_count >= 10, zero trap
 *                         captures in 30d, and no active seed address
 *                         targeting it. Top 10 by active_threat_count.
 *   R2 review_channel   — seed channel with >= 10 active seeds and zero
 *                         captures on those seeds in 7d.
 *   R3 expand_campaign  — active seed campaign with catch_rate >= 2x the
 *                         median catch_rate, a non-zero catch_rate, and
 *                         addresses_seeded >= 3. The median is taken over
 *                         that same eligible set (active, >= 3 addresses,
 *                         catch_rate > 0).
 *
 * The summary `insight` output's `details` carries
 * `{ recommendations, retired, items }` — `handlers/spamTrap.ts`
 * (strategy tab) reads `recommendations` / `retired`.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { MONITORED_BRAND_PREDICATE_SQL } from "../lib/monitored-brands";

// ─── Rule thresholds ────────────────────────────────────────────
export const R1_MIN_ACTIVE_THREATS = 10;
export const R1_LIMIT = 10;
export const R2_MIN_ACTIVE_SEEDS = 10;
export const R3_MIN_ADDRESSES_SEEDED = 3;
export const R3_MEDIAN_MULTIPLIER = 2;

// ─── Rule inputs / outputs ──────────────────────────────────────
export interface UncoveredBrandRow {
  id: string;
  name: string;
  active_threat_count: number;
}

export interface ChannelStatsRow {
  channel: string;
  active_seeds: number;
  captures_7d: number;
}

export interface SeedCampaignRow {
  id: number;
  name: string;
  channel: string;
  total_catches: number;
  addresses_seeded: number;
}

export type SeedRecommendation =
  | { rule: "seed_brand"; brand_id: string; brand_name: string; active_threat_count: number }
  | { rule: "review_channel"; channel: string; active_seeds: number; captures_7d: number }
  | {
      rule: "expand_campaign";
      campaign_id: number;
      campaign_name: string;
      channel: string;
      catch_rate: number;
      median_catch_rate: number;
      addresses_seeded: number;
    };

function catchRate(c: SeedCampaignRow): number {
  return (c.total_catches ?? 0) / Math.max(c.addresses_seeded ?? 0, 1);
}

/** Median of a numeric list; 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Pure rule evaluation. R1 candidates arrive pre-filtered by SQL (the
 * coverage joins are cheapest there); the threshold is re-checked here
 * so the function is self-describing and testable in isolation.
 */
export function buildSeedRecommendations(input: {
  uncoveredBrands: UncoveredBrandRow[];
  channels: ChannelStatsRow[];
  activeCampaigns: SeedCampaignRow[];
}): SeedRecommendation[] {
  const items: SeedRecommendation[] = [];

  // R1 — seed_brand
  const r1 = input.uncoveredBrands
    .filter((b) => (b.active_threat_count ?? 0) >= R1_MIN_ACTIVE_THREATS)
    .sort((a, b) => b.active_threat_count - a.active_threat_count)
    .slice(0, R1_LIMIT);
  for (const b of r1) {
    items.push({
      rule: "seed_brand",
      brand_id: b.id,
      brand_name: b.name,
      active_threat_count: b.active_threat_count,
    });
  }

  // R2 — review_channel
  for (const ch of input.channels) {
    if ((ch.active_seeds ?? 0) >= R2_MIN_ACTIVE_SEEDS && (ch.captures_7d ?? 0) === 0) {
      items.push({
        rule: "review_channel",
        channel: ch.channel,
        active_seeds: ch.active_seeds,
        captures_7d: 0,
      });
    }
  }

  // R3 — expand_campaign. The baseline median is taken over the SAME
  // population a recommendation can come from: active campaigns with
  // >= R3_MIN_ADDRESSES_SEEDED addresses and a non-zero catch rate. Tiny
  // (1-2 address) campaigns have noisy rates, and zero-yield campaigns
  // would drag the median to 0 and make every catching campaign look
  // like a 2x outlier.
  const eligible = input.activeCampaigns.filter(
    (c) => (c.addresses_seeded ?? 0) >= R3_MIN_ADDRESSES_SEEDED && catchRate(c) > 0,
  );
  const med = median(eligible.map(catchRate));
  for (const c of eligible) {
    const rate = catchRate(c);
    if (rate >= R3_MEDIAN_MULTIPLIER * med) {
      items.push({
        rule: "expand_campaign",
        campaign_id: c.id,
        campaign_name: c.name,
        channel: c.channel,
        catch_rate: Math.round(rate * 10) / 10,
        median_catch_rate: Math.round(med * 10) / 10,
        addresses_seeded: c.addresses_seeded,
      });
    }
  }

  return items;
}

/** Medium when the trap network is live (active seeds) but caught nothing in 7d. */
export function seedStrategistSeverity(captures7d: number, activeSeeds: number): "medium" | "info" {
  return captures7d === 0 && activeSeeds > 0 ? "medium" : "info";
}

export const seedStrategistAgent: AgentModule = {
  name: "seed_strategist",
  displayName: "Seed Strategist",
  description: "Spam trap seeding strategy & coverage optimization",
  color: "#F59E0B",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  // No AI calls — rule-based recommendations since AI Strategy Phase 1. Cap=0 surfaces regressions.
  costGuard: "exempt",
  budget: { monthlyTokenCap: 0 },
  reads: [
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "seed_addresses" },
    { kind: "d1_table", name: "seed_campaigns" },
    { kind: "d1_table", name: "spam_trap_captures" },
  ],
  writes: [
    { kind: "d1_table", name: "seed_addresses" },
  ],
  outputs: [{ type: "insight" }, { type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 20,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;

    const outputs: AgentOutputEntry[] = [];
    let itemsUpdated = 0;
    let pruned = 0;

    // Wave-1 PR-AB: auto-prune stale-dead seeds. Any active seed that
    // was planted >60 days ago and has never caught anything is
    // retired so the auto-seeder can recycle the seeded_location for
    // a fresh address. Threshold matches the UI's STALE_DAYS=30 and
    // gives the seed twice the bucketing window before we declare it
    // permanently unproductive.
    try {
      const pruneResult = await env.DB.prepare(`
        UPDATE seed_addresses
        SET status = 'retired'
        WHERE status = 'active'
          AND total_catches = 0
          AND seeded_at IS NOT NULL
          AND seeded_at < datetime('now', '-60 days')
      `).run();
      pruned = (pruneResult.meta as { changes?: number } | undefined)?.changes ?? 0;
      itemsUpdated += pruned;
      if (pruned > 0) {
        outputs.push({
          type: "diagnostic",
          summary: `Auto-pruned ${pruned} stale-dead seed addresses (>60d, 0 catches)`,
          severity: "info",
          details: { stale_dead_pruned: pruned, threshold_days: 60 },
        });
      }
    } catch (err) {
      console.warn(`[SeedStrategist] stale-dead prune failed:`, err);
    }

    const [trapStats, uncoveredBrands, channelStats, activeCampaigns] = await Promise.all([
      env.DB.prepare(`
        SELECT
          COUNT(*) as total_captures_7d,
          COUNT(DISTINCT sending_ip) as unique_ips_7d,
          COUNT(DISTINCT spoofed_brand_id) as brands_spoofed_7d
        FROM spam_trap_captures
        WHERE captured_at > datetime('now', '-7 days')
      `).first<{ total_captures_7d: number; unique_ips_7d: number; brands_spoofed_7d: number }>(),

      // R1 candidates: monitored brands (tier — never monitoring_status,
      // see lib/monitored-brands.ts) with zero 30d captures and no active
      // seed address targeting them. Two NOT EXISTS anti-joins: each
      // stops at the first matching row, where the former double LEFT
      // JOIN + GROUP BY/HAVING materialized the captures × seeds cross
      // product per brand only to count it to zero.
      env.DB.prepare(`
        SELECT b.id, b.name, b.active_threat_count
        FROM brands b
        WHERE ${MONITORED_BRAND_PREDICATE_SQL}
          AND b.active_threat_count >= ?
          AND NOT EXISTS (
            SELECT 1 FROM spam_trap_captures c
            WHERE c.spoofed_brand_id = b.id
              AND c.captured_at > datetime('now', '-30 days')
          )
          AND NOT EXISTS (
            SELECT 1 FROM seed_addresses sa
            WHERE sa.brand_target = b.id
              AND sa.status = 'active'
          )
        ORDER BY b.active_threat_count DESC
        LIMIT ?
      `).bind(R1_MIN_ACTIVE_THREATS, R1_LIMIT).all<UncoveredBrandRow>(),

      // R2 input: per-channel active seeds + 7d captures landing on them.
      env.DB.prepare(`
        SELECT sa.channel,
               COUNT(DISTINCT sa.id) AS active_seeds,
               COUNT(c.id)           AS captures_7d
        FROM seed_addresses sa
        LEFT JOIN spam_trap_captures c
          ON c.trap_address = sa.address
         AND c.captured_at > datetime('now', '-7 days')
        WHERE sa.status = 'active'
        GROUP BY sa.channel
      `).all<ChannelStatsRow>(),

      // R3 input: every active seed campaign (small table) — the median
      // is computed in JS.
      env.DB.prepare(`
        SELECT id, name, channel, total_catches, addresses_seeded
        FROM seed_campaigns
        WHERE status = 'active'
      `).all<SeedCampaignRow>(),
    ]);

    const channels = channelStats.results ?? [];
    const items = buildSeedRecommendations({
      uncoveredBrands: uncoveredBrands.results ?? [],
      channels,
      activeCampaigns: activeCampaigns.results ?? [],
    });

    const captures7d = trapStats?.total_captures_7d ?? 0;
    const activeSeeds = channels.reduce((sum, c) => sum + (c.active_seeds ?? 0), 0);
    const severity = seedStrategistSeverity(captures7d, activeSeeds);

    const counts = {
      seed_brand: items.filter((i) => i.rule === "seed_brand").length,
      review_channel: items.filter((i) => i.rule === "review_channel").length,
      expand_campaign: items.filter((i) => i.rule === "expand_campaign").length,
    };

    const summary =
      `Spam-trap coverage: ${captures7d} captures in 7d across ${activeSeeds} active seeds. ` +
      `${items.length} recommendation${items.length === 1 ? "" : "s"} ` +
      `(${counts.seed_brand} brand${counts.seed_brand === 1 ? "" : "s"} to seed, ` +
      `${counts.review_channel} channel${counts.review_channel === 1 ? "" : "s"} to review, ` +
      `${counts.expand_campaign} campaign${counts.expand_campaign === 1 ? "" : "s"} to expand); ` +
      `${pruned} stale seed${pruned === 1 ? "" : "s"} retired.`;

    outputs.push({
      type: "insight",
      summary,
      severity,
      details: {
        recommendations: items.length,
        retired: pruned,
        items,
      },
    });

    return {
      itemsProcessed: 1,
      itemsCreated: 0,
      itemsUpdated,
      output: {
        trapStats,
        uncoveredBrands: counts.seed_brand,
        recommendations: items.length,
        retired: pruned,
      },
      agentOutputs: outputs,
    };
  },
};
