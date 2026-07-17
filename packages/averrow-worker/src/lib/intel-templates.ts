/**
 * Static template registry for the AI-intel notification family.
 *
 * Per NOTIFICATIONS_AUDIT.md §11 (Q5 — static templates v1; the
 * narrator agent for AI-summarised digests is Q5b backlog).
 *
 * Each `intel_*` type carries three template fields populated from
 * call-site variables:
 *   - title              — bell-row headline
 *   - reason_text        — "why am I seeing this?"  (§7.2)
 *   - recommended_action — "what should I do?"      (§7.6)
 *
 * The message field is short prose rendered between title and
 * reason in the inbox row.
 *
 * Add a new intel type in three places:
 *   1. The CHECK constraint in migration 0127 (already widened for
 *      all five types — see §10.1).
 *   2. NotificationEventKey in @averrow/shared/notification-events.
 *   3. INTEL_TEMPLATES below.
 */

import { createNotification } from './notifications';
import type { Env } from '../types';
import type { NotificationType } from './notifications';

// ─── Variables passed by call sites ──────────────────────────────────

export interface IntelPredictiveVars {
  brand_id: string;
  brand_name: string;
  asn: string;
  lookalike_count: number;
  cluster_id: string;
  predicted_window: string; // e.g. "this weekend (Apr 26–28)"
}

export interface IntelCrossBrandPatternVars {
  sector: string;
  affected_count: number;
  baseline: number;
  fold: number;        // fold over baseline, e.g. 4 ⇒ "4× baseline"
  dimension: string;   // e.g. "same registrar", "same TLDs"
  affected_brands: string[];
  window_label: string; // e.g. "today"
}

export interface IntelSectorTrendVars {
  user_id: string;
  sector: string;
  pct_change: number;
  affected_count: number;
  unaffected_count: number;
}

export interface IntelRecommendedActionVars {
  brand_id: string;
  brand_name: string;
  check_id: string;          // e.g. "dmarc_policy_none", "dkim_age_2y"
  what: string;
  why_it_matters: string;
  recommended_action: string;
  link?: string;
}

export interface IntelThreatActorSurfaceVars {
  user_id: string;
  actor_slug: string;
  actor_name: string;
  new_ip_count: number;
  prior_brands: string[];
  prior_window: string; // e.g. "the last 90 days"
}

// ─── Rendered template payload ───────────────────────────────────────

