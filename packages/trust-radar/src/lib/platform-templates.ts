/**
 * Static template registry for the platform-health notification family.
 *
 * Per NOTIFICATIONS_AUDIT.md §13. Every type is
 * `audience='super_admin'` — these are operator alerts, never tenant.
 *
 * The rule from §13.2: only notify when human action is required.
 * If Flight Control / cube-healer / feed loader can fix it on the
 * next tick, stay silent and rely on the diagnostics endpoint
 * (CLAUDE.md §10) for non-actionable visibility.
 */

import { createNotification } from './notifications';
import type { Env } from '../types';
import type { NotificationType } from './notifications';
import type { RenderedTemplate } from './intel-templates';

// ─── Variables passed by call sites ──────────────────────────────────

export interface PlatformD1BudgetVars {
  pct_used: number; // e.g. 87 for 87%
  reads_today: number;
  daily_limit: number;
}

export interface PlatformKvBudgetVars {
  pct_used: number;
  reads_today: number;
  daily_limit: number;
}

export interface PlatformWorkerCpuBurstVars {
  agent_id: string;
  run_id: string;
  cpu_ms: number;
  ceiling_ms: number;
}

export interface PlatformFeedAtRiskVars {
  feed_id: string;
  feed_name: string;
  pct_to_auto_pause: number; // 0..100
  consecutive_failures: number;
  threshold: number;
}

export interface PlatformFeedAutoPausedVars {
  feed_id: string;
  feed_name: string;
  consecutive_failures: number;
  last_error: string | null;
}

export interface PlatformFeedSilentVars {
  /** Comma-joined feed names — alert is roll-up, not per-feed. */
  feed_ids: string;
  feed_count: number;
  /** The largest elapsed-vs-expected ratio in this batch, e.g. 8.4 means worst feed is 8.4× overdue. */
  worst_ratio: number;
  /** Worst-offender feed name and how long since its last successful pull (in hours). */
  worst_feed: string;
  worst_hours_since_pull: number;
  /** Cause hint surfaced when the orchestrator caught a throw from runAllFeeds. */
  cause_hint: string | null;
}

export interface PlatformAgentStalledVars {
  agent_id: string;
  run_id: string;
  minutes_running: number;
}

export interface PlatformGeoipRefreshStalledVars {
  refresh_log_id: string;
  minutes_running: number;
  source_version: string | null;
}

export interface PlatformCronMissedVars {
  cron: 'orchestrator' | 'navigator';
  expected_interval_minutes: number;
  minutes_since_last: number;
}

export interface PlatformEnrichmentStuckVars {
  stuck_count: number;
  threshold: number;
}

export interface PlatformAiSpendBurstVars {
  spent_24h_usd: number;
  threshold_usd: number;
  top_agent: string;
  top_agent_cost_usd: number;
}

export interface PlatformResendBouncesVars {
  pct_failed: number; // 0..100
  failed_7d: number;
  delivered_7d: number;
}

export interface PlatformBriefingSilentVars {
  hours_since_last_briefing: number;
  expected_within_hours: number; // canonical 24
}

// ─── Renderers (every one returns audience='super_admin') ────────────
//
// Link targets must match real routes in averrow-ui/src/App.tsx:
//   /agents (NOT /admin/agents)
//   /feeds  (NOT /admin/feeds)
//   /admin  (admin dashboard — covers diagnostics, budget for now;
//            no dedicated /admin/diagnostics or /admin/budget exist)
// Get this wrong and the push notification deep-links to a 404.

const PLATFORM_AGENTS_LINK = '/agents';
const PLATFORM_FEEDS_LINK = '/feeds';
const PLATFORM_ADMIN_LINK = '/admin';

export function renderPlatformD1BudgetWarn(v: PlatformD1BudgetVars): RenderedTemplate {
  return {
    title: `D1 daily reads at ${v.pct_used}% of plan`,
    message: `${v.reads_today.toLocaleString()} / ${v.daily_limit.toLocaleString()} reads today.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Review query plan; check for missing indexes; consider read-replica routing for hot endpoints.`,
    link: PLATFORM_ADMIN_LINK,
    group_key: `platform_d1_budget_warn:${todayKey()}`,
    audience: 'super_admin',
    severity: 'high',
  };
}

