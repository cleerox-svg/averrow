/**
 * Flight Control Agent — Autonomous Supervisor.
 *
 * Runs on every cron tick (before all other agents). Responsibilities:
 * - Measure backlogs (cartographer enrichment, analyst scoring)
 * - Check agent health and detect stalled agents
 * - Enforce daily AI token budget (throttle analyst at 80%, observer at 90%)
 * - Scale up agents with parallel instances when backlogs grow
 * - Auto-recover stalled agents
 * - Log all decisions to agent_activity_log
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import type { Env } from "../types";
import { BudgetManager, fetchAnthropicUsageReport } from "../lib/budgetManager";
import type { BudgetStatus, AgentBudgetLimits, ThrottleLevel } from "../lib/budgetManager";
import { createNotification } from "../lib/notifications";
import { dohTxtLookup, parseDmarcPolicy } from "../lib/doh";
import { transitionStatus as transitionIncidentStatus } from "../lib/incidents";
import {
  emitPlatformNotification,
  renderPlatformAgentStalled,
  renderPlatformFeedAutoPaused,
  renderPlatformFeedSilent,
  renderPlatformBriefingSilent,
  renderPlatformDmarcRampReminder,
  renderPlatformD1WritesPhase2Review,
  renderPlatformAiSpendBurst,
  renderPlatformCronMissed,
  renderPlatformEnrichmentStuck,
  renderPlatformDnsQueueDrift,
  renderPlatformDnsQueueStalled,
  renderPlatformDnsQueueReaperStalled,
  renderPlatformAbuseClassifierSilent,
  renderPlatformSpamTrapSeedingStalled,
  renderPlatformSpamTrapCaptureStale,
  renderPlatformGeoipRefreshStalled,
  renderPlatformWorkflowDispatchSilent,
  // NX6: previously-unwired templates.
  renderPlatformD1BudgetWarn,
  renderPlatformD1BudgetBreach,
  renderPlatformFeedAtRisk,
  renderPlatformProviderEscalation,
} from "../lib/platform-templates";
import { getBudgetState, DAILY_BUDGET, WARN_THRESHOLD, fetchBillingCycleMetrics, fetchRecentWindowMetrics, WRITES_INCLUDED_QUOTA } from "../lib/d1-budget";
import { getLastDispatchAt, getCooldownUntil } from "../lib/workflow-dispatch";
import { getWorkflowAgentStats } from "../lib/workflow-agent-stats";
import { PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import { parseCronIntervalMs } from "../lib/feedRunner";
import { cachedCount } from "../lib/cached-count";

// TTLs for backlog counters. "Monitoring" backlogs (the broad _checked
// queries that a partial index can't help with because the predicate
// matches 50-70% of the table) get a longer TTL — one fresh recompute
// per 4 ticks instead of every tick. "Live" backlogs used for scaling
// decisions stay on a shorter TTL so Flight Control reacts quickly, but
// must exceed the 3600s cron cadence so the cache is still fresh at the
// next :07 tick — a 3000s TTL expired ~10min before each tick, making
// every read a miss and silently defeating the cache for these metrics.
const BACKLOG_TTL_LIVE_S = 3900;       // 65 min — survives to next hourly tick
const BACKLOG_TTL_MONITORING_S = 14400; // 4h   — refresh every ~4th tick

// ─── Types ───────────────────────────────────────────────────────

interface AgentHealth {
  agent_id: string;
  last_run_at: string | null;
  last_run_status: string | null;
  avg_duration_ms: number;
  is_stalled: boolean;
  circuit_state: 'closed' | 'tripped';
  consecutive_failures: number;
  paused_reason: string | null;
  paused_after_n_failures: number | null;
  paused_at: string | null;
}

//
// Navigator health report. Navigator is an independent agent on the every-
// 5-minute cron, NOT part of the Flight Control dispatch mesh — FC observes
// it, does not manage it. Produced once per FC tick and surfaced in the
// diagnostic payload so the Agent Monitor UI can render Navigator alongside
// managed agents.
//
// Status thresholds (doubled from Navigator's 5-minute cycle for latency):
//   - healthy  : ran within last 10 min, success rate > 80%
//   - degraded : ran within last 10 min, success rate <= 80%
//   - stale    : last run was 10-30 min ago
//   - dead     : no run in 30+ minutes
//
interface NavigatorHealth {
  last_run_at: string | null;
  runs_last_hour: number;
  success_rate_last_hour: number; // 0-100, percent
  avg_records_processed: number;  // per run, last hour
  avg_duration_ms: number;
  status: 'healthy' | 'degraded' | 'stale' | 'dead';
}

interface Backlog {
  cartographer: number;
  analyst: number;
  totalUnlinked: number;
  totalNoGeo: number;
  surblUnchecked: number;
  vtUnchecked: number;
  gsbUnchecked: number;
  dblUnchecked: number;
  abuseipdbUnchecked: number;
  pdnsUnchecked: number;
  greynoiseUnchecked: number;
  seclookupUnchecked: number;
  watchdog: number;
  domainGeoBacklog:   number;  // threats with domain but no IP (all, includes cooldown)
  domainGeoDrainable: number;  // subset of domainGeoBacklog actually eligible right now
  brandEnrichBacklog: number;  // brands with no enriched_at
}

interface DegradedFeed {
  feed_name: string;
  last_failure: string | null;
  health_status: string;
}

/**
 * Auto-paused feed — disabled with paused_reason='auto:consecutive_failures'.
 * Operationally distinct from DegradedFeed: a degraded feed is still running
 * on its schedule (just returning errors) whereas an auto-paused feed has
 * been flipped to enabled=0 by the feedRunner and will NOT run again until
 * an admin unpauses it. The dashboard shows these as separate counts.
 */
interface AutoPausedFeed {
  feed_name: string;
  display_name: string;
  consecutive_failures: number;
  last_failure: string | null;
  last_error: string | null;
}

/**
 * Silent-feed candidate row — joined from feed_configs + feed_status
 * for the FC silent-ingest watchdog. enabled=1 + last_successful_pull
 * is non-null + paused_reason is null; the elapsed-vs-interval check
 * happens in TS because parseCronIntervalMs lives there.
 */
interface SilentFeedCandidate {
  feed_name: string;
  display_name: string | null;
  schedule_cron: string;
  last_successful_pull: string;
}

/**
 * Auto-tripped agent — circuit breaker has flipped enabled=0 with
 * paused_reason='auto:consecutive_failures'. Operationally distinct
 * from degraded: a degraded agent is still running (just failing)
 * whereas a tripped agent is skipped by executeAgent() until an
 * admin resets its circuit breaker.
 */
interface TrippedAgent {
  agent_id: string;
  consecutive_failures: number;
  paused_at: string | null;
  paused_after_n_failures: number | null;
}

// Parallel instance thresholds per backlog level
const SCALING = {
  cartographer: { low: 500, medium: 2000, high: 5000, max_parallel: 3 },
  analyst:      { low: 50,  medium: 200,  high: 500,  max_parallel: 1 },
} as const;

// Stall-threshold map moved to per-agent `stallThresholdMinutes`
// declarations on each AgentModule (Phase 4.1 of agent audit, AGENT_STANDARD §3).
// FC reads them via getStallThresholdMap() below, so a new agent's
// threshold ships with the agent — no out-of-band table to keep in sync.
//
// Choose `stallThresholdMinutes` ≈ (intended interval × 1.2) so a single
// skipped tick doesn't trigger spurious recovery, but a hung agent still
// recovers within one extra interval.
//
// History: prior to PR #814 only six agents were listed in the
// table-form constant; the other 10+ defaulted to 60 minutes and were
// re-dispatched every hour regardless of their actual schedule,
// producing platform-wide cadence drift visible in agent_runs (e.g.
// sparrow running every 3h instead of every 6h). PR #814 added all
// agents to the table; Phase 4.1 moved the values onto the modules
// themselves so they're typecheck-enforced.

/**
 * Dynamically derived from the agent registry — all agents are monitored.
 * Must be resolved via dynamic import (not a top-level const) because
 * agents/index.ts imports flightControl.ts, creating a circular dependency.
 * A top-level static import of agentModules would resolve to undefined
 * at module load time.
 */
async function getAgentsToMonitor(): Promise<string[]> {
  const { agentModules: mods } = await import("./index");
  return Object.keys(mods);
}

// ─── Agent Module ────────────────────────────────────────────────

