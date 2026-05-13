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
import { transitionStatus as transitionIncidentStatus } from "../lib/incidents";
import {
  emitPlatformNotification,
  renderPlatformAgentStalled,
  renderPlatformFeedAutoPaused,
  renderPlatformFeedSilent,
  renderPlatformBriefingSilent,
  renderPlatformAiSpendBurst,
  renderPlatformCronMissed,
  renderPlatformEnrichmentStuck,
  renderPlatformGeoipRefreshStalled,
  renderPlatformWorkflowDispatchSilent,
} from "../lib/platform-templates";
import { getLastDispatchAt, getCooldownUntil } from "../lib/workflow-dispatch";
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
    // STUCK_THRESHOLD_MIN matches the agent's value (60). Any row
    // older than that AND still 'running' is force-failed; the
    // operator gets one notification per stuck workflow id.
    //
    // Skipped when GEOIP_DB binding is unset — the table won't
    // exist, throwing on the SELECT. Wrapping in try/catch keeps
    // FC's tick robust against optional bindings.
    const GEOIP_STUCK_THRESHOLD_MIN = 60;
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
  ): Promise<{ value: number; wasCached: boolean }> => {
    let wasCached = true;
    const value = await cachedCount(env, key, ttl, async () => {
      wasCached = false;
      try {
        const r = await db.prepare(sql).first<{ count: number }>();
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
    cacheCount('backlog.domain_geo', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(DISTINCT malicious_domain) as count FROM threats
      WHERE (ip_address IS NULL OR ip_address = '')
        AND malicious_domain IS NOT NULL
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
        AND COALESCE(enrichment_attempts, 0) < 8
    `),
    // domain_geo_drainable mirrors the dns-backfill SELECT — the
    // count of domains we can actually try right now (cooldown
    // expired and under the attempts cap). The total backlog above
    // includes domains that are still in cooldown; this number
    // tells the operator how much work the next Navigator tick can
    // pick up.
    cacheCount('backlog.domain_geo_drainable', BACKLOG_TTL_LIVE_S, `
      SELECT COUNT(DISTINCT malicious_domain) as count FROM threats
      WHERE (ip_address IS NULL OR ip_address = '')
        AND malicious_domain IS NOT NULL
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
        AND COALESCE(enrichment_attempts, 0) < 8
        AND (attempted_resolve_at IS NULL
             OR attempted_resolve_at < datetime('now', '-6 hours'))
    `),
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

  const [results, avgResults, configResults] = await Promise.all([
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
  ]);

  const avgMap = new Map(avgResults.results.map(r => [r.agent_id, r.avg_ms]));
  const configMap = new Map(configResults.results.map(r => [r.agent_id, r]));

  return agentIds.map(agentId => {
    const latest = results.results.find(r => r.agent_id === agentId);
    const config = configMap.get(agentId);
    const thresholdMs = (stallThresholds.get(agentId) ?? 60) * 60 * 1000;
    const lastRunAge = latest?.last_run_at
      ? Date.now() - new Date(latest.last_run_at + 'Z').getTime()
      : Infinity;
    const isStalled = lastRunAge > thresholdMs ||
      (latest?.last_run_status === 'partial' && lastRunAge > 45 * 60 * 1000);

    // Derive circuit state from agent_configs
    const isTripped = config?.enabled === 0 && config.paused_reason === 'auto:consecutive_failures';

    return {
      agent_id: agentId,
      last_run_at: latest?.last_run_at ?? null,
      last_run_status: latest?.last_run_status ?? null,
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