export function renderPlatformD1BudgetBreach(v: PlatformD1BudgetVars): RenderedTemplate {
  return {
    title: `D1 daily reads exceeded plan (${v.pct_used}%)`,
    message: `${v.reads_today.toLocaleString()} / ${v.daily_limit.toLocaleString()} — non-essential agents will degrade until rollover.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Throttle non-essential agents; escalate to plan upgrade if pattern repeats.`,
    link: PLATFORM_ADMIN_LINK,
    group_key: `platform_d1_budget_breach:${todayKey()}`,
    audience: 'super_admin',
    severity: 'critical',
  };
}

export function renderPlatformKvBudgetWarn(v: PlatformKvBudgetVars): RenderedTemplate {
  return {
    title: `KV usage at ${v.pct_used}% of daily plan`,
    message: `${v.reads_today.toLocaleString()} ops today vs ${v.daily_limit.toLocaleString()} limit.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Audit cache TTLs; reduce pre-warm scope if Navigator is hitting the same keys repeatedly.`,
    link: PLATFORM_ADMIN_LINK,
    group_key: `platform_kv_budget_warn:${todayKey()}`,
    audience: 'super_admin',
    severity: 'medium',
  };
}

export function renderPlatformWorkerCpuBurst(v: PlatformWorkerCpuBurstVars): RenderedTemplate {
  return {
    title: `${v.agent_id} burst CPU ceiling (${v.cpu_ms}ms / ${v.ceiling_ms}ms)`,
    message: `Run ${v.run_id} consumed >50% of CPU budget. Repeated bursts indicate a Workflow refactor candidate.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Inspect agent_runs.error_message for hints; consider splitting heavy phases into Workflow steps.`,
    link: PLATFORM_AGENTS_LINK,
    group_key: `platform_worker_cpu_burst:${v.agent_id}:${v.run_id}`,
    audience: 'super_admin',
    severity: 'high',
  };
}

export function renderPlatformFeedAtRisk(v: PlatformFeedAtRiskVars): RenderedTemplate {
  return {
    title: `Feed ${v.feed_name} at risk of auto-pause (${v.pct_to_auto_pause}%)`,
    message: `${v.consecutive_failures} consecutive failures (threshold ${v.threshold}). Investigate before it pauses.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Check the feed source; rotate API key if you see 401/403; verify network reachability.`,
    link: PLATFORM_FEEDS_LINK,
    group_key: `platform_feed_at_risk:${v.feed_id}`,
    audience: 'super_admin',
    severity: 'high',
  };
}

