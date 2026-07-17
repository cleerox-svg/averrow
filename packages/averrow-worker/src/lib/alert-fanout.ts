/**
 * Brand-alert fan-out helpers — when a campaign passes the significance
 * threshold or a threat actor's target list grows, create per-brand alert
 * rows so tenants whose brands are affected see them in their /alerts feed.
 *
 * NX4 (RESTRUCTURE_SPEC.md § NOTIFICATIONS RESTRUCTURE). Pairs with
 * `lib/campaign-significance.ts` for the gating decision. Tier-gate
 * inheritance: both helpers go through `createAlert` (lib/alerts.ts)
 * which already skips inserts when `brands.tier='tracked'`, so we don't
 * spam alerts for unclaimed brands here either.
 *
 * Idempotency: each helper checks
 * `(brand_id, source_type, source_id, alert_type)` before insert —
 * same pattern as `lib/alert-backfill.ts`. Safe to re-run when the
 * strategist re-evaluates a campaign whose significance has already
 * been alerted.
 */

import type { Env } from "../types";
import { createAlert } from "./alerts";
import type { AlertTypeKey, AlertSeverity } from "@averrow/shared";
import type { CampaignSignificanceReason } from "./campaign-significance";

export interface FanoutSummary {
  source_id: string;       // campaign_id or threat_actor_id
  brands_resolved: number; // distinct brands in target set
  created: number;
  skipped_duplicate: number;
  tier_gated: number;      // brands where createAlert returned null
  errors: number;
}

/**
 * Resolve a userId to "own" the alert. Alerts have user_id NOT NULL —
 * we use the first owner/admin/analyst of any org that has claimed the
 * brand. Same heuristic as `lib/alert-backfill.ts`. Returns null when
 * no org has claimed the brand yet; the caller must skip those brands.
 */
async function resolveOwnerUserId(env: Env, brandId: string): Promise<string | null> {
  const row = await env.DB.prepare(`
    SELECT om.user_id
      FROM org_brands ob
      JOIN org_members om ON om.org_id = ob.org_id
     WHERE ob.brand_id = ?
       AND om.role IN ('owner', 'admin', 'analyst')
     ORDER BY om.role = 'owner' DESC, om.role = 'admin' DESC, om.created_at ASC
     LIMIT 1
  `).bind(brandId).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function alreadyExists(
  env: Env,
  brandId: string,
  alertType: AlertTypeKey,
  sourceType: string,
  sourceId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM alerts
      WHERE brand_id = ? AND alert_type = ?
        AND source_type = ? AND source_id = ?
      LIMIT 1`
  ).bind(brandId, alertType, sourceType, sourceId).first<{ '1': number }>();
  return !!row;
}

// ─── Campaign fan-out ────────────────────────────────────────────────

export interface CampaignFanoutInput {
  campaign_id: string;
  campaign_name: string;
  threat_count: number;
  reasons: CampaignSignificanceReason[];
  /** Optional explicit severity override; defaults to 'high' from the
   *  alert-types.ts registry. Strategist passes 'critical' when the
   *  campaign is geopolitical or includes >=50 threats. */
  severityOverride?: AlertSeverity;
}

export async function createBrandAlertsForCampaign(
  env: Env,
  input: CampaignFanoutInput,
): Promise<FanoutSummary> {
  const summary: FanoutSummary = {
    source_id: input.campaign_id,
    brands_resolved: 0,
    created: 0,
    skipped_duplicate: 0,
    tier_gated: 0,
    errors: 0,
  };

  const brands = await env.DB.prepare(`
    SELECT DISTINCT target_brand_id AS brand_id
      FROM threats
     WHERE campaign_id = ?
       AND target_brand_id IS NOT NULL
  `).bind(input.campaign_id).all<{ brand_id: string }>();

  summary.brands_resolved = brands.results.length;

  const severity = input.severityOverride ?? 'high';
  const reasonLabel = input.reasons.join(', ');

  for (const { brand_id } of brands.results) {
    try {
      if (await alreadyExists(env, brand_id, 'campaign_impacts_brand', 'campaign', input.campaign_id)) {
        summary.skipped_duplicate++;
        continue;
      }
      const userId = await resolveOwnerUserId(env, brand_id);
      if (!userId) {
        // Brand isn't claimed; tier gate would skip the createAlert
        // anyway but this short-circuits before the lookup query.
        summary.tier_gated++;
        continue;
      }
      const id = await createAlert(env.DB, {
        brandId: brand_id,
        userId,
        alertType: 'campaign_impacts_brand',
        severity,
        title: `Campaign targeting your brand: ${input.campaign_name}`,
        summary: `Campaign "${input.campaign_name}" has ${input.threat_count} active threats and now includes your brand. Significance: ${reasonLabel}.`,
        sourceType: 'campaign',
        sourceId: input.campaign_id,
        details: {
          campaign_id: input.campaign_id,
          campaign_name: input.campaign_name,
          threat_count: input.threat_count,
          significance_reasons: input.reasons,
        },
      });
      if (id === null) summary.tier_gated++;
      else summary.created++;
    } catch (err) {
      summary.errors++;
      console.error('[alert-fanout/campaign] error for brand', brand_id, err);
    }
  }

  return summary;
}

// ─── Threat actor fan-out ────────────────────────────────────────────

export interface ThreatActorFanoutInput {
  threat_actor_id: string;
  threat_actor_name: string;
  /** Optional context — e.g. "Iranian APT", "ransomware crew". Surfaced
   *  in the alert summary so the tenant has a label to recognize. */
  context?: string;
  severityOverride?: AlertSeverity;
}

export async function createBrandAlertsForThreatActor(
  env: Env,
  input: ThreatActorFanoutInput,
): Promise<FanoutSummary> {
  const summary: FanoutSummary = {
    source_id: input.threat_actor_id,
    brands_resolved: 0,
    created: 0,
    skipped_duplicate: 0,
    tier_gated: 0,
    errors: 0,
  };

  const brands = await env.DB.prepare(`
    SELECT DISTINCT brand_id
      FROM threat_actor_targets
     WHERE threat_actor_id = ?
       AND brand_id IS NOT NULL
  `).bind(input.threat_actor_id).all<{ brand_id: string }>();

  summary.brands_resolved = brands.results.length;

  const severity = input.severityOverride ?? 'high';
  const ctxStr = input.context ? ` (${input.context})` : '';

  for (const { brand_id } of brands.results) {
    try {
      if (await alreadyExists(env, brand_id, 'threat_actor_targeting_brand', 'threat_actor', input.threat_actor_id)) {
        summary.skipped_duplicate++;
        continue;
      }
      const userId = await resolveOwnerUserId(env, brand_id);
      if (!userId) {
        summary.tier_gated++;
        continue;
      }
      const id = await createAlert(env.DB, {
        brandId: brand_id,
        userId,
        alertType: 'threat_actor_targeting_brand',
        severity,
        title: `Threat actor targeting your brand: ${input.threat_actor_name}`,
        summary: `Threat actor "${input.threat_actor_name}"${ctxStr} target list now includes your brand.`,
        sourceType: 'threat_actor',
        sourceId: input.threat_actor_id,
        details: {
          threat_actor_id: input.threat_actor_id,
          threat_actor_name: input.threat_actor_name,
          context: input.context ?? null,
        },
      });
      if (id === null) summary.tier_gated++;
      else summary.created++;
    } catch (err) {
      summary.errors++;
      console.error('[alert-fanout/threat-actor] error for brand', brand_id, err);
    }
  }

  return summary;
}