export const flightControlAgent: AgentModule = {
  name: "flight_control",
  displayName: "Flight Control",
  description: "Autonomous supervisor — parallel scaling, stall recovery, token budget enforcement",
  color: "#00d4ff",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 75,
  parallelMax: 1,
  costGuard: "exempt",
  // FC supervises — does not call AI itself. Cap=0 surfaces regressions.
  budget: { monthlyTokenCap: 0 },
  reads: [
    { kind: "kv", namespace: "CACHE" },
    { kind: "binding", name: "CERTSTREAM_MONITOR" },
    { kind: "d1_table", name: "agent_configs" },
    { kind: "d1_table", name: "agent_outputs" },
    { kind: "d1_table", name: "agent_runs" },
    { kind: "d1_table", name: "backlog_history" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "feed_configs" },
    { kind: "d1_table", name: "feed_pull_history" },
    { kind: "d1_table", name: "feed_status" },
    // PR-B (2026-05-16 audit): provider-escalation watcher joins
    // hosting_providers against yesterday's daily_snapshots active-
    // threat count each tick to surface providers whose active footprint
    // surged day-over-day (Cloudflare 0→51K with no signal was the
    // motivating gap). Baseline switched from provider_threat_stats(7d)
    // to daily_snapshots on 2026-05-27 — see the watcher below.
    { kind: "d1_table", name: "hosting_providers" },
    { kind: "d1_table", name: "daily_snapshots" },
    // N6c briefing-silent self-monitor reads any open
    // auto:platform_briefing_silent incident so it can auto-resolve
    // it on heal. Bundle F (2026-05-07).
    { kind: "d1_table", name: "incidents" },
    { kind: "d1_table", name: "push_subscriptions" },
    { kind: "d1_table", name: "social_mentions" },
    { kind: "d1_table", name: "threat_briefings" },
    { kind: "d1_table", name: "threats" },
    // Layer C of the GeoIP self-heal scheme: FC supervisor reads
    // geo_ip_refresh_log to find stuck workflows that need force-
    // failing. Lives on GEOIP_DB; the binding is optional so the
    // SELECT is wrapped in try/catch.
    { kind: "d1_table", name: "geo_ip_refresh_log" },
    // PR-3 of DNS-queue split: FC reads dns_queue size for the
    // parity-drift and reconciler-stalled health checks. Lives on
    // DNS_QUEUE_DB; binding is optional so the SELECT is wrapped
    // in try/catch.
    { kind: "d1_table", name: "dns_queue" },
    // PR-AY: abuse mailbox classifier silence check reads pending
    // count + oldest received_at, then budget_ledger for last
    // classifier Haiku timestamp.
    { kind: "d1_table", name: "abuse_inbox_messages" },
    { kind: "d1_table", name: "budget_ledger" },
    // Spam-trap silent-failure monitor (2026-06): reads MAX(seeded_at)
    // from seed_addresses and MAX(captured_at) from spam_trap_captures
    // to detect a stalled honeypot planter / stale captures.
    { kind: "d1_table", name: "seed_addresses" },
    { kind: "d1_table", name: "spam_trap_captures" },
  ],
  writes: [
    { kind: "d1_table", name: "agent_activity_log" },
    { kind: "d1_table", name: "agent_runs" },
    { kind: "d1_table", name: "backlog_history" },
    // N6c briefing-silent self-monitor writes a resolution row to
    // incident_updates when auto-resolving. The parent `incidents`
    // row is also updated, but via `lib/incidents.transitionStatus`
    // (a shared helper) so it's declared by that module's caller
    // chain rather than directly here. Bundle F (2026-05-07).
    { kind: "d1_table", name: "incident_updates" },
    { kind: "d1_table", name: "push_subscriptions" },
    // Layer C of the GeoIP self-heal scheme: FC supervisor force-
    // fails geo_ip_refresh_log rows that escaped both the workflow
    // failure handler (Layer A) and the agent self-heal (Layer B).
    { kind: "d1_table", name: "geo_ip_refresh_log" },
  ],
  outputs: [],
  status: "active",
  category: "orchestration",
  pipelinePosition: 0,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const db = env.DB;
    const outputs: AgentOutputEntry[] = [];
    const budgetMgr = new BudgetManager(db);

    // ── Phase timing instrumentation (P2 / FC duration debug) ─────
    // Wraps each major phase so we can see in agent_outputs.details
    // .timings which step dominates the ~4 min FC tick. The cost is
    // negligible (Date.now × ~12 phases). Surfaces in diagnostics.
    const timings: Record<string, number> = {};
    const t0 = Date.now();
    let lastMark = t0;
    const mark = (phase: string) => {
      const now = Date.now();
      timings[phase] = (timings[phase] ?? 0) + (now - lastMark);
      lastMark = now;
    };

    // Fetch Anthropic usage report (once per hour, guarded by KV)
    let anthropicReported = 0;
    const anthropicAdminKey = (env as unknown as Record<string, string | undefined>).ANTHROPIC_ADMIN_KEY;
    if (anthropicAdminKey) {
      const lastCheck = await env.CACHE.get('budget:anthropic_last_check');
      if (!lastCheck) {
        anthropicReported = await fetchAnthropicUsageReport(anthropicAdminKey);
        await env.CACHE.put('budget:anthropic_last_check', String(Date.now()), { expirationTtl: 3600 });
      }
    }
    mark('anthropic_check');

    // Run all reads in parallel — single round trip to D1
    const [backlogs, health, navigatorHealth, budgetStatus, agentLimits, lastCuratorRun, curatorHealth, unscannedEmails, degradedFeeds, autoPausedFeeds, silentFeedCandidates, trippedAgents] = await Promise.all([
      measureBacklogs(env, db),
      getAgentHealth(db),
      getNavigatorHealth(db),
      budgetMgr.getStatus(anthropicReported),
      budgetMgr.getAgentLimits(),
      db.prepare(`
        SELECT MAX(created_at) as last_run
        FROM agent_outputs
        WHERE agent_id = 'curator' AND type = 'hygiene_report'
      `).first<{ last_run: string | null }>(),
      // Curator dispatch-gate health: count recent reaper-stamped
      // failures and find the most recent agent_runs success. The
      // dispatch gate below uses these to back off when curator is
      // chronically broken (3+ failures in 3 h with no recent
      // success) — without this, FC re-dispatched a failing
      // curator every hour, producing zero work and filling
      // agent_runs with reaped rows. See the curator deep-dive
      // 2026-05-10 for the receipts.
      db.prepare(`
        SELECT
          COUNT(CASE WHEN status = 'failed'
                       AND started_at > datetime('now', '-3 hours')
                     THEN 1 END) AS recent_failures,
          MAX(CASE WHEN status = 'success' THEN started_at END) AS last_success_at
        FROM agent_runs
        WHERE agent_id = 'curator'
          AND started_at > datetime('now', '-6 hours')
      `).first<{ recent_failures: number; last_success_at: string | null }>().catch(() => ({ recent_failures: 0, last_success_at: null })),
      db.prepare(`
        SELECT COUNT(*) as count FROM brands
        WHERE email_security_grade IS NULL
      `).first<{ count: number }>(),
      // Degraded feeds are still enabled & running — they're just returning
      // errors. Intentionally excludes auto-paused feeds via the enabled=1
      // join so the two counts don't double-report the same feed.
      db.prepare(`
        SELECT feed_name, last_failure, health_status FROM feed_status
        WHERE health_status IN ('degraded', 'down')
          AND feed_name IN (SELECT feed_name FROM feed_configs WHERE enabled = 1)
      `).all<DegradedFeed>(),
      // Auto-paused feeds are enabled=0 by the feedRunner's auto-pause
      // guard. Operationally distinct from degraded — they will NOT run
      // again until an admin unpauses them, so the dashboard surfaces
      // them as a separate category.
      db.prepare(`
        SELECT fc.feed_name,
               fc.display_name,
               COALESCE(fs.consecutive_failures, 0) AS consecutive_failures,
               fs.last_failure,
               fs.last_error
          FROM feed_configs fc
          LEFT JOIN feed_status fs ON fs.feed_name = fc.feed_name
          WHERE fc.enabled = 0
            AND fc.paused_reason = 'auto:consecutive_failures'
          ORDER BY fs.consecutive_failures DESC
      `).all<AutoPausedFeed>(),
      // Silent-feed candidates — enabled feeds that have ever pulled
      // successfully. The interval check (last_pull older than
      // 3× schedule_cron) happens in TS because parseCronIntervalMs
      // lives there. Excludes feeds that have never run (status row
      // missing or last_successful_pull NULL) to keep first-run noise
      // out, and excludes anything paused/disabled — those have their
      // own platform_feed_auto_paused alerts.
      db.prepare(`
        SELECT fc.feed_name,
               fc.display_name,
               fc.schedule_cron,
               fs.last_successful_pull
          FROM feed_configs fc
          INNER JOIN feed_status fs ON fs.feed_name = fc.feed_name
          WHERE fc.enabled = 1
            AND fc.paused_reason IS NULL
            AND fs.last_successful_pull IS NOT NULL
      `).all<SilentFeedCandidate>(),
      // Auto-tripped agents — circuit breaker has flipped them to
      // enabled=0 with paused_reason='auto:consecutive_failures'.
      // Distinct from degraded (still running but failing).
      db.prepare(`
        SELECT agent_id,
               consecutive_failures,
               paused_at,
               paused_after_n_failures
          FROM agent_configs
          WHERE enabled = 0
            AND paused_reason = 'auto:consecutive_failures'
          ORDER BY consecutive_failures DESC
      `).all<TrippedAgent>(),
    ]);
    mark('parallel_reads');

    // Log budget state every tick for the activity log (diagnostic trail).
    if (budgetStatus.throttle_level === 'emergency') {
      await logActivity(db, 'flight_control', 'critical', 'budget_emergency',
        `EMERGENCY: Budget exhausted — AI agents paused ($${budgetStatus.spent_this_month}/$${budgetStatus.config.monthly_limit_usd})`,
        { budget: budgetStatus }
      );
    } else if (budgetStatus.throttle_level === 'hard') {
      await logActivity(db, 'flight_control', 'warning', 'budget_hard',
        `Budget hard limit — minimal AI processing ($${budgetStatus.spent_this_month}/$${budgetStatus.config.monthly_limit_usd})`,
        { budget: budgetStatus }
      );
    } else if (budgetStatus.throttle_level === 'soft') {
      await logActivity(db, 'flight_control', 'info', 'budget_soft',
        `Budget soft limit — reduced batch sizes ($${budgetStatus.spent_this_month}/$${budgetStatus.config.monthly_limit_usd})`,
        { budget: budgetStatus }
      );
    }

    // Fire a user-facing notification only on state transitions so we
    // don't spam the dashboard every hourly tick while the budget stays
    // in a throttled state. The activity-log entries above run every
    // tick regardless — they're the diagnostic trail, not the alert.
    //
    // Previously there was no createNotification() call at all for
    // budget events: a budget-triggered throttle could silently starve
    // Cartographer scaling (limits.pause_all_ai gates scaleAgents) with
    // nothing but an agent_activity_log row for anyone to notice. That
    // is the gap this block closes.
    try {
      const prevLevel = await budgetMgr.getLastThrottleLevel();
      const currLevel = budgetStatus.throttle_level;
      if (prevLevel !== currLevel) {
        await notifyBudgetTransition(env, prevLevel, currLevel, budgetStatus);
        await budgetMgr.setLastThrottleLevel(currLevel);
      }
    } catch (err) {
      // Never let a notification failure break Flight Control — the
      // activity log above already captured the state for diagnostics.
      await logActivity(db, 'flight_control', 'warning', 'budget_notification_error',
        `Failed to emit budget transition notification: ${err instanceof Error ? err.message : String(err)}`,
        { throttle_level: budgetStatus.throttle_level }
      );
    }

    mark('budget_logic');

    // ── Backlog B1: AI spend burst self-monitor ──────────────────
    // When projected_monthly is on track to overshoot the configured
    // limit by 50%+, fire a super_admin alert. Single fire per day
    // (group_key is day-keyed in the renderer).
    try {
      const overshootRatio = budgetStatus.config.monthly_limit_usd > 0
        ? budgetStatus.projected_monthly / budgetStatus.config.monthly_limit_usd
        : 0;
      if (overshootRatio >= 1.5) {
        // Find the top-cost agent in the last 24h for the message body.
        const topAgent = await db.prepare(
          `SELECT agent_id, SUM(cost_usd) AS cost FROM agent_runs
            WHERE started_at >= datetime('now', '-24 hours')
              AND cost_usd > 0
            GROUP BY agent_id
            ORDER BY cost DESC LIMIT 1`
        ).first<{ agent_id: string; cost: number }>();
        await emitPlatformNotification(env, 'platform_ai_spend_burst',
          renderPlatformAiSpendBurst({
            spent_24h_usd: budgetStatus.daily_burn_rate,
            threshold_usd: budgetStatus.config.monthly_limit_usd / 30,
            top_agent: topAgent?.agent_id ?? 'unknown',
            top_agent_cost_usd: topAgent?.cost ?? 0,
          })
        );
      }
    } catch { /* notification failures never break FC */ }

    mark('ai_spend_emit');

    // ── NX6: D1 daily-budget heartbeat ─────────────────────────────
    // Polls the cached CF GraphQL value via lib/d1-budget.getBudgetState
    // (refreshes at most hourly). Two-step alert: warn at 85% of plan,
    // breach at 100%. Both daily-deduped via group_key in the templates
    // so the bell rings once per day per state, not every FC tick.
    try {
      const budget = await getBudgetState(env);
      if (budget && !budget.stale && budget.rowsRead24h > 0) {
        const pctUsed = Math.round((budget.rowsRead24h / DAILY_BUDGET) * 100);
        if (budget.rowsRead24h >= DAILY_BUDGET) {
          await emitPlatformNotification(env, 'platform_d1_budget_breach',
            renderPlatformD1BudgetBreach({
              pct_used: pctUsed,
              reads_today: budget.rowsRead24h,
              daily_limit: DAILY_BUDGET,
            })
          );
        } else if (budget.rowsRead24h >= WARN_THRESHOLD) {
          await emitPlatformNotification(env, 'platform_d1_budget_warn',
            renderPlatformD1BudgetWarn({
              pct_used: pctUsed,
              reads_today: budget.rowsRead24h,
              daily_limit: DAILY_BUDGET,
            })
          );
        }
      }
    } catch { /* notification failures never break FC */ }

    mark('d1_budget_emit');

    // ── NX6: feed-at-risk pre-warning ──────────────────────────────
    // Fires for feeds whose consecutive_failures has reached >=60% of
    // their auto-pause threshold but haven't yet auto-paused. Gives
    // operators a heads-up before the circuit breaker trips. Dedup is
    // (feed_name, today) via group_key in the template.
    try {
      const atRiskRows = await db.prepare(`
        SELECT
          fs.feed_name,
          fc.display_name,
          fs.consecutive_failures,
          COALESCE(fc.consecutive_failure_threshold, 5) AS threshold
        FROM feed_status fs
        JOIN feed_configs fc ON fc.feed_name = fs.feed_name
        WHERE fc.enabled = 1
          AND fs.consecutive_failures >= COALESCE(fc.consecutive_failure_threshold, 5) * 0.6
          AND fs.consecutive_failures < COALESCE(fc.consecutive_failure_threshold, 5)
      `).all<{
        feed_name: string; display_name: string;
        consecutive_failures: number; threshold: number;
      }>();
      for (const row of atRiskRows.results) {
        await emitPlatformNotification(env, 'platform_feed_at_risk',
          renderPlatformFeedAtRisk({
            feed_id: row.feed_name,
            feed_name: row.display_name ?? row.feed_name,
            consecutive_failures: row.consecutive_failures,
            threshold: row.threshold,
            pct_to_auto_pause: Math.round((row.consecutive_failures / row.threshold) * 100),
          })
        );
      }
    } catch { /* notification failures never break FC */ }

    mark('feed_at_risk_emit');

    // ── Provider-escalation watcher (PR-B; baseline fixed 2026-05-27) ──
    // Fires when a hosting provider's active footprint jumps day-over-day.
    // Motivating case: Cloudflare 0 → 51,235 active threats with no signal.
    //
    // BASELINE FIX (2026-05-27 audit): the original query compared
    // hosting_providers.active_threat_count (ALL-TIME active count) against
    // provider_threat_stats period='7d' (threats CREATED in the last 7
    // days). Those are different quantities — for any established provider
    // all-time-active hugely exceeds the 7-day-created count, so the "5×"
    // test was ~always true and every large provider fired daily (Cloudflare
    // active=54,591 vs 7d=1,342). We now compare against yesterday's
    // active-threat snapshot from daily_snapshots — a like-for-like
    // active-footprint count — so only a genuine day-over-day surge fires.
    //
    //   - current active_threat_count ≥ 50 (ignore near-empty providers)
    //   - a yesterday snapshot must EXIST (INNER JOIN). No baseline ⇒ skip,
    //     not fire — avoids the "missing row ⇒ baseline 0 ⇒ always fires"
    //     trap that produced the original storm.
    //   - AND current ≥ 2× yesterday  (a doubling; with baseline≈0 this
    //     reduces to the absolute-delta rule, catching the 0→big case)
    //   - AND current − yesterday ≥ 200 net-new active threats.
    //
    // group_key is `platform_provider_escalation:<provider_id>` with a 24h
    // dedup window (see platform-templates).
    try {
      // daily_snapshots stores entity_id = hosting_providers.id for
      // entity_type='provider' (lib/snapshots.ts), and active_threats =
      // COUNT(*) WHERE status='active' as of that night — the exact
      // like-for-like counterpart to hosting_providers.active_threat_count.
      const escRows = await db.prepare(`
        SELECT hp.id, hp.name, hp.active_threat_count AS current_count,
               ds.active_threats AS baseline_count
          FROM hosting_providers hp
          JOIN daily_snapshots ds
            ON ds.entity_type = 'provider'
           AND ds.entity_id = hp.id
           AND ds.date = date('now', '-1 day')
         WHERE hp.active_threat_count >= 50
           AND hp.active_threat_count >= 2 * ds.active_threats
           AND hp.active_threat_count - ds.active_threats >= 200
         ORDER BY (hp.active_threat_count - ds.active_threats) DESC
         LIMIT 10
      `).all<{
        id: string; name: string;
        current_count: number; baseline_count: number;
      }>();
      // Bulk-event guard (belt-and-suspenders): with the corrected baseline
      // a real >=5-provider day-over-day surge is rare, but if it happens
      // it's far more likely a bulk re-attribution/enrichment pass than 5
      // concurrent campaigns — roll those up into a single notification
      // rather than spamming one per provider.
      const BULK_ESCALATION_THRESHOLD = 5;
      const tripped = escRows.results;
      if (tripped.length >= BULK_ESCALATION_THRESHOLD) {
        const top = [...tripped]
          .sort((a, b) => (b.current_count - b.baseline_count) - (a.current_count - a.baseline_count))
          .slice(0, 3)
          .map((r) => `${r.name} (${r.current_count.toLocaleString()})`)
          .join(', ');
        await emitPlatformNotification(env, 'platform_provider_escalation', {
          title: `Provider surge across ${tripped.length} providers — likely bulk re-attribution`,
          message:
            `${tripped.length} hosting providers more than doubled their active-threat footprint vs ` +
            `yesterday in the same tick (top: ${top}). Simultaneous day-over-day jumps across many major ` +
            `providers almost always mean a bulk enrichment/attribution pass moved a large batch of ` +
            `threats at once, not ${tripped.length} concurrent campaigns.`,
          reason_text: `Platform alert — operational only.`,
          recommended_action:
            `Confirm a recent bulk attribution/enrichment run. If a single provider is genuinely surging ` +
            `it will re-alert on its own once the others settle.`,
          link: '/providers',
          // Day-scoped so the rolled-up event dedups to one alert per day.
          group_key: `platform_provider_escalation:bulk:${new Date().toISOString().slice(0, 10)}`,
          audience: 'super_admin',
          severity: 'high',
        });
      } else {
        for (const row of tripped) {
          const delta = row.current_count - row.baseline_count;
          const multiplier = row.baseline_count > 0
            ? row.current_count / row.baseline_count
            : row.current_count; // pure new-provider surge case
          await emitPlatformNotification(env, 'platform_provider_escalation',
            renderPlatformProviderEscalation({
              provider_id:    row.id,
              provider_name:  row.name,
              current_count:  row.current_count,
              baseline_count: row.baseline_count,
              delta,
              multiplier,
            }),
          );
        }
      }
    } catch { /* notification failures never break FC */ }

    mark('provider_escalation_emit');

    // ── Backlog B1: cron heartbeat self-monitors ─────────────────
    // FC itself runs in the orchestrator path, so if FC is running
    // it means the orchestrator just ran. We check the OTHER cron —
    // navigator (every 5 min) — and warn if it's silent for >15 min.
    // Also surface orchestrator gaps detected via agent_runs scan.
    try {
      const navLast = await db.prepare(
        `SELECT MAX(started_at) AS last_at FROM agent_runs
          WHERE agent_id IN ('navigator','fast_tick')`
      ).first<{ last_at: string | null }>();
      const navMinutes = navLast?.last_at
        ? Math.round((Date.now() - Date.parse(navLast.last_at)) / 60_000)
        : 999;
      if (navMinutes >= 15) {
        await emitPlatformNotification(env, 'platform_cron_navigator_missed',
          renderPlatformCronMissed({
            cron: 'navigator',
            expected_interval_minutes: 5,
            minutes_since_last: navMinutes,
          })
        );
      }
      // The orchestrator dispatches FC every tick; we don't write a
      // dedicated 'orchestrator' row to agent_runs, only the
      // sub-agents do. Use FC's last run time as the orchestrator
      // proxy. Earlier code queried WHERE agent_id='orchestrator'
      // which always returned NULL → fired a false 999-min alert
      // every FC tick (operator screenshot 2026-04-30).
      const orchLast = await db.prepare(
        `SELECT MAX(started_at) AS last_at FROM agent_runs
          WHERE agent_id = 'flight_control'`
      ).first<{ last_at: string | null }>();
      const orchMinutes = orchLast?.last_at
        ? Math.round((Date.now() - Date.parse(orchLast.last_at)) / 60_000)
        : 999;
      if (orchMinutes >= 90) {
        await emitPlatformNotification(env, 'platform_cron_orchestrator_missed',
          renderPlatformCronMissed({
            cron: 'orchestrator',
            expected_interval_minutes: 60,
            minutes_since_last: orchMinutes,
          })
        );
      }
    } catch { /* notification failures never break FC */ }

    mark('cron_heartbeats');

    // ── Enrichment backlog warnings ──────────────────────────────
    if (backlogs.surblUnchecked > 1000) {
      await logActivity(db, 'flight_control', 'warning', 'enrichment_backlog',
        `SURBL enrichment backlog: ${backlogs.surblUnchecked} domains unchecked`,
        { backlog: 'surbl', count: backlogs.surblUnchecked }
      );
    }

    // ── platform_enrichment_stuck_pile — real signal ───────────────
    // Audit doc §13 defines stuck_pile as "threats marked enriched
    // but missing geo data" — same query the diagnostics endpoint
    // exposes. The earlier wiring used the SURBL backlog, which is a
    // different (and routine) signal. SURBL backlog stays as an
    // activity-log line; the super_admin notification fires only on
    // the genuine stuck-pile metric.
    try {
      // FC ticks every hour via the orchestrator and was full-
      // scanning threats every tick. Wrap in cachedCount with a 5-
      // min TTL — short enough that the stuck-pile threshold check
      // stays meaningful, long enough that consecutive ticks
      // within 5 min hit cache. ~24 ticks/day × 230K rows/query =
      // ~5.5M rows/day eliminated.
      const stuckCount = await cachedCount(env, 'count.threats.enriched_no_geo', 300, async () => {
        const row = await db.prepare(
          `SELECT COUNT(*) AS n FROM threats
            WHERE enriched_at IS NOT NULL AND lat IS NULL AND ip_address IS NOT NULL`
        ).first<{ n: number }>();
        return row?.n ?? 0;
      });
      const STUCK_THRESHOLD = 100;
      if (stuckCount >= STUCK_THRESHOLD) {
        await emitPlatformNotification(env, 'platform_enrichment_stuck_pile',
          renderPlatformEnrichmentStuck({
            stuck_count: stuckCount,
            threshold: STUCK_THRESHOLD,
          })
        );
      }
    } catch { /* notification failures never break FC */ }

    // ── DNS queue health check (PR-3 of DNS-queue split) ──
    // Two distinct failure modes to surface:
    //   1. Drift: |dns_queue.size - threats.drainable| > 500 means the
    //      reconciler isn't keeping up. Either reconciler is failing
    //      (see PR-2b debug counters) or a writer regressed. dns-
    //      backfill reads from queue, so drift = lost work.
    //   2. Stalled: no enqueue or dequeue activity in the last 30 min
    //      across all reconciler runs visible in agent_outputs. Means
    //      reconciler is alive but doing nothing — likely a binding
    //      issue or D1 transient that's eating writes.
    // Both gated on env.DNS_QUEUE_DB to skip cleanly when the binding
    // isn't yet rolled out to a given environment.
    if (env.DNS_QUEUE_DB) {
      try {
        const queueDb = env.DNS_QUEUE_DB;

        // Snapshot queue size + threats-drainable in parallel.
        // TTL 1800s so this key coheres with the dns-queue reconciler,
        // which reads it every 5-min Navigator tick — at a 300s tick a
        // 600s TTL only cleared alternate ticks (~50% hit ceiling), so
        // 1800s lifts the Navigator path to ~83% hits. Queue size feeds
        // the drift gauge below (threshold 500); 30-min staleness moves
        // it only tens of rows, far under that threshold, so the alert
        // stays correct. MUST match the reconciler's TTL.
        const [queueSizeRow, drainableRow] = await Promise.all([
          cachedCount(env, 'count.dns_queue.size', 1800, async () => {
            const r = await queueDb.prepare('SELECT COUNT(*) AS n FROM dns_queue').first<{ n: number }>();
            return r?.n ?? 0;
          }).then((n) => ({ n })),
          // PR-4: dropped INDEXED BY hint + the
          // `enrichment_attempts < 8` filter. Threats.attempts is
          // no longer written (dns_queue owns the state), so the
          // legacy filter would exclude no rows anyway. The drift
          // check is now "count of threats needing DNS resolution
          // by existence" vs "count of rows in dns_queue".
          cachedCount(env, 'count.threats.dns_drainable', 300, async () => {
            const r = await db.prepare(`
              SELECT COUNT(DISTINCT malicious_domain) AS n
              FROM threats
              WHERE ip_address IS NULL
                AND status = 'active'
                AND dns_exhausted_at IS NULL
                AND malicious_domain IS NOT NULL
                AND malicious_domain != ''
                AND malicious_domain NOT LIKE '*%'
                AND malicious_domain LIKE '%.%'
            `).first<{ n: number }>();
            return r?.n ?? 0;
          }).then((n) => ({ n })),
        ]);

        const queueSize = queueSizeRow.n;
        const drainable = drainableRow.n;
        const drift = Math.abs(queueSize - drainable);
        const DRIFT_THRESHOLD = 500;

        if (drift > DRIFT_THRESHOLD) {
          await emitPlatformNotification(env, 'platform_dns_queue_drift',
            renderPlatformDnsQueueDrift({
              drift,
              threshold: DRIFT_THRESHOLD,
              queue_size: queueSize,
              drainable_in_threats: drainable,
            })
          );
        }

        // Stall detection (PR-BI cursor architecture) — read the
        // latest reconciler diagnostic's `cursor_lag_minutes`. The
        // cursor advances whenever new candidates land in threats;
        // if drainable > queueSize + drift threshold AND cursor is
        // lagging by >30 min, the reconciler is broken (cursor not
        // advancing despite available work).
        //
        // A quiet queue with nothing to drain legitimately has
        // cursor_lag_minutes growing — that's not a stall. We
        // require BOTH conditions: lag is high AND drainable > queue.
        const lastReconciler = await db.prepare(`
          SELECT details, created_at
          FROM agent_outputs
          WHERE agent_id = 'navigator'
            AND type = 'diagnostic'
            AND summary LIKE 'dns-queue-reconcile%'
          ORDER BY created_at DESC
          LIMIT 1
        `).first<{ details: string | null; created_at: string }>();

        if (lastReconciler?.details) {
          try {
            const parsed = JSON.parse(lastReconciler.details) as {
              cursor_lag_minutes?: number;
              skipped?: boolean;
            };
            const lag = parsed.cursor_lag_minutes ?? 0;
            const STALL_THRESHOLD_MIN = 30;
            if (
              !parsed.skipped
              && lag > STALL_THRESHOLD_MIN
              && drainable > queueSize + DRIFT_THRESHOLD
            ) {
              await emitPlatformNotification(env, 'platform_dns_queue_stalled',
                renderPlatformDnsQueueStalled({
                  minutes_idle: lag,
                  threshold_minutes: STALL_THRESHOLD_MIN,
                  queue_size: queueSize,
                  drainable_in_threats: drainable,
                })
              );
            }
          } catch {
            // Defensive — malformed JSON shouldn't crash FC.
          }
        }

        // Reaper stall detection (PR-BI). The daily reaper writes
        // KV stamps at end of each run. Past 36 h without a stamp
        // means the hour===0 Navigator tick is failing or the
        // reaper itself is broken. Ghost rows accumulate but drain
        // is unaffected — medium severity.
        try {
          const lastReaperRun = await env.CACHE.get('reconciler:dns_queue:reaper_last_run');
          const REAPER_STALL_THRESHOLD_H = 36;
          if (lastReaperRun) {
            const reaperMs = Date.parse(lastReaperRun);
            if (!Number.isNaN(reaperMs)) {
              const hoursSince = Math.floor((Date.now() - reaperMs) / 3_600_000);
              if (hoursSince > REAPER_STALL_THRESHOLD_H) {
                const lastDeltaStr = await env.CACHE.get('reconciler:dns_queue:reaper_last_delta');
                const lastDelta = lastDeltaStr != null ? parseInt(lastDeltaStr, 10) : null;
                await emitPlatformNotification(env, 'platform_dns_queue_reaper_stalled',
                  renderPlatformDnsQueueReaperStalled({
                    hours_since_last_run: hoursSince,
                    threshold_hours: REAPER_STALL_THRESHOLD_H,
                    last_stale_removed: Number.isNaN(lastDelta as number) ? null : lastDelta,
                    queue_size: queueSize,
                  })
                );
              }
            }
          }
          // If no KV stamp exists yet, this is bootstrap — the first
          // hour===0 tick after deploy will populate it. No alert
          // until we have at least one prior run as a baseline.
        } catch (err) {
          console.warn('[flight-control] reaper stall check failed:', err);
        }
      } catch (err) {
        console.warn('[flight-control] dns_queue health check failed:', err);
      }
    }

    // ── Abuse mailbox classifier silence check (PR-AY) ──
    // Pending row count is computed via a single COUNT — cheap. Last
    // successful classifier completion is read from budget_ledger,
    // which is the ground truth: a row appears there iff the
    // classifier made a Haiku call (the per-row attempt counter is
    // incremented BEFORE the AI call, so attempts > 0 alone isn't a
    // signal that classification SUCCEEDED).
    //
    // Threshold 2h: classifier promise is "determination within ~1
    // hour"; 2h gives one missed cron tick of grace before alerting.
    // Only fires when pending > 0 AND oldest pending > threshold —
    // a quiet inbox with no pending rows is fine to be silent.
    try {
      const SILENCE_THRESHOLD_HOURS = 2;
      const pendingRow = await db.prepare(`
        SELECT COUNT(*) AS n,
               MIN(received_at) AS oldest
        FROM abuse_inbox_messages
        WHERE classification = 'pending'
          AND COALESCE(throttled, 0) = 0
          AND COALESCE(classification_attempts, 0) < 3
      `).first<{ n: number; oldest: string | null }>();

      const pendingCount = pendingRow?.n ?? 0;
      if (pendingCount > 0 && pendingRow?.oldest) {
        const oldestMs = Date.parse(pendingRow.oldest + 'Z');
        const oldestHours = (Date.now() - oldestMs) / 3_600_000;

        // Only alert when the oldest pending row is old enough that
        // we KNOW a cron tick should have processed it.
        if (oldestHours > SILENCE_THRESHOLD_HOURS) {
          const lastRow = await db.prepare(`
            SELECT MAX(created_at) AS last_at
            FROM budget_ledger
            WHERE agent_id = 'abuse_mailbox_classifier'
          `).first<{ last_at: string | null }>();
          const lastAt = lastRow?.last_at;
          const hoursSilent = lastAt
            ? (Date.now() - Date.parse(lastAt + 'Z')) / 3_600_000
            : oldestHours;

          if (hoursSilent > SILENCE_THRESHOLD_HOURS) {
            await emitPlatformNotification(env, 'platform_abuse_classifier_silent',
              renderPlatformAbuseClassifierSilent({
                hours_silent: hoursSilent,
                threshold_hours: SILENCE_THRESHOLD_HOURS,
                pending_count: pendingCount,
                oldest_pending_hours: oldestHours,
              })
            );
          }
        }
      }
    } catch (err) {
      console.warn('[flight-control] abuse classifier silence check failed:', err);
    }

    // ─── Spam-trap silent-failure guard ──────────────────────────────
    // Watch the OUTCOME, not the agent's self-reported "success": the
    // auto-seeder once planted 0 for ~5 weeks while reporting success, and
    // captures dried up unnoticed. Fire on seed-roster + capture staleness.
    try {
      const SEED_STALE_DAYS = 10;     // seeder runs weekly, plants ~96; >10d = a missed cycle
      const CAPTURE_STALE_DAYS = 14;  // captures are sparse; 14d of zero is clearly abnormal
      const isoAgeDays = (ts: string) =>
        (Date.now() - Date.parse(ts.replace(' ', 'T') + 'Z')) / 86_400_000;

      const seedRow = await db.prepare(
        `SELECT MAX(seeded_at) AS last_seed FROM seed_addresses`,
      ).first<{ last_seed: string | null }>();
      if (seedRow?.last_seed) {
        const days = isoAgeDays(seedRow.last_seed);
        if (Number.isFinite(days) && days > SEED_STALE_DAYS) {
          await emitPlatformNotification(env, 'platform_spam_trap_seeding_stalled',
            renderPlatformSpamTrapSeedingStalled({ days_since_seed: days, threshold_days: SEED_STALE_DAYS }));
        }
      }

      const capRow = await db.prepare(
        `SELECT MAX(captured_at) AS last_cap FROM spam_trap_captures`,
      ).first<{ last_cap: string | null }>();
      if (capRow?.last_cap) {
        const days = isoAgeDays(capRow.last_cap);
        if (Number.isFinite(days) && days > CAPTURE_STALE_DAYS) {
          await emitPlatformNotification(env, 'platform_spam_trap_capture_stale',
            renderPlatformSpamTrapCaptureStale({ days_since_capture: days, threshold_days: CAPTURE_STALE_DAYS }));
        }
      }
    } catch (err) {
      console.warn('[flight-control] spam-trap freshness check failed:', err);
    }

    // Collect enrichment backlog warnings into a single D1 batch
    // instead of awaiting 7 sequential INSERTs. Pre-fix this phase
    // was 4s on the 14s FC tick; with one batch round-trip it
    // drops to ~50-200ms.
    const enrichmentLogStmts: D1PreparedStatement[] = [];
    if (backlogs.vtUnchecked > 500) {
      enrichmentLogStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'enrichment_backlog',
        `VT enrichment backlog: ${backlogs.vtUnchecked} high-severity threats unchecked`,
        { backlog: 'virustotal', count: backlogs.vtUnchecked }));
    }
    if (backlogs.gsbUnchecked > 1000) {
      enrichmentLogStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'enrichment_backlog',
        `GSB enrichment backlog: ${backlogs.gsbUnchecked} URLs/domains unchecked`,
        { backlog: 'google_safe_browsing', count: backlogs.gsbUnchecked }));
    }
    if (backlogs.dblUnchecked > 1000) {
      enrichmentLogStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'enrichment_backlog',
        `DBL enrichment backlog: ${backlogs.dblUnchecked} domains unchecked`,
        { backlog: 'spamhaus_dbl', count: backlogs.dblUnchecked }));
    }
    if (backlogs.abuseipdbUnchecked > 500) {
      enrichmentLogStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'enrichment_backlog',
        `AbuseIPDB enrichment backlog: ${backlogs.abuseipdbUnchecked} IPs unchecked`,
        { backlog: 'abuseipdb', count: backlogs.abuseipdbUnchecked }));
    }
    if (backlogs.pdnsUnchecked > 200) {
      enrichmentLogStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'enrichment_backlog',
        `PDNS enrichment backlog: ${backlogs.pdnsUnchecked} domains unchecked`,
        { backlog: 'circl_pdns', count: backlogs.pdnsUnchecked }));
    }
    if (backlogs.greynoiseUnchecked > 100) {
      enrichmentLogStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'enrichment_backlog',
        `GreyNoise enrichment backlog: ${backlogs.greynoiseUnchecked} high-severity IPs unchecked`,
        { backlog: 'greynoise', count: backlogs.greynoiseUnchecked }));
    }
    if (backlogs.seclookupUnchecked > 1000) {
      enrichmentLogStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'enrichment_backlog',
        `SecLookup enrichment backlog: ${backlogs.seclookupUnchecked} threats unchecked`,
        { backlog: 'seclookup', count: backlogs.seclookupUnchecked }));
    }
    if (enrichmentLogStmts.length > 0) {
      try { await db.batch(enrichmentLogStmts); } catch { /* never break FC */ }
    }

    mark('enrichment_warnings');

    // ── Watchdog social mention backlog ─────────────────────────────
    if (backlogs.watchdog > 100) {
      await logActivity(db, 'flight_control', 'warning', 'social_backlog',
        `Watchdog backlog: ${backlogs.watchdog} unclassified social mentions`,
        { backlog: 'watchdog', count: backlogs.watchdog }
      );
    }

    // High backlog: trigger additional watchdog run
    if (backlogs.watchdog > 200) {
      const { agentModules: allAgents } = await import('./index');
      const { executeAgent } = await import('../lib/agentRunner');
      const watchdogMod = allAgents['watchdog'];
      if (watchdogMod) {
        try {
          await executeAgent(env, watchdogMod, { trigger: 'flight_control_backlog', backlog: backlogs.watchdog }, 'flight_control', 'event');
        } catch { /* logged by agentRunner */ }
        await logActivity(db, 'flight_control', 'info', 'scaling',
          `Triggered extra Watchdog run — backlog: ${backlogs.watchdog} unclassified social mentions`,
          { agent: 'watchdog', backlog: backlogs.watchdog }
        );
      }
    }

    // ── Degraded feed health monitoring ───────────────────────────
    if (degradedFeeds.results.length > 0) {
      for (const feed of degradedFeeds.results) {
        await logActivity(db, 'flight_control', 'warning', 'feed_degraded',
          `Feed ${feed.feed_name} is ${feed.health_status}${feed.last_failure ? ` (last failure: ${feed.last_failure})` : ''}`,
          { feed_name: feed.feed_name, health_status: feed.health_status, last_failure: feed.last_failure }
        );
      }
    }

    // ── Push subscription cleanup ──────────────────────────────────
    // Browser push endpoints rotate frequently (SW updates, storage
    // clears, VAPID rotations). The dispatcher already deletes rows
    // that return 410/404 on a push attempt, but rows that were
    // never used (no push ever sent to them) accumulate forever.
    // Auto-prune any subscription that's never been used and is
    // >7 days old — those endpoints are almost certainly dead.
    try {
      await db.prepare(
        `DELETE FROM push_subscriptions
          WHERE last_used_at IS NULL
            AND created_at < datetime('now','-7 days')`
      ).run();
    } catch { /* non-fatal */ }

    mark('feed_health_pre');

    // ── Auto-paused feed surfacing ────────────────────────────────
    // feedRunner already wrote a critical agent_activity_log row at the
    // moment of the pause transition, so we don't need another
    // per-feed critical entry here. Just log a single roll-up so the
    // FC dashboard timeline shows the current count without spamming.
    if (autoPausedFeeds.results.length > 0) {
      await logActivity(db, 'flight_control', 'warning', 'feeds_auto_paused',
        `${autoPausedFeeds.results.length} feed${autoPausedFeeds.results.length === 1 ? '' : 's'} currently auto-paused: ${autoPausedFeeds.results.map(f => f.feed_name).join(', ')}`,
        { count: autoPausedFeeds.results.length, feeds: autoPausedFeeds.results.map(f => ({ feed_name: f.feed_name, consecutive_failures: f.consecutive_failures })) }
      );

      // N6b — emit a platform_feed_auto_paused notification per feed.
      // group_key=feed_id means a refresh for the same paused feed
      // dedups within the registry window; only a NEW feed pausing
      // (or a re-pause after recovery) breaks dedup.
      for (const feed of autoPausedFeeds.results) {
        try {
          // Fetch last failure error message — best-effort, the
          // notification is useful even without it.
          const lastErr = await db.prepare(
            `SELECT error_message FROM feed_pull_history
              WHERE feed_name = ? AND status = 'failed'
              ORDER BY started_at DESC LIMIT 1`
          ).bind(feed.feed_name).first<{ error_message: string | null }>();
          await emitPlatformNotification(env, 'platform_feed_auto_paused',
            renderPlatformFeedAutoPaused({
              feed_id: feed.feed_name,
              feed_name: feed.feed_name,
              consecutive_failures: feed.consecutive_failures,
              last_error: lastErr?.error_message ?? null,
            })
          );
        } catch { /* notification failures never break FC */ }
      }
    }

    // ── Silent-ingest watchdog ────────────────────────────────────
    // Defensive companion to the auto-pause path. Catches the class
    // of bug where runAllFeeds throws BEFORE any per-feed dispatch
    // (so consecutive_failures never increments and feeds never get
    // auto-paused), or where a deploy silently drops feeds from the
    // dispatch loop. Triggered by elapsed-vs-interval ratio rather
    // than failure count, so it fires regardless of cause.
    //
    // Threshold of 3× schedule_cron interval is generous enough that
    // a feed legitimately running on its schedule never fires (max
    // jitter we've seen is ~1.4× from the orchestrator's :07 cron
    // alignment). 3× also tolerates one missed tick + one retry.
    //
    // IMPORTANT: feed schedule_cron values like `*/5 * * * *` mean
    // "minimum 5 min between pulls" — they do NOT mean the feed
    // actually pulls every 5 min. The orchestrator only invokes
    // runAllFeeds() once per hour at :07, so the maximum achievable
    // dispatch cadence is 60 min regardless of what the cron says.
    // Without this floor every sub-hourly feed (urlhaus, ct_logs,
    // abuseipdb, seclookup, surbl, gsb, dbl) would false-positive at
    // ~12× within an hour of a successful pull. The floor matches
    // the dispatcher cadence (60 min); coarser-than-hourly crons
    // (`0 */6 * * *`, `0 */12 * * *`, `0 0 * * *`) are unaffected.
    //
    // group_key in the renderer is day-keyed so the operator gets at
    // most one alert per day even if 20 feeds go silent at once.
    {
      const SILENT_RATIO_THRESHOLD = 3;
      const DISPATCHER_CADENCE_MS = 60 * 60 * 1000; // 60 min — orchestrator runs hourly
      const nowMs = Date.now();
      const overdue: Array<{ feed_name: string; ratio: number; hours_since: number }> = [];

      for (const cand of silentFeedCandidates.results) {
        const cronInterval = parseCronIntervalMs(cand.schedule_cron);
        const effectiveIntervalMs = Math.max(cronInterval, DISPATCHER_CADENCE_MS);
        const lastPullStr = cand.last_successful_pull;
        const lastMs = Date.parse(
          lastPullStr.includes('Z') || lastPullStr.includes('+') ? lastPullStr : lastPullStr + 'Z'
        );
        if (!Number.isFinite(lastMs)) continue;
        const elapsedMs = nowMs - lastMs;
        const ratio = elapsedMs / effectiveIntervalMs;
        if (ratio >= SILENT_RATIO_THRESHOLD) {
          overdue.push({
            feed_name: cand.feed_name,
            ratio,
            hours_since: Math.round(elapsedMs / 3_600_000),
          });
        }
      }

      if (overdue.length > 0) {
        // Sort worst-first so the title surfaces the most overdue feed.
        overdue.sort((a, b) => b.ratio - a.ratio);
        const worst = overdue[0]!;

        await logActivity(db, 'flight_control', 'critical', 'feeds_silent',
          `${overdue.length} enabled feed${overdue.length === 1 ? ' has' : 's have'} not pulled in 3×+ their schedule_cron interval: ${overdue.map(o => `${o.feed_name} (${o.ratio.toFixed(1)}×)`).join(', ')}`,
          { count: overdue.length, feeds: overdue }
        );

        try {
          await emitPlatformNotification(env, 'platform_feed_silent',
            renderPlatformFeedSilent({
              feed_ids: overdue.map(o => o.feed_name).join(', '),
              feed_count: overdue.length,
              worst_ratio: worst.ratio,
              worst_feed: worst.feed_name,
              worst_hours_since_pull: worst.hours_since,
              cause_hint: null,
            })
          );
        } catch { /* notification failures never break FC */ }
      }
    }

    mark('feed_paused_emit');

    // ── N6c: briefing-silent self-monitor ────────────────────────
    // The daily threat briefing is dispatched at hour 13:00 UTC by
    // the orchestrator cron. If no successful row exists in
    // threat_briefings for the last 36h, fire a critical
    // platform_briefing_silent notification. group_key dedup keeps
    // this firing at most once per 12 hours.
    try {
      const lastBriefing = await db.prepare(
        `SELECT MAX(generated_at) AS last_at
           FROM threat_briefings
          WHERE emailed = 1
            AND generated_at >= datetime('now', '-72 hours')`
      ).first<{ last_at: string | null }>();
      const hoursSince = lastBriefing?.last_at
        ? Math.round((Date.now() - Date.parse(lastBriefing.last_at)) / 3_600_000)
        : 73;
      if (hoursSince >= 36) {
        await emitPlatformNotification(env, 'platform_briefing_silent',
          renderPlatformBriefingSilent({
            hours_since_last_briefing: hoursSince,
            expected_within_hours: 24,
          })
        );
      } else {
        // Briefing pipeline is healthy — auto-resolve any still-open
        // platform_briefing_silent incident. Without this the incident
        // sits in `monitoring` state forever and operators have to
        // remember to close it manually. The notification system
        // already debounces re-fires via group_key dedup, so the
        // inverse (auto-resolve on heal) is the symmetric move.
        // Bundle F (2026-05-07) audit C12 follow-up.
        try {
          const openIncident = await db.prepare(
            `SELECT id FROM incidents
               WHERE source = 'auto:platform_briefing_silent'
                 AND status != 'resolved'
               ORDER BY created_at DESC
               LIMIT 1`
          ).first<{ id: string }>();
          if (openIncident?.id) {
            await db.prepare(
              `INSERT INTO incident_updates (incident_id, message, status, created_at)
               VALUES (?, ?, 'resolved', datetime('now'))`
            ).bind(
              openIncident.id,
              `Auto-resolved by Flight Control: briefing pipeline healthy (last successful briefing ${hoursSince}h ago, threshold 36h).`
            ).run();
            await transitionIncidentStatus(env, openIncident.id, 'resolved');
          }
        } catch { /* incident resolution failures never break FC */ }
      }
    } catch { /* notification failures never break FC */ }

    // ── PR-BB: 2026-05-30 DMARC ramp reminder ─────────────────────
    // Fires daily on or after 2026-05-30 reminding the operator to
    // flip _dmarc.averrow.com + .ca from p=none → p=quarantine,
    // which activates the BIMI logo in Yahoo / Apple Mail / Fastmail
    // inboxes. See docs/BIMI_SETUP_RUNBOOK.md.
    //
    // Self-disables: each tick performs a DoH TXT lookup (cached
    // 1h in KV) on both DMARC records. If BOTH already read
    // p=quarantine or p=reject, we skip the emit — the ramp is
    // done, no need to keep nudging.
    //
    // Date comparison uses UTC YYYY-MM-DD strings, so it doesn't
    // depend on the FC tick's local clock.
    const DMARC_RAMP_DATE_UTC = '2026-05-30';
    const todayUtc = new Date().toISOString().slice(0, 10);
    if (todayUtc >= DMARC_RAMP_DATE_UTC) {
      try {
        const [comRecords, caRecords] = await Promise.all([
          dohTxtLookup(env, '_dmarc.averrow.com'),
          dohTxtLookup(env, '_dmarc.averrow.ca'),
        ]);
        const comDmarc = comRecords.map(parseDmarcPolicy).find((p) => p !== null) ?? null;
        const caDmarc  = caRecords.map(parseDmarcPolicy).find((p) => p !== null)  ?? null;

        const isRamped = (p: 'none' | 'quarantine' | 'reject' | null): boolean =>
          p === 'quarantine' || p === 'reject';

        if (!(isRamped(comDmarc) && isRamped(caDmarc))) {
          await emitPlatformNotification(env, 'platform_dmarc_ramp_reminder',
            renderPlatformDmarcRampReminder({
              averrow_com_policy: comDmarc,
              averrow_ca_policy:  caDmarc,
            })
          );
        }
      } catch (err) {
        console.warn('[flight-control] dmarc ramp reminder failed:', err);
      }
    }

    // ── PR-BK: 2026-05-27 Phase 2 D1-write-budget review reminder ─
    // Fires daily on/after 2026-05-27 (7 days after the Phase 1 write
    // cuts deployed via PR-BJ on 2026-05-20) IF the cycle write
    // projection still exceeds the 50M/mo Workers Paid included quota.
    //
    // Self-disable mirrors the DMARC pattern: each tick fetches
    // current billing-cycle metrics. If cycle_projection_rows_written
    // ≤ WRITES_INCLUDED_QUOTA, Phase 1 alone was enough and we skip
    // the emit — no Phase 2 work needed, the reminder turns itself
    // off without a follow-up PR.
    //
    // emitPlatformNotification dedupes to once per day via the
    // 'platform_d1_writes_phase2_review' event's dedupWindow=-1d, so
    // multiple FC ticks within a day collapse to one notification.
    //
    // The billing-cycle fetch (CF GraphQL) is the one network call
    // this adds. Gated on the date check first so pre-2026-05-27
    // ticks pay nothing.
    const PHASE2_REVIEW_DATE_UTC = '2026-05-27';
    if (todayUtc >= PHASE2_REVIEW_DATE_UTC) {
      try {
        // Blended gate: fire ONLY when BOTH the cycle-to-date projection AND
        // a trailing-7-day projection exceed the 50M quota. The cycle-to-date
        // number divides cumulative cycle writes by % elapsed, so a mid-cycle
        // write-rate drop (e.g. the PR-1460 hosting_providers/brand-summary
        // change-guards that took the real rate to ~10M/mo) stays inflated for
        // the rest of the cycle and would keep this nag firing falsely. Gating
        // on the recent-window rate too lets the alert self-resolve within ~7
        // days of the rate drop without suppressing the genuine signal. This
        // is a pure operator nag — it does NOT drive any write throttle (the
        // only real budget protection is the daily-READ skip in navigator).
        const [cycle, recent] = await Promise.all([
          fetchBillingCycleMetrics(env),
          fetchRecentWindowMetrics(env, 168), // trailing 7 days
        ]);

        const recentProjectionWrites =
          !recent.setup_required && !recent.error && recent.window_hours > 0
            ? Math.round((recent.rows_written / recent.window_hours) * 24 * cycle.cycle.days_total)
            : null;

        const cycleOver = !cycle.setup_required && !cycle.error
          && cycle.cycle_projection_rows_written > WRITES_INCLUDED_QUOTA;
        const recentOver = recentProjectionWrites != null
          && recentProjectionWrites > WRITES_INCLUDED_QUOTA;

        if (cycleOver && recentOver) {
          await emitPlatformNotification(env, 'platform_d1_writes_phase2_review',
            renderPlatformD1WritesPhase2Review({
              cycle_projection_rows_written: cycle.cycle_projection_rows_written,
              pct_of_50m_write_quota:        cycle.pct_of_50m_write_quota,
              rows_written_cycle:            cycle.rows_written_cycle,
              cycle_pct_elapsed:             cycle.cycle.pct_elapsed,
            })
          );
        }
      } catch (err) {
        console.warn('[flight-control] phase2 d1 write review failed:', err);
      }
    }

    // ── Auto-tripped agent surfacing ──────────────────────────────
    // Same pattern as auto-paused feeds: a single roll-up log line
    // per FC tick so the dashboard timeline shows the current count.
    // The critical notification was already fired by executeAgent()
    // at the moment of the transition.
    if (trippedAgents.results.length > 0) {
      await logActivity(db, 'flight_control', 'warning', 'agents_tripped',
        `${trippedAgents.results.length} agent${trippedAgents.results.length === 1 ? '' : 's'} circuit-tripped: ${trippedAgents.results.map(a => a.agent_id).join(', ')}`,
        { count: trippedAgents.results.length, agents: trippedAgents.results.map(a => ({ agent_id: a.agent_id, consecutive_failures: a.consecutive_failures })) }
      );
    }

    mark('briefing_silent_emit');

    // ── Layer C: GeoIP refresh stall supervisor ────────────────────
    // Catches geo_ip_refresh_log rows stuck in 'running' that the
    // workflow's failure handler (Layer A) missed AND the agent's
    // self-heal (Layer B) didn't reach because no new dispatch
    // happened. FC runs hourly so worst-case detection latency is
    // ~1 hour after the workflow died. Aligned with the existing
    // platform_agent_stalled pattern (§14.3 dedup via group_key).
    //
    // STUCK_THRESHOLD_MIN must sit ABOVE the import step's own timeout
    // (raised to 2h in workflows/geoipRefresh.ts), else FC force-fails a
    // legitimately-long import mid-flight — which is exactly what killed
    // the 2026-05-24 run (import was progressing at 60 min; FC marked it
    // failed). This age is measured from geo_ip_refresh_log.started_at,
    // which spans the whole workflow incl. retries, so it must clear a
    // single 2h attempt plus margin. 180 min is the backstop for TRULY
    // hung workflows; the step's own 2h timeout is the primary guard.
    //
    // Skipped when GEOIP_DB binding is unset — the table won't
    // exist, throwing on the SELECT. Wrapping in try/catch keeps
    // FC's tick robust against optional bindings.
    const GEOIP_STUCK_THRESHOLD_MIN = 180;
    if (env.GEOIP_DB) {
      try {
        const stuck = await env.GEOIP_DB.prepare(`
          SELECT id, source_version, started_at,
                 CAST((julianday('now') - julianday(started_at)) * 24 * 60 AS INTEGER) AS age_min
          FROM geo_ip_refresh_log
          WHERE status = 'running'
            AND started_at < datetime('now', '-' || ? || ' minutes')
        `).bind(GEOIP_STUCK_THRESHOLD_MIN).all<{
          id: string;
          source_version: string | null;
          started_at: string;
          age_min: number;
        }>();
        for (const row of stuck.results ?? []) {
          try {
            await env.GEOIP_DB.prepare(`
              UPDATE geo_ip_refresh_log
              SET status = 'failed',
                  completed_at = datetime('now'),
                  error_message = ?
              WHERE id = ? AND status = 'running'
            `).bind(
              `Auto-recovered by Flight Control: stuck >${GEOIP_STUCK_THRESHOLD_MIN} min`,
              row.id,
            ).run();
            await emitPlatformNotification(env, 'platform_geoip_refresh_stalled',
              renderPlatformGeoipRefreshStalled({
                refresh_log_id: row.id,
                minutes_running: row.age_min,
                source_version: row.source_version,
              }),
            );
          } catch { /* per-row failure shouldn't break FC tick */ }
        }
      } catch { /* table may not exist (binding present but migrations not yet applied) */ }
    }

    // ── Step C.2: GeoIP freshness check ────────────────────────────
    // Sister check to the stuck-running supervisor above: detects when
    // the LAST SUCCESSFUL refresh is older than the staleness threshold
    // and fires `platform_geoip_refresh_stalled`. The stuck-running path
    // only catches workflows that started + hung; this catches workflows
    // that never started (all attempts failed → no 'running' row at
    // all). Production 2026-05-16 caught a 11-day stale DB this way:
    // last success 2026-05-05, every subsequent attempt failed, FC
    // had no signal until an operator manually inspected.
    const GEOIP_STALE_DAYS = 7;
    if (env.GEOIP_DB) {
      try {
        const lastSuccess = await env.GEOIP_DB.prepare(`
          SELECT id, source_version, completed_at,
                 CAST((julianday('now') - julianday(completed_at)) AS INTEGER) AS age_days
          FROM geo_ip_refresh_log
          WHERE status = 'success'
          ORDER BY completed_at DESC
          LIMIT 1
        `).first<{ id: string; source_version: string | null; completed_at: string; age_days: number }>();
        if (lastSuccess && lastSuccess.age_days >= GEOIP_STALE_DAYS) {
          await emitPlatformNotification(env, 'platform_geoip_refresh_stalled',
            renderPlatformGeoipRefreshStalled({
              refresh_log_id: lastSuccess.id,
              minutes_running: lastSuccess.age_days * 24 * 60,
              source_version: lastSuccess.source_version,
              kind: 'stale',
              stale_days: lastSuccess.age_days,
            }),
          );

          // Self-heal: the refresh has only ONE scheduled attempt per week
          // (Sunday 02:00 cron). A single missed tick — exactly what happened
          // 2026-05-31 (no attempt row was even logged) — leaves the DB stale
          // for a full week with no retry. Re-dispatch here so staleness
          // recovers within the hour instead. A non-force refresh no-ops if
          // MaxMind is unchanged (and still stamps a fresh success row,
          // clearing the alert); the agent has its own running-workflow guard
          // + MaxMind 429 cooldown, so this is safe to call. A 6h KV cooldown
          // stops FC from re-dispatching every hourly tick while a refresh is
          // in flight or MaxMind is rate-limiting.
          try {
            const SELFHEAL_COOLDOWN_KEY = 'fc:geoip_selfheal_cooldown';
            const onCooldown = env.CACHE ? await env.CACHE.get(SELFHEAL_COOLDOWN_KEY) : null;
            if (!onCooldown) {
              if (env.CACHE) {
                await env.CACHE.put(SELFHEAL_COOLDOWN_KEY, new Date().toISOString(), { expirationTtl: 6 * 3600 });
              }
              const { geoipRefreshAgent } = await import('./geoip-refresh');
              const { executeAgent } = await import('../lib/agentRunner');
              await executeAgent(env, geoipRefreshAgent, { trigger: 'fc_staleness_selfheal' }, 'cron', 'event')
                .catch((e) => console.warn('[flight-control] geoip self-heal dispatch failed:', e));
              console.log(`[flight-control] geoip stale ${lastSuccess.age_days}d — dispatched self-heal refresh`);
            }
          } catch (e) {
            console.warn('[flight-control] geoip self-heal failed:', e);
          }
        }
      } catch { /* binding/table missing — same defensive pattern as above */ }
    }

    mark('geoip_refresh_supervisor');

    // ── Workflow dispatch supervisor ───────────────────────────────
    // Watches the `wf_last_dispatch:<workflow>` KV stamp written by
    // dispatchWorkflow() in lib/workflow-dispatch.ts. If a workflow
    // hasn't dispatched in expected_interval × 3, emit the
    // platform_workflow_dispatch_silent alert. This is the signal
    // that was missing on 2026-04-19 (commit 06881d0d) when nexus-run
    // and cartographer-backfill silently stopped firing.
    //
    // Skipped while nothing calls dispatchWorkflow() yet (the KV stamp
    // returns null). After PR-B switches cron over, the stamp gets
    // refreshed on every successful dispatch.
    const WORKFLOW_SUPERVISORS: Array<{
      name: 'cartographer-backfill' | 'nexus-run';
      expected_interval_hours: number;
    }> = [
      // Cartographer-backfill is dispatched after Sentinel feed pulls
      // (hourly when totalNew > 0). 3× = 3h before alerting.
      { name: 'cartographer-backfill', expected_interval_hours: 1 },
      // Nexus-run fires at hour % 4 === 0 — 6 dispatches per 24h.
      // 3× the interval = 12h.
      { name: 'nexus-run', expected_interval_hours: 4 },
    ];
    if (env.CACHE) {
      for (const wf of WORKFLOW_SUPERVISORS) {
        try {
          const lastDispatch = await getLastDispatchAt(env.CACHE, wf.name);
          const cooldownUntil = await getCooldownUntil(env.CACHE, wf.name);
          const cooldownActive = cooldownUntil !== null && cooldownUntil.getTime() > Date.now();

          // Skip when there's no stamp yet (workflow has never been
          // dispatched via the helper). This is the expected state
          // until PR-B is merged. Once dispatch begins, a missing
          // stamp would mean the dispatch path was never called —
          // not detectable here, but FC's other heartbeat surfaces
          // (cron_health, agent_runs) will flag it.
          if (lastDispatch === null) continue;

          const hoursSince = Math.floor((Date.now() - lastDispatch.getTime()) / (1000 * 60 * 60));
          const thresholdHours = wf.expected_interval_hours * 3;
          if (hoursSince >= thresholdHours) {
            await emitPlatformNotification(env, 'platform_workflow_dispatch_silent',
              renderPlatformWorkflowDispatchSilent({
                workflow: wf.name,
                hours_since_last_dispatch: hoursSince,
                expected_interval_hours: wf.expected_interval_hours,
                cooldown_active: cooldownActive,
              }),
            );
          }
        } catch {
          // Per-workflow failure shouldn't break the FC tick. The
          // KV read or emit could fail (KV momentary unavailability,
          // notification table issue) but we'd rather skip than throw.
        }
      }
    }

    mark('workflow_dispatch_supervisor');

    // ── C2 infrastructure overlap detection ────────────────────────
    //
    // Gated to hour===0 (once/day). Before this gate the block fired on
    // every FC tick (24+/day observed) and the IN-subquery on the
    // unbounded threats table burned ~17.7M rows/24h — the #3 read source
    // in `d1_top_queries_24h` per the 2026-05-23 diagnostic. The output
    // is an operator activity-log entry, not a time-critical security
    // alert, so daily latency is acceptable. PR-CB (priority 3 of the
    // diagnostics walk-through).
    //
    // Future improvement: the subquery `source_feed != 'c2_tracker' AND
    // ip_address IS NOT NULL` can't use idx_threats_source_feed (negation)
    // and currently does a wide scan. If c2_tracker volume grows, rewrite
    // as a self-join over the threats table keyed by ip_address with a
    // covering index on (ip_address, source_feed).
    if (new Date().getUTCHours() === 0) {
      try {
        const c2Overlap = await db.prepare(`
          SELECT COUNT(*) as cnt FROM threats
          WHERE source_feed = 'c2_tracker'
          AND ip_address IN (SELECT DISTINCT ip_address FROM threats WHERE source_feed != 'c2_tracker' AND ip_address IS NOT NULL)
        `).first<{ cnt: number }>();
        if (c2Overlap && c2Overlap.cnt > 0) {
          await logActivity(db, 'flight_control', 'warning', 'c2_overlap',
            `[flight-control] ${c2Overlap.cnt} C2 server IPs also appear in other threat feeds — infrastructure overlap detected`,
            { c2_overlap_count: c2Overlap.cnt }
          );
        }
      } catch { /* non-fatal — c2_tracker may not have data yet */ }
    }

    mark('c2_overlap');

    // ── CertStream health check ──────────────────────────────────
    try {
      const csId = env.CERTSTREAM_MONITOR.idFromName('certstream-primary');
      const csStub = env.CERTSTREAM_MONITOR.get(csId);
      const statsResp = await csStub.fetch(new Request('https://internal/stats'));
      const csStats = await statsResp.json() as {
        status: string;
        stats?: { certsProcessed?: number; certsMatched?: number; certsWritten?: number };
      };

      if (!csStats.status || csStats.status !== 'connected') {
        console.log('[flight-control] CertStream disconnected — attempting restart');
        await csStub.fetch(new Request('https://internal/start'));
        await logActivity(db, 'flight_control', 'warning', 'certstream_reconnect',
          'CertStream disconnected — triggered restart', { csStats });
      }

      console.log(`[flight-control] CertStream: ${csStats.stats?.certsProcessed || 0} processed, ${csStats.stats?.certsMatched || 0} matched, ${csStats.stats?.certsWritten || 0} written`);
    } catch (err) {
      console.error('[flight-control] CertStream health check failed:', err);
    }

    // Fire-and-forget scaling (no await — don't block on spawning agents)
    const scalingActions = await scaleAgents(db, env, ctx, backlogs, budgetStatus, agentLimits);
    mark('scale_agents');
    const recoveryActions = await recoverStalledAgents(db, env, ctx, health);
    mark('recover_stalled');

    mark('certstream_check');

    // ── Curator weekly trigger ─────────────────────────────────
    const lastRun = lastCuratorRun?.last_run
      ? new Date(lastCuratorRun.last_run + 'Z')
      : null;
    const daysSinceCuratorRun = lastRun
      ? (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24)
      : 999;

    // Run if: > 6 days since last run (weekly) OR email scan backlog very large
    // Skip curator if budget is at hard or emergency level
    if ((daysSinceCuratorRun > 6 || (unscannedEmails?.count ?? 0) > 5000) && !agentLimits.skip_curator) {
      // Backoff guard. Skip the dispatch when curator has hit 3+
      // reaper-stamped failures in the last 3 h with no successful
      // completion in that window — otherwise FC re-dispatches a
      // failing curator every hour, producing zero work. Emits a
      // critical notification so operators see the regression
      // surface (notifications are deduped by group_key inside
      // emitPlatformNotification, so this fires once per
      // failure-burst, not every tick).
      const recentFailures = curatorHealth?.recent_failures ?? 0;
      const lastSuccessAt = curatorHealth?.last_success_at
        ? new Date(curatorHealth.last_success_at + 'Z').getTime()
        : 0;
      const lastSuccessRecent = lastSuccessAt > Date.now() - 3 * 3600_000;
      const curatorRecentlyBroken = recentFailures >= 3 && !lastSuccessRecent;

      if (curatorRecentlyBroken) {
        await logActivity(db, 'flight_control', 'critical', 'curator_backoff',
          `Skipping Curator dispatch — ${recentFailures} failures in last 3h with no successful completion. Investigate before next attempt.`,
          {
            recent_failures: recentFailures,
            last_success_at: curatorHealth?.last_success_at,
            unscanned_emails: unscannedEmails?.count ?? 0,
          });
      } else {
        const { curatorAgent } = await import('./curator');
        const { executeAgent } = await import('../lib/agentRunner');
        // Fire-and-forget via ctx.waitUntil — curator's full hygiene run
        // can take 5–7 min. Awaiting it inline blocks the entire FC tick,
        // which delays navigator supervision and feed-pause emit. Same
        // pattern as scaleAgents() / recoverStalledAgents() below.
        const curatorExecCtx = ctx.input._executionCtx as ExecutionContext | undefined;
        const curatorPromise = executeAgent(env, curatorAgent, { trigger: 'flight_control' }, 'flight_control', 'event');
        if (curatorExecCtx) {
          curatorExecCtx.waitUntil(curatorPromise.catch(() => { /* logged by agentRunner */ }));
        } else {
          try { await curatorPromise; } catch { /* logged by agentRunner */ }
        }

        await logActivity(db, 'flight_control', 'info', 'scheduling',
          'Triggered Curator weekly hygiene run', {
            days_since_last: Math.round(daysSinceCuratorRun),
            unscanned_emails: unscannedEmails?.count ?? 0,
          });
      }
    }

    const stalled = health.filter(h => h.is_stalled).map(h => h.agent_id);
    const tripped = health.filter(h => h.circuit_state === 'tripped').map(h => h.agent_id);
    const healthyAgents = health.filter(h => !h.is_stalled && h.circuit_state === 'closed');

    // N6b — emit platform_agent_stalled per stalled agent. Dedup via
    // group_key=platform_agent_stalled:<agent_id>:<last_run_at> means
    // the same stuck run only notifies once; if the run finally moves
    // (success/fail) and a new one stalls, that's a new notification.
    //
    // Skip api/manual-trigger agents: they only run on demand
    // (trigger='api' for sync agents like evidence_assembler,
    // 'manual' for pathfinder etc.). Long silence between
    // invocations is intentional, not a stall — emitting here
    // generates false alarms (operator screenshot 2026-04-30).
    //
    // Also gate on last_run_status === 'running'. The is_stalled
    // flag fires when lastRunAge > thresholdMs regardless of
    // status, so cadence-driven agents (sentinel runs only when
    // totalNew>0; observer runs once a day) trip the alarm with
    // last_run_status='success'. That's not a stall — that's a
    // cadence gap. Only the 'running' (orphaned-row) case
    // matches the alert template's "stuck in running state"
    // language. Cadence drift is a different signal that should
    // get a different alert template, not noise on this one.
    const { agentModules: agentModulesForStallCheck } = await import('./index');
    for (const stalledHealth of health.filter(h => h.is_stalled)) {
      const mod = agentModulesForStallCheck[stalledHealth.agent_id];
      if (!mod) continue;
      if (mod.trigger === 'api' || mod.trigger === 'manual') continue;
      if (stalledHealth.last_run_status !== 'running') continue;
      try {
        const minutesRunning = stalledHealth.last_run_at
          ? Math.round((Date.now() - Date.parse(stalledHealth.last_run_at)) / 60_000)
          : 0;
        await emitPlatformNotification(env, 'platform_agent_stalled',
          renderPlatformAgentStalled({
            agent_id: stalledHealth.agent_id,
            run_id: stalledHealth.last_run_at ?? 'unknown',
            minutes_running: minutesRunning,
          })
        );
      } catch { /* notification failures never break FC */ }
    }

    // Navigator is independent — its stale/dead state contributes to overall
    // platform status the same way a stalled managed agent does.
    const navigatorDegraded = navigatorHealth.status === 'stale' || navigatorHealth.status === 'dead';
    if (navigatorDegraded) {
      await logActivity(
        db,
        'flight_control',
        navigatorHealth.status === 'dead' ? 'critical' : 'warning',
        'navigator_health',
        `Navigator ${navigatorHealth.status} — last run: ${navigatorHealth.last_run_at ?? 'never'} (expected every 5 min)`,
        navigatorHealth as unknown as Record<string, unknown>,
      );
    } else if (navigatorHealth.status === 'degraded') {
      await logActivity(
        db,
        'flight_control',
        'warning',
        'navigator_health',
        `Navigator degraded — success rate ${navigatorHealth.success_rate_last_hour}% over last hour`,
        navigatorHealth as unknown as Record<string, unknown>,
      );
    }

    const overallStatus = tripped.length > 0 || stalled.length > 0 || navigatorDegraded ? 'degraded'
      : Object.values(backlogs).some(b => b > 5000) ? 'busy'
      : 'healthy';

    mark('finalize');
    const totalMs = Date.now() - t0;

    const snapshot = {
      timestamp: new Date().toISOString(),
      backlogs,
      agents: health,
      navigator_health: navigatorHealth,
      budget: budgetStatus,
      overall_status: overallStatus,
      degraded_feeds: degradedFeeds.results,
      auto_paused_feeds: autoPausedFeeds.results,
      tripped_agents: trippedAgents.results,
      // P2 — phase timings for duration debugging. Surfaces in
      // agent_outputs.details so diagnostics can pull and rank
      // which step dominates the FC tick.
      timings,
      total_ms: totalMs,
    };

    const feedHealthSummary = `${autoPausedFeeds.results.length} feeds auto-paused, ${degradedFeeds.results.length} degraded`;
    const agentHealthSummary = `${tripped.length} tripped, ${stalled.length} degraded, ${healthyAgents.length} healthy`;

    outputs.push({
      type: 'diagnostic',
      summary: `Platform ${overallStatus} — backlog: cart=${backlogs.cartographer} analyst=${backlogs.analyst} watchdog=${backlogs.watchdog} surbl=${backlogs.surblUnchecked} vt=${backlogs.vtUnchecked} gsb=${backlogs.gsbUnchecked} dbl=${backlogs.dblUnchecked} abuseipdb=${backlogs.abuseipdbUnchecked} pdns=${backlogs.pdnsUnchecked} greynoise=${backlogs.greynoiseUnchecked} seclookup=${backlogs.seclookupUnchecked} domainGeo=${backlogs.domainGeoBacklog}(drainable=${backlogs.domainGeoDrainable}) brandEnrich=${backlogs.brandEnrichBacklog} agents=[${agentHealthSummary}] navigator=${navigatorHealth.status} feeds=[${feedHealthSummary}] budget=$${budgetStatus.spent_this_month}/${budgetStatus.config.monthly_limit_usd} (${budgetStatus.throttle_level})`,
      severity: tripped.length > 0 || stalled.length > 0 || navigatorDegraded || budgetStatus.throttle_level === 'emergency' ? 'high' : 'info',
      details: snapshot,
    });

    // Single write at the end — log only, no snapshot to agent_outputs
    await logActivity(
      db,
      'flight_control',
      'info',
      'batch_complete',
      `Flight Control: ${overallStatus} — cart backlog: ${backlogs.cartographer}, analyst backlog: ${backlogs.analyst}, domain geo backlog: ${backlogs.domainGeoBacklog} (drainable now: ${backlogs.domainGeoDrainable}), brand enrich backlog: ${backlogs.brandEnrichBacklog}, budget: $${budgetStatus.spent_this_month}/$${budgetStatus.config.monthly_limit_usd} (${budgetStatus.throttle_level})`,
      { backlogs, stalled, budget: budgetStatus, scaling: scalingActions, recovery: recoveryActions }
    );

    return {
      itemsProcessed: Object.values(backlogs).reduce((a, b) => a + b, 0),
      itemsCreated: 0,
      itemsUpdated: scalingActions + recoveryActions,
      output: {
        overall_status: overallStatus,
        backlogs,
        stalled,
        budget: budgetStatus,
        scaling_actions: scalingActions,
        recovery_actions: recoveryActions,
      },
      agentOutputs: outputs,
    };
  },
};

