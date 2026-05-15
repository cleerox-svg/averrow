/**
 * Seed Strategist Agent — Analyzes spam trap performance and generates seeding plans.
 *
 * Runs daily at 6am UTC. Gathers trap metrics, identifies coverage gaps,
 * and uses Haiku AI to recommend new seeding campaigns. Auto-creates
 * campaigns and seed addresses based on AI recommendations.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { checkCostGuard } from "../lib/haiku";
import { callAnthropicText, AnthropicError } from "../lib/anthropic";
import { HOT_PATH_HAIKU } from "../lib/ai-models";

export const seedStrategistAgent: AgentModule = {
  name: "seed_strategist",
  displayName: "Seed Strategist",
  description: "Spam trap seeding strategy & coverage optimization",
  color: "#F59E0B",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 1_000_000 },
  reads: [
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "seed_campaigns" },
    { kind: "d1_table", name: "spam_trap_captures" },
  ],
  writes: [
    { kind: "d1_table", name: "agent_outputs" },
    { kind: "d1_table", name: "seed_addresses" },
    { kind: "d1_table", name: "seed_campaigns" },
  ],
  outputs: [{ type: "insight" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 20,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;

    const blocked = await checkCostGuard(env, false);
    if (blocked) {
      console.warn(`[SeedStrategist] ${blocked}`);
      return { itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, output: { skipped: true, reason: blocked } };
    }

    const outputs: AgentOutputEntry[] = [];
    let itemsCreated = 0;
    let itemsUpdated = 0;

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
      const pruned = (pruneResult.meta as { changes?: number } | undefined)?.changes ?? 0;
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

    // Gather metrics
    const trapStats = await env.DB.prepare(`
      SELECT
        COUNT(*) as total_captures_7d,
        COUNT(DISTINCT sending_ip) as unique_ips_7d,
        COUNT(DISTINCT spoofed_brand_id) as brands_spoofed_7d,
        SUM(CASE WHEN trap_channel = 'generic' THEN 1 ELSE 0 END) as generic_catches,
        SUM(CASE WHEN trap_channel = 'brand' THEN 1 ELSE 0 END) as brand_catches,
        SUM(CASE WHEN trap_channel = 'spider' THEN 1 ELSE 0 END) as spider_catches,
        SUM(CASE WHEN trap_channel = 'paste' THEN 1 ELSE 0 END) as paste_catches,
        SUM(CASE WHEN trap_channel = 'honeypot' THEN 1 ELSE 0 END) as honeypot_catches
      FROM spam_trap_captures
      WHERE captured_at > datetime('now', '-7 days')
    `).first();

    // Brands with active phishing but no trap catches.
    // D1 rejects HAVING on non-aggregate queries (D1_ERROR:
    // HAVING clause on a non-aggregate query). Wrap in a subquery
    // and filter the computed column with WHERE.
    const uncoveredBrands = await env.DB.prepare(`
      SELECT * FROM (
        SELECT b.id, b.name, b.threat_count,
          (SELECT COUNT(*) FROM spam_trap_captures WHERE spoofed_brand_id = b.id
           AND captured_at > datetime('now', '-30 days')) as trap_catches
        FROM brands b
        WHERE b.threat_count > 10
      ) WHERE trap_catches = 0
      ORDER BY threat_count DESC
      LIMIT 10
    `).all();

    // Top performing seed campaigns
    const topCampaigns = await env.DB.prepare(`
      SELECT name, channel, total_catches, addresses_seeded,
        ROUND(CAST(total_catches AS REAL) / MAX(addresses_seeded, 1), 1) as catch_rate
      FROM seed_campaigns
      WHERE status = 'active'
      ORDER BY total_catches DESC
      LIMIT 5
    `).all();

    const prompt = `You are the Seed Strategist agent for Averrow, a threat intelligence platform.

Analyze spam trap performance and recommend new seeding actions.

TRAP PERFORMANCE (last 7 days):
${JSON.stringify(trapStats)}

BRANDS WITH PHISHING BUT NO TRAP CATCHES:
${JSON.stringify(uncoveredBrands.results)}

TOP PERFORMING CAMPAIGNS:
${JSON.stringify(topCampaigns.results)}

Based on this data, provide:
1. ASSESSMENT: Brief performance assessment (2-3 sentences)
2. RECOMMENDATIONS: 3-5 specific, actionable seeding recommendations. For each, specify:
   - channel (paste/spider/honeypot/brand)
   - target brands (if applicable)
   - specific addresses to create
   - where to seed them
3. RETIRE: Any addresses or campaigns that should be retired (0 catches in 30 days)

Format your response as JSON:
{
  "assessment": "...",
  "recommendations": [
    {
      "action": "create_campaign",
      "channel": "paste",
      "name": "campaign name",
      "target_brands": ["brand_id"],
      "addresses": ["email@averrow.com"],
      "seed_location": "pastebin",
      "reasoning": "..."
    }
  ],
  "retire": ["address1@domain.com"]
}`;

    let content = "";
    try {
      const { text } = await callAnthropicText(env, {
        agentId: "seed_strategist",
        runId,
        model: HOT_PATH_HAIKU,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1000,
      });
      content = text;
    } catch (callErr) {
      const msg = callErr instanceof AnthropicError ? callErr.message : callErr instanceof Error ? callErr.message : String(callErr);
      console.warn(`[SeedStrategist] AI call failed: ${msg}`);
      return { itemsProcessed: 1, itemsCreated: 0, itemsUpdated: 0, output: { error: msg } };
    }

    try {
      const plan = JSON.parse(content) as {
        assessment?: string;
        recommendations?: Array<{
          action: string;
          channel: string;
          name: string;
          target_brands?: string[];
          addresses?: string[];
          seed_location?: string;
          reasoning?: string;
        }>;
        retire?: string[];
      };

      // Auto-create recommended campaigns
      for (const rec of plan.recommendations || []) {
        if (rec.action === "create_campaign") {
          const campaignResult = await env.DB.prepare(`
            INSERT INTO seed_campaigns (name, channel, status, target_brands, config, created_by, strategist_notes)
            VALUES (?, ?, 'active', ?, ?, 'strategist_agent', ?)
          `).bind(
            rec.name, rec.channel, JSON.stringify(rec.target_brands || []),
            JSON.stringify({ seed_location: rec.seed_location, addresses: rec.addresses }),
            rec.reasoning || ""
          ).run();

          for (const addr of rec.addresses || []) {
            await env.DB.prepare(`
              INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, brand_target)
              VALUES (?, ?, ?, ?, ?)
            `).bind(
              addr, addr.split("@")[1], rec.channel,
              campaignResult.meta?.last_row_id,
              rec.target_brands?.[0] || null
            ).run();
            itemsCreated++;
          }
        }
      }

      // Retire recommended addresses
      for (const addr of plan.retire || []) {
        await env.DB.prepare(
          "UPDATE seed_addresses SET status = 'retired' WHERE address = ?"
        ).bind(addr).run();
        itemsUpdated++;
      }

      // Save agent output
      await env.DB.prepare(`
        INSERT INTO agent_outputs (id, agent_id, type, summary, created_at)
        VALUES (?, 'seed_strategist', 'insight', ?, datetime('now'))
      `).bind(
        `ss_${Date.now()}`,
        plan.assessment || content.substring(0, 500)
      ).run();

      outputs.push({
        type: "insight",
        summary: plan.assessment || "Seed strategist analysis complete",
        severity: "info",
        details: { recommendations: plan.recommendations?.length || 0, retired: plan.retire?.length || 0 },
      });

    } catch (e) {
      console.error("[SeedStrategist] Failed to parse AI response:", e);
      await env.DB.prepare(`
        INSERT INTO agent_outputs (id, agent_id, type, summary, created_at)
        VALUES (?, 'seed_strategist', 'diagnostic', ?, datetime('now'))
      `).bind(`ss_err_${Date.now()}`, content.substring(0, 500)).run();
    }

    return {
      itemsProcessed: 1,
      itemsCreated,
      itemsUpdated,
      output: { trapStats, uncoveredBrands: uncoveredBrands.results.length },
      agentOutputs: outputs,
    };
  },
};