export interface RenderedTemplate {
  title: string;
  message: string;
  reason_text: string;
  recommended_action: string;
  link: string;
  group_key: string;
  brand_id?: string;
  audience: 'tenant' | 'super_admin';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

// ─── Template renderers ──────────────────────────────────────────────

export function renderIntelPredictive(v: IntelPredictiveVars): RenderedTemplate {
  return {
    title: `Likely targeted: ${v.brand_name}`,
    message: `${v.lookalike_count} new lookalike domains for ${v.brand_name} on AS${v.asn} — same ASN as a prior campaign.`,
    reason_text: `You monitor ${v.brand_name}.`,
    recommended_action: `Pre-emptively file takedowns for the flagged domains. Brief support for likely uptick in customer reports.`,
    // No /operations/clusters route exists; closest landing is the
    // brand detail page, where the affected brand's threats live.
    link: `/brands/${v.brand_id}`,
    group_key: `intel_predictive:${v.brand_id}`,
    brand_id: v.brand_id,
    audience: 'tenant',
    severity: 'high',
  };
}

export function renderIntelCrossBrandPattern(v: IntelCrossBrandPatternVars): RenderedTemplate {
  // ≥3 tenants in same sector ⇒ critical; ≥2 ⇒ high (per §11.2)
  const severity: RenderedTemplate['severity'] = v.affected_count >= 3 ? 'critical' : 'high';
  return {
    title: `${v.affected_count} ${v.sector} tenants hit critical exposure ${v.window_label}`,
    message: `Pattern: ${v.dimension}. Baseline was ${v.baseline}. Affected: ${v.affected_brands.slice(0, 3).join(', ')}${v.affected_brands.length > 3 ? '…' : ''}.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Brief affected tenants. Consider sector-wide threat-actor attribution. Update default brand monitoring rules to flag ${v.dimension}.`,
    // No /admin/intel/cross-brand view exists yet; fall back to the
    // admin dashboard until the dedicated page ships.
    link: `/admin`,
    group_key: `intel_cross_brand_pattern:${v.sector}`,
    audience: 'super_admin',
    severity,
  };
}

export function renderIntelSectorTrend(v: IntelSectorTrendVars): RenderedTemplate {
  const direction = v.pct_change >= 0 ? 'up' : 'down';
  return {
    title: `${v.sector} sector phishing volume ${direction} ${Math.abs(v.pct_change)}% this week`,
    message: `Your monitored brands: ${v.affected_count} affected, ${v.unaffected_count} not yet.`,
    reason_text: `You monitor brands in the ${v.sector} sector.`,
    recommended_action: `Review email-security posture for unaffected brands. Validate DKIM rotation schedule.`,
    // No /intel/sector view exists; the brands list is the closest
    // analog (operator can filter by sector there).
    link: `/brands`,
    group_key: `intel_sector_trend:${v.user_id}:${v.sector}`,
    audience: 'tenant',
    severity: 'medium',
  };
}

export function renderIntelRecommendedAction(v: IntelRecommendedActionVars): RenderedTemplate {
  return {
    title: `${v.brand_name}: ${v.what}`,
    message: v.why_it_matters,
    reason_text: `You monitor ${v.brand_name}.`,
    recommended_action: v.recommended_action,
    // Brand detail uses ?tab=email rather than a sub-path.
    link: v.link ?? `/brands/${v.brand_id}?tab=email`,
    group_key: `intel_recommended_action:${v.brand_id}:${v.check_id}`,
    brand_id: v.brand_id,
    audience: 'tenant',
    severity: 'medium',
  };
}

export function renderIntelThreatActorSurface(v: IntelThreatActorSurfaceVars): RenderedTemplate {
  // Severity is high if the actor previously targeted the user's
  // brands; medium if active in their sector but no prior targeting.
  const severity: RenderedTemplate['severity'] = v.prior_brands.length > 0 ? 'high' : 'medium';
  const priorBlurb = v.prior_brands.length > 0
    ? `This actor previously targeted ${v.prior_brands.slice(0, 3).join(', ')}${v.prior_brands.length > 3 ? '…' : ''} in ${v.prior_window}.`
    : `Active in your sector — no prior targeting yet.`;
  return {
    title: `Threat actor ${v.actor_name} expanded infrastructure`,
    message: `${v.actor_name} added ${v.new_ip_count} new IPs to their infrastructure today.`,
    reason_text: priorBlurb,
    recommended_action: `Add new IPs to block list. Review detection rules for ${v.actor_name}'s known TTPs.`,
    // Route param is :actorId; we pass actor_slug here. If your
    // threat_actors table uses slug-as-id, this resolves; otherwise
    // the page handles unknown ids and falls back gracefully.
    link: `/threat-actors/${v.actor_slug}`,
    group_key: `intel_threat_actor_surface:${v.actor_slug}:${v.user_id}`,
    audience: 'tenant',
    severity,
  };
}

// ─── Emit helper ─────────────────────────────────────────────────────

/**
 * Emit a rendered intel notification through the v3 createNotification
 * routing. Type-safe wrapper that prevents callers from drifting from
 * the registry — pass the type + its variables and the helper does
 * the rest.
 */
export async function emitIntelNotification<T extends NotificationType>(
  env: Env,
  type: T,
  rendered: RenderedTemplate,
): Promise<number> {
  return createNotification(env, {
    type,
    severity: rendered.severity,
    title: rendered.title,
    message: rendered.message,
    reasonText: rendered.reason_text,
    recommendedAction: rendered.recommended_action,
    link: rendered.link,
    audience: rendered.audience,
    brandId: rendered.brand_id ?? null,
    groupKey: rendered.group_key,
  });
}