// ─── Backlog Measurement ─────────────────────────────────────────

async function measureBacklogs(env: Env, db: D1Database): Promise<Backlog> {
  // Each backlog is cached through KV via `cachedCount`. The TTL picks
  // whether this is a "live" counter (short TTL, ~every tick) or a
  // "monitoring" counter (long TTL, ~every 4th tick). The stall-
  // detection logic below writes to backlog_history only when
  // wasCached === false, so detection still runs on fresh samples
  // regardless of cadence.
  //
  // Migrated from `getOrComputeMetric` (D1-backed system_metrics
  // table) to `cachedCount` (KV-backed) per CLAUDE.md §8 — the
  // legacy helper spent a D1 read on every freshness check, which
  // showed up in the diagnostic top-queries report as 11 distinct
  // COUNT(*) hashes against the threats table burning ~150M rows /
  // 24h even when the cache was warm. KV reads don't count against
  // the D1 budget.

  const cacheCount = async (
    key: string,
    ttl: number,
    sql: string,
    suppressErrors = false,
    /** PR-4: route the SELECT to a non-main D1 binding. Currently
     *  used only for the dns_queue backlogs (DNS_QUEUE_DB). When
     *  undefined the SELECT runs on the main `db` (trust-radar-v2)
     *  — the default for every other backlog counter. */
    altDb?: D1Database,
  ): Promise<{ value: number; wasCached: boolean }> => {
    let wasCached = true;
    const value = await cachedCount(env, key, ttl, async () => {
      wasCached = false;
      try {
        const targetDb = altDb ?? db;
        const r = await targetDb.prepare(sql).first<{ count: number }>();
        return r?.count ?? 0;
      } catch (err) {
        if (suppressErrors) return 0;
        throw err;
      }
    });
    return { value, wasCached };
  };

  const [
    cartResult,
    analystResult,
    totalUnlinkedResult,
    totalNoGeoResult,
    surblResult,
    vtResult,
    gsbResult,
    dblResult,
    abuseipdbResult,
    pdnsResult,
    greynoiseResult,
    seclookupResult,
    watchdogResult,
    domainGeoResult,
    domainGeoDrainableResult,
    brandEnrichResult,
  ] = await Promise.all([
    // Live counters — used for scaling decisions, kept fresh every tick.
    cacheCount('backlog.cartographer', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE enriched_at IS NULL
        AND ip_address IS NOT NULL AND ip_address != ''
        ${PRIVATE_IP_SQL_FILTER}
    `),
    cacheCount('backlog.analyst', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(DISTINCT target_brand_id) as count
      FROM threats
      WHERE first_seen >= datetime('now', '-24 hours')
        AND target_brand_id IS NOT NULL
        AND status = 'active'
    `),
    cacheCount('backlog.total_unlinked', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE target_brand_id IS NULL
      AND status = 'active'
    `),
    cacheCount('backlog.total_no_geo', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE (lat IS NULL OR lng IS NULL)
      AND status = 'active'
    `),

    // Monitoring counters — broad _checked queries with no selective
    // index. Refreshed every ~4 ticks; stall detection still works on
    // fresh-recompute samples.
    cacheCount('backlog.surbl', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE surbl_checked = 0
        AND malicious_domain IS NOT NULL
        AND first_seen >= datetime('now', '-7 days')
    `),
    cacheCount('backlog.vt', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE vt_checked = 0
        AND severity IN ('critical', 'high')
        AND malicious_domain IS NOT NULL
        AND first_seen >= datetime('now', '-7 days')
    `),
    cacheCount('backlog.gsb', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE gsb_checked = 0
        AND (malicious_url IS NOT NULL OR malicious_domain IS NOT NULL)
        AND first_seen >= datetime('now', '-7 days')
    `),
    cacheCount('backlog.dbl', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE dbl_checked = 0
        AND malicious_domain IS NOT NULL
        AND first_seen >= datetime('now', '-7 days')
    `),
    cacheCount('backlog.abuseipdb', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE abuseipdb_checked = 0
        AND ip_address IS NOT NULL
        AND first_seen >= datetime('now', '-7 days')
    `),
    cacheCount('backlog.pdns', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE pdns_checked = 0
        AND severity IN ('critical', 'high')
        AND malicious_domain IS NOT NULL
        AND first_seen >= datetime('now', '-7 days')
    `),
    cacheCount('backlog.greynoise', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE greynoise_checked = 0
        AND ip_address IS NOT NULL
        AND severity IN ('critical', 'high')
        AND first_seen >= datetime('now', '-7 days')
    `, true),
    cacheCount('backlog.seclookup', BACKLOG_TTL_MONITORING_S, `
      SELECT COUNT(*) as count FROM threats
      WHERE seclookup_checked = 0
        AND (malicious_domain IS NOT NULL OR ip_address IS NOT NULL)
        AND first_seen >= datetime('now', '-7 days')
    `, true),
    cacheCount('backlog.watchdog', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(*) as count FROM social_mentions WHERE status = 'new'
    `, true),
    // D1 spend reduction (2026-05-17): both backlog queries below
    // were using `idx_threats_ip_source_feed` via MULTI-INDEX OR
    // (117K rows/call) instead of `idx_threats_dns_pending_strict`
    // (~60K). Adding `status='active'` and dropping `ip_address = ''`
    // (zero matching rows in prod) lets the planner pick the strict
    // partial index. Verified via production EXPLAIN QUERY PLAN.
    // Note: `domain_geo` previously omitted `status='active'`. Adding
    // it is semantically equivalent for this counter — only active
    // threats can ever be drained by Navigator (the dns-backfill SELECT
    // already gates on status='active' implicitly via the same index).
    // PR-4: now read both DNS backlog counts from dns_queue. The
    // schema mirrors the dns-backfill SELECT semantics (PK on
    // malicious_domain → no DISTINCT needed; partial index on
    // attempts<8 → no domain-format filters needed since reconciler
    // already gates those out on insert).
    // suppressErrors=true: dev environments without DNS_QUEUE_DB
    // bound see 0 here instead of failing the whole FC tick.
    cacheCount('backlog.domain_geo', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(*) as count
      FROM dns_queue
      WHERE enrichment_attempts < 8
    `, true, env.DNS_QUEUE_DB),
    // domain_geo_drainable — the count of domains we can actually
    // try right now (cooldown expired and under the attempts cap).
    cacheCount('backlog.domain_geo_drainable', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(*) as count
      FROM dns_queue INDEXED BY idx_dns_queue_drainable
      WHERE enrichment_attempts < 8
        AND (attempted_resolve_at IS NULL
             OR attempted_resolve_at < datetime('now', '-6 hours'))
    `, true, env.DNS_QUEUE_DB),
    cacheCount('backlog.brand_enrich', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(*) as count FROM brands
      WHERE enriched_at IS NULL AND canonical_domain IS NOT NULL
    `),
  ]);

  const backlog: Backlog = {
    cartographer: cartResult.value,
    analyst: analystResult.value,
    totalUnlinked: totalUnlinkedResult.value,
    totalNoGeo: totalNoGeoResult.value,
    surblUnchecked: surblResult.value,
    vtUnchecked: vtResult.value,
    gsbUnchecked: gsbResult.value,
    dblUnchecked: dblResult.value,
    abuseipdbUnchecked: abuseipdbResult.value,
    pdnsUnchecked: pdnsResult.value,
    greynoiseUnchecked: greynoiseResult.value,
    seclookupUnchecked: seclookupResult.value,
    watchdog: watchdogResult.value,
    domainGeoBacklog:   domainGeoResult.value,
    domainGeoDrainable: domainGeoDrainableResult.value,
    brandEnrichBacklog: brandEnrichResult.value,
  };

  // ── Persist backlog snapshots + run stall detection ────────────
  // Flight Control used to log the backlog count every tick but had no
  // memory of what it logged the previous tick. The Enricher could be
  // dead and FC would still happily report "domain geo backlog: 90852"
  // hour after hour with no alarm. Now we keep a rolling history and
  // emit a critical event whenever a backlog fails to strictly decrease
  // across samples.
  //
  // Samples are written ONLY for freshly computed metrics (wasCached ===
  // false). If we wrote every tick, cached metrics would produce long
  // runs of identical values and stall detection would fire falsely.
  // Monitoring counters with the 4h TTL therefore write one sample per
  // ~4 ticks and stall detection compares fresh samples, not cached
  // reads.
  const TRACKED: Array<{ name: string; count: number; cached: boolean }> = [
    { name: 'domain_geo',    count: backlog.domainGeoBacklog,     cached: domainGeoResult.wasCached },
    { name: 'brand_enrich',  count: backlog.brandEnrichBacklog,   cached: brandEnrichResult.wasCached },
    { name: 'cartographer',  count: backlog.cartographer,         cached: cartResult.wasCached },
    { name: 'analyst',       count: backlog.analyst,              cached: analystResult.wasCached },
    { name: 'surbl',         count: backlog.surblUnchecked,       cached: surblResult.wasCached },
    { name: 'virustotal',    count: backlog.vtUnchecked,          cached: vtResult.wasCached },
    { name: 'gsb',           count: backlog.gsbUnchecked,         cached: gsbResult.wasCached },
    { name: 'dbl',           count: backlog.dblUnchecked,         cached: dblResult.wasCached },
    { name: 'abuseipdb',     count: backlog.abuseipdbUnchecked,   cached: abuseipdbResult.wasCached },
    { name: 'pdns',          count: backlog.pdnsUnchecked,        cached: pdnsResult.wasCached },
    { name: 'greynoise',     count: backlog.greynoiseUnchecked,   cached: greynoiseResult.wasCached },
    { name: 'seclookup',     count: backlog.seclookupUnchecked,   cached: seclookupResult.wasCached },
  ];

  for (const t of TRACKED) {
    if (t.cached) continue;
    try {
      await db.prepare(
        `INSERT INTO backlog_history (backlog_name, count) VALUES (?, ?)`
      ).bind(t.name, t.count).run();
    } catch { /* never block FC on logging */ }
  }

  // Stall detection: compare the current count (just inserted) to the
  // value from 4 samples ago. Only runs on freshly computed metrics —
  // cached reads skip detection to avoid false positives from identical
  // consecutive values. For 4h-TTL metrics this means the comparison
  // window is ~16 hours of real time, which is strictly more conservative
  // than the previous 4-hour window.
  for (const t of TRACKED) {
    if (t.count === 0) continue;
    if (t.cached) continue;
    try {
      const history = await db.prepare(`
        SELECT count FROM backlog_history
        WHERE backlog_name = ?
        ORDER BY recorded_at DESC
        LIMIT 5
      `).bind(t.name).all<{ count: number }>();

      const samples = history.results ?? [];
      if (samples.length < 5) continue; // need 5 (current + 4 history) to judge

      const current = samples[0]?.count ?? 0;
      const fourAgo = samples[4]?.count ?? 0;
      const trend   = current - fourAgo; // negative = draining, positive/0 = stalled

      if (trend >= 0) {
        await db.prepare(`
          INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity, created_at)
          VALUES (?, 'flight_control', 'backlog_stalled', ?, ?, 'critical', datetime('now'))
        `).bind(
          crypto.randomUUID(),
          `Backlog ${t.name} stalled at ${current} (4 ticks ago: ${fourAgo}, trend: ${trend >= 0 ? '+' : ''}${trend})`,
          JSON.stringify({ backlog: t.name, current, four_ticks_ago: fourAgo, trend }),
        ).run();
      }
    } catch { /* never block FC */ }
  }

  // Trim history to last 7 days (best effort, keeps the table small).
  try {
    await db.prepare(
      `DELETE FROM backlog_history WHERE recorded_at < datetime('now', '-7 days')`
    ).run();
  } catch { /* ignore */ }

  return backlog;
}

// ─── Agent Health ────────────────────────────────────────────────

/** Read each agent's `stallThresholdMinutes` declaration from its
 *  AgentModule. Replaces the hardcoded STALL_THRESHOLDS map that lived
 *  here pre-Phase 4.1 — supervision data is now owned by the module
 *  itself (AGENT_STANDARD §3) so any change ships with the agent. */
async function getStallThresholdMap(): Promise<Map<string, number>> {
  const { agentModules: mods } = await import("./index");
  return new Map(Object.entries(mods).map(([id, mod]) => [id, mod.stallThresholdMinutes]));
}

async function getAgentHealth(db: D1Database): Promise<AgentHealth[]> {
  const agentIds = await getAgentsToMonitor();
  // Build a placeholder list for the IN clause
  const placeholders = agentIds.map(() => '?').join(',');
  const stallThresholds = await getStallThresholdMap();

  const [results, avgResults, configResults, workflowAgentStats] = await Promise.all([
    db.prepare(`
      SELECT
        agent_id,
        status as last_run_status,
        started_at as last_run_at,
        duration_ms
      FROM agent_runs ar1
      WHERE started_at = (
        SELECT MAX(started_at) FROM agent_runs ar2
        WHERE ar2.agent_id = ar1.agent_id
      )
      AND agent_id IN (${placeholders})
    `).bind(...agentIds).all<{ agent_id: string; last_run_status: string; last_run_at: string; duration_ms: number | null }>(),

    db.prepare(`
      SELECT agent_id, AVG(duration_ms) as avg_ms
      FROM agent_runs
      WHERE started_at >= datetime('now', '-24 hours')
        AND duration_ms IS NOT NULL
        AND agent_id IN (${placeholders})
      GROUP BY agent_id
    `).bind(...agentIds).all<{ agent_id: string; avg_ms: number | null }>(),

    // LEFT JOIN agent_configs for circuit breaker state
    db.prepare(`
      SELECT agent_id, enabled, paused_reason, consecutive_failures,
             paused_at, paused_after_n_failures
      FROM agent_configs
      WHERE agent_id IN (${placeholders})
    `).bind(...agentIds).all<{
      agent_id: string; enabled: number; paused_reason: string | null;
      consecutive_failures: number; paused_at: string | null;
      paused_after_n_failures: number | null;
    }>(),

    // PR-R reconciliation: workflow-dispatched agents (nexus + future)
    // write to agent_activity_log not agent_runs. Without this,
    // is_stalled comes back true for healthy workflow agents → false
    // platform_agent_stalled notifications fire every FC tick.
    getWorkflowAgentStats(db),
  ]);

  const avgMap = new Map(avgResults.results.map(r => [r.agent_id, r.avg_ms]));
  const configMap = new Map(configResults.results.map(r => [r.agent_id, r]));

  return agentIds.map(agentId => {
    const latest = results.results.find(r => r.agent_id === agentId);
    const config = configMap.get(agentId);
    const wf = workflowAgentStats.get(agentId);
    const thresholdMs = (stallThresholds.get(agentId) ?? 60) * 60 * 1000;

    // For workflow-dispatched agents, last-run age is computed from
    // agent_activity_log's batch_complete event, not agent_runs.
    // last_run_status follows the same rollup as PR-J/handleListAgents.
    const wfLastFailureMs = wf?.last_failure_at ? new Date(wf.last_failure_at).getTime() : 0;
    const wfLastSuccessMs = wf?.last_completed_at ? new Date(wf.last_completed_at).getTime() : 0;
    const wfLastEventMs = wf?.last_event_at ? new Date(wf.last_event_at).getTime() : 0;
    const wfLastRunStatus = wf
      ? (wfLastFailureMs > wfLastSuccessMs && wf.dispatch_failed > 0 ? 'failed' :
         wf.completed > 0 ? 'success' :
         wf.dispatched > 0 ? 'partial' : null)
      : null;

    const lastRunAge = wf && wfLastEventMs > 0
      ? Date.now() - wfLastEventMs
      : latest?.last_run_at
        ? Date.now() - new Date(latest.last_run_at + 'Z').getTime()
        : Infinity;
    const effectiveLastStatus = wf ? wfLastRunStatus : latest?.last_run_status;
    const isStalled = lastRunAge > thresholdMs ||
      (effectiveLastStatus === 'partial' && lastRunAge > 45 * 60 * 1000);

    // Derive circuit state from agent_configs
    const isTripped = config?.enabled === 0 && config.paused_reason === 'auto:consecutive_failures';

    return {
      agent_id: agentId,
      last_run_at: (wf?.last_event_at) ?? latest?.last_run_at ?? null,
      last_run_status: wfLastRunStatus ?? latest?.last_run_status ?? null,
      avg_duration_ms: Math.round(avgMap.get(agentId) ?? 0),
      is_stalled: isStalled,
      circuit_state: isTripped ? 'tripped' as const : 'closed' as const,
      consecutive_failures: config?.consecutive_failures ?? 0,
      paused_reason: config?.paused_reason ?? null,
      paused_after_n_failures: config?.paused_after_n_failures ?? null,
      paused_at: config?.paused_at ?? null,
    };
  });
}

// ─── Navigator Health ────────────────────────────────────────────
//
// Navigator runs on its own */5 cron and is NOT part of agentModules, so
// getAgentHealth never sees it. This function computes Navigator health
// directly from agent_runs. Navigator was previously named 'fast_tick' —
// historical rows still carry that ID, so queries span both IDs to get
// the full recent history.

async function getNavigatorHealth(db: D1Database): Promise<NavigatorHealth> {
  const DEFAULT_EMPTY: NavigatorHealth = {
    last_run_at: null,
    runs_last_hour: 0,
    success_rate_last_hour: 0,
    avg_records_processed: 0,
    avg_duration_ms: 0,
    status: 'dead',
  };

  try {
    // Two reads in parallel: last run (for status freshness) + last hour aggregates.
    const [latestRow, hourAgg] = await Promise.all([
      db.prepare(`
        SELECT started_at, status
        FROM agent_runs
        WHERE agent_id IN ('navigator', 'fast_tick')
        ORDER BY started_at DESC
        LIMIT 1
      `).first<{ started_at: string; status: string }>(),

      db.prepare(`
        SELECT
          COUNT(*) AS runs,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
          AVG(records_processed) AS avg_records,
          AVG(duration_ms) AS avg_ms
        FROM agent_runs
        WHERE agent_id IN ('navigator', 'fast_tick')
          AND started_at >= datetime('now', '-1 hour')
      `).first<{ runs: number; successes: number; avg_records: number | null; avg_ms: number | null }>(),
    ]);

    if (!latestRow) return DEFAULT_EMPTY;

    // SQLite datetime strings are UTC but lack the 'Z' suffix — add it so
    // `new Date(...)` parses them as UTC rather than local time.
    const lastRunMs = new Date(latestRow.started_at + 'Z').getTime();
    const ageMs = Date.now() - lastRunMs;
    const ageMin = ageMs / 60_000;

    const runs = hourAgg?.runs ?? 0;
    const successes = hourAgg?.successes ?? 0;
    const successRate = runs > 0 ? Math.round((successes / runs) * 100) : 0;

    // Status thresholds — doubled from the 5-min cycle for latency tolerance.
    let status: NavigatorHealth['status'];
    if (ageMin > 30) {
      status = 'dead';
    } else if (ageMin > 10) {
      status = 'stale';
    } else if (runs > 0 && successRate <= 80) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      last_run_at: latestRow.started_at,
      runs_last_hour: runs,
      success_rate_last_hour: successRate,
      avg_records_processed: Math.round(hourAgg?.avg_records ?? 0),
      avg_duration_ms: Math.round(hourAgg?.avg_ms ?? 0),
      status,
    };
  } catch {
    // Never let a Navigator health read failure break Flight Control.
    return DEFAULT_EMPTY;
  }
}

// ─── Scaling ─────────────────────────────────────────────────────

async function scaleAgents(
  db: D1Database,
  env: AgentContext['env'],
  ctx: AgentContext,
  backlogs: Backlog,
  budget: BudgetStatus,
  limits: AgentBudgetLimits
): Promise<number> {
  // We need the agent runner + modules to trigger agents
  const { agentModules } = await import('./index');
  const { executeAgent } = await import('../lib/agentRunner');
  let actions = 0;

  // ── Wave 1B: fire-and-forget scaling via ctx.waitUntil ──────────
  // Previously, scaleAgents awaited each cartographer/analyst run
  // sequentially, blocking the hourly cron for ~50-150s and holding the
  // D1 writer the entire time. Now we fire them via ExecutionContext
  // .waitUntil() — the agent runs continue in the background while FC
  // returns and the cron proceeds with its remaining jobs.
  //
  // The ExecutionContext is passed from the cron handler via
  // ctx.input._executionCtx. If absent (manual trigger), fall back to
  // the old await behavior for backward compatibility.
  const execCtx = ctx.input._executionCtx as ExecutionContext | undefined;

  // Scale Cartographer (geo enrichment is non-AI, but AI classification may be throttled)
  const cartBacklog = backlogs.cartographer;
  if (cartBacklog > 0 && !limits.pause_all_ai) {
    const cfg = SCALING.cartographer;
    const instances = cartBacklog >= cfg.high ? cfg.max_parallel
      : cartBacklog >= cfg.medium ? 2
      : 1;

    const cartMod = agentModules['cartographer'];
    if (cartMod) {
      // Offset stride must equal one instance's full row window so the three
      // instances cover disjoint ranges. Each instance processes 5 batches ×
      // 500 rows = 2,500 rows; a smaller stride (e.g. 500) makes every
      // instance's later batches overlap with the next instance's earlier
      // ones, wasting ip-api.com subrequests and D1 writes on idempotent
      // re-enrichments of the same rows.
      const CART_ROWS_PER_INSTANCE = 2500;
      for (let i = 0; i < instances; i++) {
        const promise = executeAgent(env, cartMod, { trigger: 'flight_control', offset: i * CART_ROWS_PER_INSTANCE }, 'flight_control', 'event');
        if (execCtx) {
          // Fire-and-forget: cron keeps running, cartographer runs in background
          execCtx.waitUntil(promise.catch(() => { /* logged by agentRunner */ }));
        } else {
          // Fallback for manual triggers: await as before
          try { await promise; } catch { /* logged by agentRunner */ }
        }
        actions++;
      }
    }

    if (instances > 1) {
      await logActivity(db, 'flight_control', 'info', 'scaling',
        `Scaling Cartographer to ${instances} background instances (backlog: ${cartBacklog})`,
        { agent: 'cartographer', instances, backlog: cartBacklog }
      );
    }
  } else if (cartBacklog > 0 && limits.pause_all_ai) {
    // Budget emergency gate. scaleAgents would otherwise silently skip
    // with no trace — the budget-transition notification goes out once,
    // but once you're already in 'emergency' each subsequent tick has
    // nothing saying "and Cartographer did not run this tick either."
    // Log it every tick so the activity trail explains the enrichment
    // queue growth while the throttle is in effect.
    await logActivity(db, 'flight_control', 'warning', 'scaling_skipped',
      `Cartographer scaling skipped — AI budget in emergency (pause_all_ai). Backlog: ${cartBacklog}`,
      { agent: 'cartographer', reason: 'budget_pause_all_ai', backlog: cartBacklog }
    );
  }

  // Cartographer geo backlog — trigger geo enrichment if geo backlog is large
  // and cartographer isn't already busy with unenriched threats
  if (backlogs.totalNoGeo > 5000 && cartBacklog === 0) {
    const cartMod2 = agentModules['cartographer'];
    if (cartMod2) {
      const promise = executeAgent(env, cartMod2, { trigger: 'flight_control', mode: 'geo_backlog', priority: 'low' }, 'flight_control', 'event');
      if (execCtx) {
        execCtx.waitUntil(promise.catch(() => {}));
      } else {
        try { await promise; } catch { /* logged by agentRunner */ }
      }
      actions++;

      await logActivity(db, 'flight_control', 'info', 'scaling',
        `Queued Cartographer geo backlog run (${backlogs.totalNoGeo} threats missing geo)`,
        { agent: 'cartographer', mode: 'geo_backlog', no_geo_count: backlogs.totalNoGeo }
      );
    }
  }

  // Scale Analyst — factor in TOTAL unlinked backlog, not just recent
  // Emergency: pause all AI. Hard/Soft: reduced batches handled by agent limits.
  const analystBacklog = backlogs.analyst;
  const totalUnlinked = backlogs.totalUnlinked;
  if ((analystBacklog > 0 || totalUnlinked > 0) && !limits.pause_all_ai) {
    const rawInstances = totalUnlinked > 50000 ? 3
      : totalUnlinked > 10000 ? 2
      : analystBacklog >= SCALING.analyst.high ? SCALING.analyst.max_parallel
      : analystBacklog >= SCALING.analyst.medium ? 2
      : analystBacklog > 0 ? 1
      : 0;
    const instances = Math.min(rawInstances, SCALING.analyst.max_parallel);

    const analystMod = agentModules['analyst'];
    if (analystMod) {
      for (let i = 0; i < instances; i++) {
        const promise = executeAgent(env, analystMod, {
          trigger: 'flight_control',
          budget_batch_limit: limits.analyst_batch,
        }, 'flight_control', 'event');
        if (execCtx) {
          execCtx.waitUntil(promise.catch(() => { /* logged by agentRunner */ }));
        } else {
          try { await promise; } catch { /* logged by agentRunner */ }
        }
        actions++;
      }
    }

    if (instances > 1) {
      await logActivity(db, 'flight_control', 'info', 'scaling',
        `Scaling Analyst to ${instances} background instances (backlog: ${analystBacklog}, unlinked: ${totalUnlinked}, batch limit: ${limits.analyst_batch})`,
        { agent: 'analyst', instances, backlog: analystBacklog, total_unlinked: totalUnlinked, batch_limit: limits.analyst_batch }
      );
    }
  } else if (limits.pause_all_ai && analystBacklog > 0) {
    await logActivity(db, 'flight_control', 'critical', 'throttle',
      `Analyst paused — budget ${budget.throttle_level} ($${budget.spent_this_month}/$${budget.config.monthly_limit_usd})`,
      { throttle_level: budget.throttle_level, spent: budget.spent_this_month }
    );
  }

  return actions;
}

// ─── Stall Recovery ──────────────────────────────────────────────

async function recoverStalledAgents(
  db: D1Database,
  env: AgentContext['env'],
  ctx: AgentContext,
  health: AgentHealth[]
): Promise<number> {
  const { agentModules } = await import('./index');
  const { executeAgent } = await import('../lib/agentRunner');
  let recoveries = 0;

  // Fire-and-forget recovery via ctx.waitUntil — same pattern as
  // scaleAgents (line 1212). Recovered agents take 100-200s each
  // (sentinel/analyst/cartographer). Awaiting them sequentially
  // pushed FC tick to ~5min total (recover_stalled was 96.1% of
  // FC time per the timing instrumentation). With waitUntil, FC
  // returns in seconds while recoveries run in the background.
  const execCtx = ctx.input?._executionCtx as ExecutionContext | undefined;

  // Collect orphan-clear UPDATEs and recovery log INSERTs across
  // all stalled agents into one batch. Pre-fix each stalled agent
  // serialized 1 UPDATE + 1 INSERT; with N stalled agents that's
  // 2N sequential D1 round-trips. Single batch is one round-trip.
  const recoveryStmts: D1PreparedStatement[] = [];
  const toRecover: Array<{ agentId: string; mod: typeof agentModules[string] }> = [];

  for (const agent of health) {
    if (!agent.is_stalled) continue;

    const mod = agentModules[agent.agent_id];
    if (!mod) continue;
    // Skip manual + api agents — see #948 / #941.
    if (mod.trigger === 'manual' || mod.trigger === 'api') continue;

    // Skip nexus — its primary path is the NEXUS_RUN workflow
    // (dispatched from handleScheduled at hour % 4 === 0). The PR-A
    // workflow_dispatch_supervisor block above watches the
    // `wf_last_dispatch:nexus-run` KV stamp and emits
    // `platform_workflow_dispatch_silent` when stale > 12h — that IS
    // the recovery signal for nexus.
    //
    // FC dispatching nexus inline via executeAgent re-creates the loop
    // observed 2026-05-13: each "recovery" inserted a new agent_runs
    // partial row that the parent worker couldn't drive to completion
    // before its CPU budget exhausted, leaving another stuck-partial
    // row that the next FC tick saw as stalled. Six consecutive hours
    // of recoveries (12:08 → 16:08) and 7 cumulative stuck partials
    // in `agent_runs` before this guard landed.
    if (agent.agent_id === 'nexus') continue;

    // Force-fail orphaned 'running' rows before re-dispatching.
    // A Worker timeout / unhandled exception leaves the row in
    // 'running' state forever; without this UPDATE-to-failed,
    // the orphan stays the latest started_at and re-trips
    // is_stalled every FC tick. Marked 'failed' so the recovery
    // run becomes the latest started_at on the next tick.
    if (agent.last_run_status === 'running' && agent.last_run_at) {
      recoveryStmts.push(db.prepare(`
        UPDATE agent_runs
           SET status = 'failed',
               completed_at = datetime('now'),
               error_message = 'auto-failed by flight_control after stall threshold exceeded'
         WHERE agent_id = ?
           AND started_at = ?
           AND status = 'running'
      `).bind(agent.agent_id, agent.last_run_at));
    }

    recoveryStmts.push(logActivityStmt(db, 'flight_control', 'warning', 'recovery',
      `Recovering stalled agent: ${agent.agent_id} (last run: ${agent.last_run_at ?? 'never'})`,
      { agent: agent.agent_id, last_run: agent.last_run_at, status: agent.last_run_status }
    ));

    toRecover.push({ agentId: agent.agent_id, mod });
  }

  // One batched flush for all the orphan-clear + log writes.
  if (recoveryStmts.length > 0) {
    try { await db.batch(recoveryStmts); } catch { /* per-row failures don't block recoveries */ }
  }

  // Dispatch the actual recovery executions. Fire-and-forget via
  // ctx.waitUntil so FC returns in seconds while the recoveries
  // run in the background.
  for (const { mod } of toRecover) {
    const promise = executeAgent(env, mod, { trigger: 'flight_control_recovery' }, 'flight_control', 'event');
    if (execCtx) {
      execCtx.waitUntil(promise.catch(() => { /* logged by agentRunner */ }));
    } else {
      try { await promise; } catch { /* logged by agentRunner */ }
    }
    recoveries++;
  }

  return recoveries;
}

// ─── Activity Logging ────────────────────────────────────────────
//
// Each FC tick was firing ~7 logActivity calls inside
// enrichment_warnings + (UPDATE + logActivity) per stalled agent
// inside recover_stalled — all sequential awaits. With ~50-200ms
// per D1 round-trip plus tail latency, those phases were both
// clocking 4s each (28% of the 14s tick on /admin/metrics).
//
// Fix: expose a non-awaiting "build a prepared statement" variant
// alongside the awaiting helper, collect statements in each phase,
// and flush via `db.batch()` once.

async function logActivity(
  db: D1Database,
  agentId: string,
  severity: 'info' | 'warning' | 'critical',
  eventType: string,
  message: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    await logActivityStmt(db, agentId, severity, eventType, message, metadata).run();
  } catch {
    // Don't let activity logging failures break Flight Control
  }
}

/** Same INSERT as logActivity but returns the bound statement so
 *  the caller can batch multiple writes via `db.batch([…])`. */
function logActivityStmt(
  db: D1Database,
  agentId: string,
  severity: 'info' | 'warning' | 'critical',
  eventType: string,
  message: string,
  metadata: Record<string, unknown>
): D1PreparedStatement {
  return db.prepare(`
      INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      agentId,
      eventType,
      message,
      JSON.stringify(metadata),
      severity
    );
}

/**
 * Fire a user-facing notification on budget throttle transitions.
 *
 * Severity mapping mirrors the operational consequences, not the raw
 * percent used:
 *   → emergency  critical  (all AI paused — Cartographer scaling stops)
 *   → hard       high      (reduced AI batches, observer/curator skipped)
 *   → soft       medium    (smaller batches, but everything still runs)
 *   → none       info      (recovery — useful positive signal)
 *
 * Uses circuit_breaker_tripped as the notification type because
 * semantically that's exactly what this is — the budget-based
 * circuit breaker on AI spend has flipped. Keeping it on an existing
 * type avoids touching the notifications CHECK constraint and reuses
 * whatever routing / preferences users already have in place.
 */
async function notifyBudgetTransition(
  env: Env,
  prev: ThrottleLevel | null,
  curr: ThrottleLevel,
  status: BudgetStatus,
): Promise<void> {
  // On a clean deploy (no prior state in system_config) don't fire for
  // 'none' — there's nothing to announce, we're just recording the
  // baseline. But if we come up in a throttled state, do fire: the
  // operator needs to know the deploy landed during a live incident.
  if (prev === null && curr === 'none') return;

  const spendLine = `$${status.spent_this_month}/$${status.config.monthly_limit_usd} (${status.pct_used}% used)`;
  const prevLabel = prev ?? 'unknown';

  let severity: 'critical' | 'high' | 'medium' | 'info';
  let title: string;
  let message: string;

  if (curr === 'emergency') {
    severity = 'critical';
    title = 'AI budget exhausted — all AI agents paused';
    message = `Budget crossed emergency threshold (${status.config.emergency_pct}%). ` +
      `All AI agents are paused until spend resets or the limit is raised. ` +
      `Current: ${spendLine}. Previous state: ${prevLabel}.`;
  } else if (curr === 'hard') {
    severity = 'high';
    title = 'AI budget at hard limit — processing minimized';
    message = `Budget crossed hard threshold (${status.config.hard_pct}%). ` +
      `Observer and Curator are paused; Analyst and Cartographer are running at reduced batch sizes. ` +
      `Current: ${spendLine}. Previous state: ${prevLabel}.`;
  } else if (curr === 'soft') {
    severity = 'medium';
    title = 'AI budget at soft limit — batch sizes reduced';
    message = `Budget crossed soft threshold (${status.config.soft_pct}%). ` +
      `Batch sizes reduced; all agents still running. ` +
      `Current: ${spendLine}. Previous state: ${prevLabel}.`;
  } else {
    severity = 'info';
    title = 'AI budget back below thresholds — full processing resumed';
    message = `Budget has dropped back to normal from ${prevLabel}. ` +
      `All AI agents are running at full capacity. Current: ${spendLine}.`;
  }

  await createNotification(env, {
    type: 'circuit_breaker_tripped',
    severity,
    title,
    message,
    link: '/admin/budget',
    metadata: {
      source: 'flight_control',
      kind: 'budget_throttle',
      from: prev,
      to: curr,
      pct_used: status.pct_used,
      spent_this_month: status.spent_this_month,
      monthly_limit_usd: status.config.monthly_limit_usd,
    },
  });
}