export function renderPlatformFeedAutoPaused(v: PlatformFeedAutoPausedVars): RenderedTemplate {
  return {
    title: `Feed ${v.feed_name} auto-paused after ${v.consecutive_failures} failures`,
    message: v.last_error ? `Last error: ${truncate(v.last_error, 240)}` : 'No error message captured.',
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Manual unpause via /feeds once the root cause is fixed.`,
    link: PLATFORM_FEEDS_LINK,
    group_key: `platform_feed_auto_paused:${v.feed_id}`,
    audience: 'super_admin',
    severity: 'critical',
  };
}

/**
 * Emitted when one or more feeds are enabled but haven't pulled
 * for 3× their expected interval. Catches the silent-success class
 * of bug where runAllFeeds throws before any per-feed code runs
 * (e.g. the 2026-04-30 → 05-02 blackout caused by a column-name
 * typo in autoRecoverStalePausedFeeds — fixed in 50cb1e4 — which
 * was caught by orchestrator.ts:442-453 and only surfaced via
 * `logger.error('ingest_feeds_error', …)` with no platform alert).
 *
 * Roll-up by group_key=date so the operator gets ONE notification
 * per day even if many feeds go silent simultaneously. cause_hint
 * is non-null when the orchestrator's outer try/catch triggered
 * the alert directly (carries the throw message); null when the
 * Flight Control watchdog inferred the silence from feed_status
 * timestamps with no upstream throw to attribute it to.
 */
export function renderPlatformFeedSilent(v: PlatformFeedSilentVars): RenderedTemplate {
  // Two trigger paths share this template:
  //   1. Orchestrator catch-block (feed_count=0): runAllFeeds threw before
  //      per-feed dispatch. cause_hint carries the throw message. We can't
  //      enumerate feeds because dispatch never started.
  //   2. FC watchdog (feed_count>=1): one or more enabled feeds are
  //      3×+ overdue against schedule_cron. cause_hint is null because
  //      no upstream throw was seen this tick.
  const isThrowPath = v.feed_count === 0;
  const titleSuffix = isThrowPath
    ? `runAllFeeds threw before per-feed dispatch`
    : v.feed_count === 1
      ? `${v.worst_feed} silent`
      : `${v.feed_count} feeds silent (${v.worst_feed} worst, ${v.worst_hours_since_pull}h)`;
  const causeLine = v.cause_hint
    ? ` Last upstream error: ${truncate(v.cause_hint, 240)}`
    : '';
  const message = isThrowPath
    ? `Hourly orchestrator caught a throw from runAllFeeds — every enabled ingest feed is being silently skipped this tick.${causeLine}`
    : `Feeds enabled but haven't pulled in 3×+ their interval: ${truncate(v.feed_ids, 320)}. ` +
      `Worst case ${v.worst_feed} is ${v.worst_ratio.toFixed(1)}× overdue.${causeLine}`;
  return {
    title: `Ingest stalled — ${titleSuffix}`,
    message,
    reason_text: `Platform alert — operational only.`,
    recommended_action:
      `Inspect orchestrator logs for 'ingest_feeds_error' or any throw before per-feed dispatch. ` +
      `Verify feed_pull_history rows are landing for the affected feeds. ` +
      `If the dispatch is healthy but feeds are dedup-rejected, expect this alert to recur — ` +
      `widen the watchdog threshold rather than ignoring it.`,
    link: PLATFORM_FEEDS_LINK,
    group_key: `platform_feed_silent:${todayKey()}`,
    audience: 'super_admin',
    severity: 'high',
  };
}

/**
 * Layer C of the GeoIP refresh self-heal scheme. Fires when a
 * geo_ip_refresh_log row has been in `running` state for longer
 * than the workflow's worst-case runtime — strongly suggests the
 * workflow crashed without Layer A's failure handler updating the
 * row. Auto-recovery (mark failed) happens in flightControlAgent;
 * this template formats the operator-visible alert.
 *
 * Dedup key includes the refresh_log_id so the same stuck workflow
 * only notifies once. If the next refresh run also stalls, that's
 * a new id → new alert.
 */
export function renderPlatformGeoipRefreshStalled(v: PlatformGeoipRefreshStalledVars): RenderedTemplate {
  const versionSuffix = v.source_version ? ` (release ${v.source_version})` : '';
  return {
    title: `GeoIP refresh stalled (${v.minutes_running} min)`,
    message:
      `Workflow ${v.refresh_log_id}${versionSuffix} stuck in 'running' state. ` +
      `Likely a step exhausted retries without the workflow's failure handler updating the log row, ` +
      `or MaxMind / its CDN became unresponsive mid-import.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action:
      `Flight Control auto-marked this row failed. The next scheduled tick (Sunday 02:00 UTC) ` +
      `will retry. To trigger a manual retry now, hit the Force button on the GeoIP Pipeline tile ` +
      `or POST /api/admin/geoip-refresh with { forceReload: true }.`,
    link: PLATFORM_AGENTS_LINK,
    group_key: `platform_geoip_refresh_stalled:${v.refresh_log_id}`,
    audience: 'super_admin',
    severity: 'high',
  };
}

export function renderPlatformAgentStalled(v: PlatformAgentStalledVars): RenderedTemplate {
  return {
    title: `${v.agent_id} stalled (${v.minutes_running} min)`,
    message: `Run ${v.run_id} stuck in 'running' state. Likely orphaned by a Worker timeout or unhandled exception.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Force-fail the run via /agents; the next tick will re-dispatch. Investigate the stall reason in agent_runs.`,
    link: PLATFORM_AGENTS_LINK,
    group_key: `platform_agent_stalled:${v.agent_id}:${v.run_id}`,
    audience: 'super_admin',
    severity: 'high',
  };
}

export function renderPlatformCronMissed(v: PlatformCronMissedVars): RenderedTemplate {
  const cronLabel = v.cron === 'orchestrator' ? 'Orchestrator' : 'Navigator';
  return {
    title: `${cronLabel} cron has not run in ${v.minutes_since_last} min`,
    message: `Expected every ${v.expected_interval_minutes} min. Cloudflare cron triggers may have stopped firing.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Check Cloudflare cron triggers in the dashboard; verify wrangler.toml is the deployed version.`,
    link: PLATFORM_AGENTS_LINK,
    group_key: `platform_cron_${v.cron}_missed:${todayKey()}`,
    audience: 'super_admin',
    severity: 'critical',
  };
}

export function renderPlatformEnrichmentStuck(v: PlatformEnrichmentStuckVars): RenderedTemplate {
  return {
    title: `Enrichment stuck pile: ${v.stuck_count} threats`,
    message: `Threats marked enriched but missing geo data (threshold ${v.threshold}). Cube-healer rebuild may be needed.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Run cube-healer manually; investigate Cartographer Phase 1 failures in agent_runs.`,
    link: PLATFORM_AGENTS_LINK,
    group_key: `platform_enrichment_stuck_pile:${todayKey()}`,
    audience: 'super_admin',
    severity: 'medium',
  };
}

export function renderPlatformAiSpendBurst(v: PlatformAiSpendBurstVars): RenderedTemplate {
  return {
    title: `AI spend burst: $${v.spent_24h_usd.toFixed(2)} in 24h`,
    message: `Top agent: ${v.top_agent} ($${v.top_agent_cost_usd.toFixed(2)}). Threshold $${v.threshold_usd.toFixed(2)}.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Inspect per-agent breakdown; pause Sonnet-heavy agents if needed; consider routing to Haiku.`,
    link: PLATFORM_ADMIN_LINK,
    group_key: `platform_ai_spend_burst:${todayKey()}`,
    audience: 'super_admin',
    severity: 'high',
  };
}

export function renderPlatformBriefingSilent(v: PlatformBriefingSilentVars): RenderedTemplate {
  return {
    title: `Daily briefing has not sent in ${v.hours_since_last_briefing}h`,
    message: `Expected delivery every ${v.expected_within_hours}h. The 13:00 UTC cron may have failed silently or the email path is bouncing.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Check threat_briefings for today's row. Inspect agent_runs.error_message for the briefing_email job. Review §12 of NOTIFICATIONS_AUDIT.md for the failure mode catalogue.`,
    link: PLATFORM_ADMIN_LINK,
    group_key: `platform_briefing_silent:${todayKey()}`,
    audience: 'super_admin',
    severity: 'critical',
  };
}

export function renderPlatformResendBounces(v: PlatformResendBouncesVars): RenderedTemplate {
  return {
    title: `Email bounce rate ${v.pct_failed}% over 7 days`,
    message: `${v.failed_7d} failed / ${v.delivered_7d} delivered. SPF/DKIM may be misaligned.`,
    reason_text: `Platform alert — operational only.`,
    recommended_action: `Check SPF/DKIM alignment for the sending domain; review bounced addresses for invalid recipients.`,
    link: PLATFORM_ADMIN_LINK,
    group_key: `platform_resend_bounces:${weekKey()}`,
    audience: 'super_admin',
    severity: 'medium',
  };
}

// ─── Emit helper (mirrors emitIntelNotification) ─────────────────────

export async function emitPlatformNotification<T extends NotificationType>(
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
    groupKey: rendered.group_key,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekKey(): string {
  const d = new Date();
  // Monday-anchored week. Good enough for dedup; not for analytics.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
