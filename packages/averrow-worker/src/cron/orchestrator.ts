import { logger } from '../lib/logger';
import { feedModules, enrichmentModules, socialModules } from '../feeds/index';
import { createAlert } from '../lib/alerts';
import { cubeHealerAgent } from '../agents/cube-healer';
import { emitPlatformNotification, renderPlatformFeedSilent } from '../lib/platform-templates';
import { dispatchWorkflow } from '../lib/workflow-dispatch';
import type { Env } from '../types';

interface CronJobResult {
  job: string;
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  details?: string;
}

export async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  // ─── Navigator: lightweight sub-hour agent (*/5 * * * *, 30s CPU ceiling) ───
  // Runs on its own cron — independent of Flight Control's dispatch. FC only
  // observes Navigator's health, it does not manage when or how it runs.
  // Must branch BEFORE any heavy work — Flight Control, CertStream, etc.
  if (event.cron === '*/5 * * * *') {
    // Phase 2.4 of agent audit: navigator is now a standard
    // AgentModule dispatched through executeAgent — agent_runs row,
    // FC supervision, circuit breaker all uniform with every other
    // agent. scheduledTime is threaded via input so per-tick
    // hour-bucket math is unaffected by cron jitter.
    try {
      const { navigatorAgent } = await import('./navigator');
      const { executeAgent } = await import('../lib/agentRunner');
      await executeAgent(
        env,
        navigatorAgent,
        { scheduledTime: new Date(event.scheduledTime).toISOString(), _executionCtx: ctx },
        'cron',
        'scheduled',
      );
    } catch (err) {
      logger.error('navigator_dispatch_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ─── Daily briefing: dedicated trigger (13 13 * * *, once a day at 13:13 UTC) ───
  // Runs in its own scheduled invocation so it gets a fresh CPU/wall
  // budget instead of competing with the hourly mesh. Previously the
  // briefing was gated at hour===13 inside runThreatFeedScan, but
  // fetchComprehensiveBriefing's ~40 parallel queries exhausted the
  // budget before INSERT INTO threat_briefings could land — observed
  // as zero `cron:daily` entries despite the orchestrator firing
  // hourly. Manual `user:` triggers continued to work because they
  // came in via fetch with a fresh budget.
  if (event.cron === '13 13 * * *') {
    try {
      const today = new Date(event.scheduledTime).toISOString().slice(0, 10);
      let existing: { count: number } | null = null;
      try {
        existing = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM threat_briefings
           WHERE report_date = ? AND trigger LIKE 'cron%' AND emailed = 1`
        ).bind(today).first<{ count: number }>();
      } catch (err) {
        logger.error('briefing_dedup_check_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (existing && existing.count > 0) {
        logger.info('briefing_email_skipped_duplicate', { date: today });
        return;
      }

      const { generateAndEmailBriefing } = await import('../handlers/briefing');
      const result = await generateAndEmailBriefing(env);
      if (!result.emailSent) {
        logger.warn('briefing_email_not_sent', { briefingId: result.briefingId, error: result.error });
      } else {
        logger.info('briefing_email_delivered', { briefingId: result.briefingId });
      }
    } catch (err) {
      logger.error('briefing_dedicated_cron_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ─── Tenant weekly digest: dedicated trigger (24 14 * * 1, Mondays 14:24 UTC) ───
  // S4 (docs/IMPROVEMENT_PLAN_2026-06.md). One email per org per ISO week
  // for digest-enabled brands. Gated inside runWeeklyTenantDigest on
  // TENANT_DIGEST_MODE='live' (default off) + per-brand weekly_digest
  // opt-in + per-user intelligence_digest preference; KV week-stamp dedup
  // makes overlap with the manual internal endpoint safe.
  if (event.cron === '24 14 * * 1') {
    try {
      const { runWeeklyTenantDigest } = await import('../lib/tenant-digest');
      const result = await runWeeklyTenantDigest(env);
      logger.info('tenant_digest_cron_done', {
        mode: result.mode,
        orgs: result.orgs,
        sent: result.outcomes.filter((o) => o.status === 'sent').length,
        failed: result.outcomes.filter((o) => o.status === 'failed').length,
      });
    } catch (err) {
      logger.error('tenant_digest_cron_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ─── Cube healer tick: 30-day bulk rebuild (12 */6 * * *, 6-hourly at :12) ───
  // Heals retroactive enrichment drift that Navigator's current+prev-hour
  // refresh can't catch. Demoted from */20 to 6-hourly in Wave 1A to reduce
  // D1 writer contention. Overlaps "prev hour" with Navigator — safe because
  // INSERT OR REPLACE is idempotent.
  if (event.cron === '12 */6 * * *') {
    // Phase 2.3 of agent audit: cube_healer is now a standard
    // AgentModule dispatched through executeAgent — same lifecycle
    // (agent_runs row, FC supervision, circuit breaker) as every
    // other agent. Errors caught + recorded; never thrown upstream.
    try {
      const { executeAgent } = await import('../lib/agentRunner');
      // PR-BM: thread scheduledTime so cube_healer can pick hot (2d)
      // vs cold (14d) window based on cron tick. Cold heal lands at
      // the 00:12 UTC tick once per day; other ticks run hot.
      await executeAgent(
        env,
        cubeHealerAgent,
        { scheduledTime: new Date(event.scheduledTime).toISOString() },
        'cron',
        'scheduled',
      );
    } catch (err) {
      logger.error('cube_healer_dispatch_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ─── Cartographer tick: dedicated invocation (9 * * * *, +2 min after orchestrator) ───
  //
  // Cartographer's hourly maintenance work (AI provider scoring, email
  // security scans, provider stats aggregation, plus one enrichment
  // batch) used to run only from FC's scaleAgents which shares the
  // orchestrator parent worker's CPU. 24% failure rate observed
  // 2026-05-13 over a 2-day window (14 failed / 58 total at :07-:12).
  //
  // Same fix as PR-E (enricher): own cron trigger = own Worker
  // invocation = fresh 5-min CPU / 15-min wall budget. FC scaleAgents
  // continues to fire ADDITIONAL cart instances on top when the
  // backlog warrants — those still share the orchestrator's CPU but
  // they're now backlog-scaling on top of a guaranteed baseline run,
  // not the only path.
  //
  // Overlap with FC's scaleAgents instances is harmless: cart writes
  // are idempotent (ON CONFLICT on provider_threat_stats; per-row
  // UPDATEs on threats; brand-by-brand idempotent scans on
  // email_security_scans). Worst case is wasted ip-api subrequests
  // when two instances hit the same unenriched rows — quantifiable
  // and below the 50K subrequest cap.
  if (event.cron === '9 * * * *') {
    try {
      const { cartographerAgent } = await import('../agents/cartographer');
      const { executeAgent } = await import('../lib/agentRunner');
      await executeAgent(env, cartographerAgent, {}, 'cron', 'scheduled');
    } catch (err) {
      logger.error('cartographer_dispatch_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ─── Enricher tick: dedicated invocation (8 * * * *, +1 min after orchestrator) ───
  //
  // Enricher (domain_geo, brand_logo_hq, brand_sector_rdap, brand_firmographic)
  // averages ~231s wall with a 12-min walltime cap on domain_geo alone.
  // Previously dispatched inline from the orchestrator after runThreatFeedScan
  // — but the orchestrator's analyst inline await (~113s) was exhausting the
  // parent worker's CPU budget before enricher's line was reached, leaving
  // enricher dropped on 30-50% of ticks (13/24, 16/24, 15/24 over the prior
  // 3 days).
  //
  // Running enricher under its own cron trigger gives it a fresh Worker
  // invocation with the full 5-min CPU + 15-min wall budget, completely
  // decoupled from the orchestrator's contention. Same pattern Cube Healer
  // uses (12 */6 * * *). :08 placement chosen so it lands right after the
  // orchestrator's :07 tick — same hour cadence as before.
  if (event.cron === '8 * * * *') {
    try {
      const { enricherAgent } = await import('./enricher');
      const { executeAgent } = await import('../lib/agentRunner');
      await executeAgent(env, enricherAgent, {}, 'cron', 'scheduled');
    } catch (err) {
      logger.error('enricher_dispatch_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ─── Dedicated enrichment-feed crons (greynoise :19/4h, seclookup :21) ───
  //
  // Both were starving inside runAllEnrichmentFeeds' inline-sequential
  // chain (greynoise 8×30s + seclookup 100×1s sleeps blew the orchestrator
  // worker's wall-clock budget → worker killed → pull reaped silently →
  // breaker never advanced → feed sat overdue 11h+ while still enabled).
  // Each now runs in its own Worker invocation with a fresh budget; they
  // are SKIPPED in runAllEnrichmentFeeds (DEDICATED_ENRICHMENT_FEEDS) so
  // they don't double-dispatch. dispatchEnrichmentFeed honors enabled +
  // the circuit-breaker backoff but not the schedule interval (the cron is
  // the schedule). Same escape-hatch template as enricher/cartographer.
  if (event.cron === '19 */4 * * *') {
    try {
      const { dispatchEnrichmentFeed } = await import('../lib/feedRunner');
      await dispatchEnrichmentFeed(env, 'greynoise', enrichmentModules['greynoise']!);
    } catch (err) {
      logger.error('greynoise_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (event.cron === '21 * * * *') {
    try {
      const { dispatchEnrichmentFeed } = await import('../lib/feedRunner');
      await dispatchEnrichmentFeed(env, 'seclookup', enrichmentModules['seclookup']!);
    } catch (err) {
      logger.error('seclookup_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Abuse mailbox classifier dispatch (PR-AY) ─────────────────────
  //
  // Hourly at :17. Previously gated inside runThreatFeedScan at line ~1142
  // (before this PR moved it out). Same starvation pattern that hit
  // cart/strategist/sparrow earlier — the classifier sat AFTER all the
  // heavy agent dispatches in runThreatFeedScan and routinely never
  // executed when the orchestrator hit its CPU/wall ceiling. Production
  // evidence: last Haiku call 2026-05-17 04:17 UTC; a pending row arrived
  // at 18:08 UTC and sat untouched for 5+ hours (classification_attempts
  // stayed at 0). Same fix template as PR-E (enricher) and PR-Q
  // (strategist/sparrow): own cron trigger, fresh CPU budget per tick.
  //
  // Cadence: hourly — matches the original "ack on arrival +
  // determination within ~hour" promise on the /report-abuse marketing
  // page. Bounded at 50 rows per tick (Haiku ~$0.001/row).
  if (event.cron === '17 * * * *') {
    try {
      const pendingCount = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM abuse_inbox_messages WHERE classification = 'pending'`,
      ).first<{ n: number }>();
      if ((pendingCount?.n ?? 0) > 0) {
        // First-class dispatch: route through executeAgent so the run lands
        // in agent_runs + agent_events and surfaces in Flight Control /
        // platform-diagnostics / the Agents UI. (Previously called
        // runAbuseClassifierBackfill directly, which left the classifier
        // invisible to the agent mesh — the gap this promotion closes.)
        const { executeAgent } = await import('../lib/agentRunner');
        const { abuseMailboxClassifierAgent } = await import('../agents/abuseMailboxClassifier');
        const exec = await executeAgent(
          env,
          abuseMailboxClassifierAgent,
          { limit: 50, offset: 0 },
          'cron:17',
          'scheduled',
        );
        logger.info('abuse_mailbox_classifier_tick', {
          pending_before: pendingCount?.n ?? 0,
          run_id: exec.runId,
          status: exec.status,
          result: exec.result?.output ?? null,
        });
      }
    } catch (err) {
      logger.error('abuse_mailbox_classifier_tick_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ─── 6-hourly agents on dedicated crons (PR-Q) ─────────────────────
  //
  // Five agents (strategist, sparrow, app_store_monitor, dark_web_monitor,
  // social_discovery+social_monitor) used to be dispatched from the
  // orchestrator's hourly tick gated on `hour % 6 === 0`. They sit AFTER
  // analyst's 113s inline-await in runThreatFeedScan, so on heavy ticks
  // the parent worker hit its CPU ceiling before reaching their dispatch
  // lines. FC's recoverStalledAgents was firing 5-7 recoveries per tick
  // to catch them up.
  //
  // Same pattern as PR-E (enricher) and PR-F (cartographer): give each
  // its own cron trigger so it runs in its own Worker invocation with a
  // fresh 5-min CPU + 15-min wall budget. Cadence preserved (every 6h
  // at hours 0/6/12/18, just at different minutes to spread load).
  //
  // Each branch returns early so a single cron tick stays focused on
  // one agent.

  if (event.cron === '10 */6 * * *') {
    try {
      const { agentModules } = await import('../agents');
      const { executeAgent } = await import('../lib/agentRunner');
      const mod = agentModules['strategist'];
      if (mod) await executeAgent(env, mod, {}, 'cron', 'scheduled');
    } catch (err) {
      logger.error('strategist_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (event.cron === '11 */6 * * *') {
    try {
      const { agentModules } = await import('../agents');
      const { executeAgent } = await import('../lib/agentRunner');
      const mod = agentModules['sparrow'];
      if (mod) await executeAgent(env, mod, {}, 'cron', 'scheduled');
    } catch (err) {
      logger.error('sparrow_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (event.cron === '13 */6 * * *') {
    try {
      await runAppStoreMonitor(env);
    } catch (err) {
      logger.error('app_store_monitor_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (event.cron === '14 */6 * * *') {
    try {
      await runDarkWebMonitor(env);
    } catch (err) {
      logger.error('dark_web_monitor_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (event.cron === '15 */6 * * *') {
    // Discovery first — newly found handles get monitored in the same cycle.
    try {
      await runSocialDiscovery(env);
    } catch (err) {
      logger.error('social_discovery_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      await runSocialMonitor(env);
    } catch (err) {
      logger.error('social_monitor_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Daily brand-score batch (PR-T) ───
  //
  // Scores the entire brand catalog (~78K brands) and writes a
  // brand_score_snapshots row per scored brand. Pre-PR-T this was
  // gated on `hour === 0` inside runThreatFeedScan — same starvation
  // pattern as nexus/strategist/sparrow before PR-D/Q. The orchestrator's
  // analyst inline-await routinely exhausted the worker before reaching
  // the hour===0 block; the snapshot table sat at 0 rows for the entire
  // post-deploy window, which left the Brands page's Improving /
  // Declining cards forever empty.
  //
  // Dedicated cron at 00:16 UTC gives it a fresh Worker invocation
  // with the full 5-min CPU + 15-min wall budget, decoupled from the
  // orchestrator. Snapshots accumulate from day 1; PR-T's part D
  // (lib/brand-aggregates.ts) loosens the diff window so the cards
  // light up as soon as ≥1 day of history exists.
  if (event.cron === '16 0 * * *') {
    try {
      const { computeBrandScoresBatch } = await import('../lib/brand-scoring');
      const summary = await computeBrandScoresBatch(env);
      logger.info('brand_scores_daily_batch', summary);
    } catch (err) {
      logger.error('brand_scores_daily_batch_error', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ─── Hourly tick: full agent mesh (7 * * * *, 15min CPU ceiling) ───
  // Shifted from :00 to :07 in Wave 1A so the hourly mesh no longer collides
  // with the */5 Navigator that fires at :00. Parity-checker was removed as a
  // dedicated cron (demoted to daily in Wave 6); it no longer runs here.
  if (event.cron !== '7 * * * *') {
    console.log(`[cron] Unexpected cron in hourly fall-through: ${event.cron} — skipping mesh`);
    return;
  }

  // ─── Flight Control: autonomous supervisor runs first every tick ───
  // Pass ExecutionContext via input so FC can ctx.waitUntil() scaled agent
  // runs instead of blocking the cron mesh for minutes (Wave 1B).
  try {
    const { flightControlAgent } = await import('../agents/flightControl');
    const { executeAgent } = await import('../lib/agentRunner');
    await executeAgent(env, flightControlAgent, { _executionCtx: ctx }, 'cron', 'scheduled');
  } catch (err) {
    logger.error('flight_control_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // ─── Incident auto-resolve sweep ───
  // Walks open auto-created incidents and promotes ones whose
  // underlying symptoms have cleared from `investigating`/`identified`
  // → `monitoring`. Operator confirms `resolved` manually so flapping
  // signals can't prematurely retire an incident. Best-effort —
  // failure must not break the cron mesh.
  try {
    const { runIncidentRecoverySweep } = await import('../lib/incident-recovery');
    const result = await runIncidentRecoverySweep(env);
    if (result.recovered > 0 || result.stillFailing > 0) {
      console.log(
        `[cron] incident recovery: recovered=${result.recovered}, stillFailing=${result.stillFailing}, skipped=${result.skipped}`,
      );
    }
  } catch (err) {
    logger.error('incident_recovery_error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ─── CertStream: ensure persistent DO connection is alive ───
  try {
    const csId = env.CERTSTREAM_MONITOR.idFromName('certstream-primary');
    const csStub = env.CERTSTREAM_MONITOR.get(csId);
    const csResponse = await csStub.fetch(new Request('https://internal/start'));
    const csStatus = await csResponse.json() as { status: string; stats?: { connected: boolean; certsProcessed: number; certsMatched: number; errors: number } };
    console.log(`[cron] CertStream pinged — status=${csStatus.status}, connected=${csStatus.stats?.connected}, processed=${csStatus.stats?.certsProcessed}, matched=${csStatus.stats?.certsMatched}, errors=${csStatus.stats?.errors}`);

    // Log to agent_activity_log for Flight Control visibility
    await logFlightControlActivity(env, 'health_check', `CertStream DO: ${csStatus.status}`, {
      connected: csStatus.stats?.connected,
      certsProcessed: csStatus.stats?.certsProcessed,
      certsMatched: csStatus.stats?.certsMatched,
      errors: csStatus.stats?.errors,
    }, csStatus.stats?.connected ? 'info' : 'warning');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[cron] CertStream ping failed:', errMsg);
    logger.error('certstream_ping_failed', { error: errMsg });
    await logFlightControlActivity(env, 'health_check', `CertStream DO ping failed: ${errMsg}`, { error: errMsg }, 'warning');
  }

  // ─── Flight Control v1: consume pending agent_events before cron jobs ───
  await processAgentEvents(env, ctx);

  // Use scheduledTime (the intended cron fire time) — NOT new Date().
  // Pre-work (Flight Control, CertStream, event processing) can push
  // wall-clock past the scheduled minute and skipping every job.
  const now = new Date(event.scheduledTime);
  const hour = now.getUTCHours();

  // ─── NEXUS workflow dispatch — fire EARLY, before any heavy inline awaits ───
  //
  // The previous placement (inside runThreatFeedScan at line ~860, after
  // sentinel + analyst) was never reached: 2026-05-13 diagnostics showed
  // zero `workflow_dispatched` activity_log rows at the 12/16/20 ticks
  // even though analyst was completing successfully. Root cause: analyst's
  // 113s inline await leaves the orchestrator parent worker out of CPU
  // before line 860 executes (same root as the chronic enricher drop
  // rate). Meanwhile FC's recoverStalledAgents kept dispatching nexus
  // inline every hour, creating fresh stuck-partial rows that perpetuated
  // the recovery loop.
  //
  // Moving dispatchWorkflow here — right after the prework block, before
  // runThreatFeedScan — means it fires while the worker still has a fresh
  // budget. ~50-100ms (KV read + workflow.create + KV put + activity_log
  // INSERT) is well within reach. dispatchWorkflow's internal try/catch
  // keeps a failure from breaking the orchestrator tick.
  if (hour % 4 === 0) {
    try {
      const result = await dispatchWorkflow(env, {
        workflow: env.NEXUS_RUN,
        workflowName: 'nexus-run',
        agentId: 'nexus',
      });
      logger.info('nexus_workflow_dispatch', { outcome: result.kind, ...(result.kind === 'dispatched' ? { instance_id: result.instance_id } : {}) });
    } catch (err) {
      logger.error('nexus_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const results: CronJobResult[] = [];

  // Threat feed scan + full agent mesh — runs every hourly tick.
  {
    const result = await runJob('threat_feed_scan', () => runThreatFeedScan(env, ctx, now));
    results.push(result);
  }

  // Enricher dispatch was relocated to the dedicated `8 * * * *` cron
  // trigger so it runs in its own Worker invocation with a fresh CPU
  // budget. The previous inline-await placement here was dropped on
  // 30-50% of ticks because the orchestrator's analyst inline-await
  // exhausted the parent worker before this line was reached.

  // 6-hourly agents — social_discovery + social_monitor + app_store_monitor
  // + dark_web_monitor were relocated to their own cron triggers in PR-Q
  // (15/13/14 */6 * * * respectively). They used to fire here gated on
  // hour % 6 === 0 but the orchestrator's analyst inline-await was
  // routinely exhausting the parent worker's CPU before reaching them,
  // forcing FC's recoverStalledAgents to catch up the gap. Now each runs
  // in its own Worker invocation with a fresh budget.
  //
  // Sentinel AI assessment of social mentions stays inline here because
  // it's a background ctx.waitUntil that doesn't block the cron mesh
  // and it depends on the freshly-pulled feed_pulled events from the
  // 7 * * * * tick (Sentinel/social-monitor handoff). Keeping it
  // attached to the hourly tick preserves the timing.
  if (hour % 6 === 0) {
    const { runSentinelSocialAssessment } = await import('../agents/sentinel');
    ctx.waitUntil(
      runSentinelSocialAssessment(env).catch(err =>
        logger.error('cron_sentinel_social_failed', { error: String(err) })
      )
    );
  }

  // ─── Weekly: Recon (auto_seeder) — Sundays at 05:00 UTC ───
  // Dispatched from inside the hourly orchestrator instead of a
  // dedicated cron entry because Cloudflare's cron parser rejects
  // '23 5 * * 0' even though it's standard 5-field cron syntax (CF
  // error 10100 at deploy time). Day-of-week + hour gate is fine
  // per the cron-audit rule (CLAUDE.md §6) — it operates on the
  // broader scheduledTime context rather than a minute literal.
  // Hourly cron fires at :07 so the actual run time is 05:07 UTC.
  // Per-tick, hour-only gates are re-checked against scheduledTime
  // — never against `new Date()` — to survive cron jitter.
  if (now.getUTCDay() === 0 && hour === 5) {
    try {
      const { autoSeederAgent } = await import('../agents/auto-seeder');
      const { executeAgent } = await import('../lib/agentRunner');
      await executeAgent(env, autoSeederAgent, {}, 'cron', 'scheduled');
    } catch (err) {
      logger.error('auto_seeder_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ─── Weekly: GeoIP Refresh — Sundays at 02:00 UTC (02:07 actual) ───
  // Polls MaxMind for a new GeoLite2-City release and re-imports
  // when the .sha256 fingerprint differs from the last successful
  // load. Most weeks are no-ops (one HTTPS HEAD + 70-byte GET; the
  // workflow's skip-if-current step exits before any heavy work).
  // When a new release is available, the workflow streams the ~80MB
  // archive, decompresses, and atomically swaps in the new ranges.
  // Cron-audit rule: hour-only gate, never minute. Sunday picked
  // because MaxMind ships Tue-Thu typically — we catch the latest
  // release within ~3 days.
  if (now.getUTCDay() === 0 && hour === 2) {
    try {
      const { geoipRefreshAgent } = await import('../agents/geoip-refresh');
      const { executeAgent } = await import('../lib/agentRunner');
      // ctx.waitUntil so the agent dispatch (which itself spawns a
      // long-running Workflow) doesn't block the rest of the
      // orchestrator tick.
      ctx.waitUntil(
        executeAgent(env, geoipRefreshAgent, {}, 'cron', 'scheduled').catch((err) => {
          logger.error('geoip_refresh_error', { error: err instanceof Error ? err.message : String(err) });
        }),
      );
    } catch (err) {
      logger.error('geoip_refresh_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Daily at 06:00 UTC: Observer briefing + threat narratives
  if (hour === 6) {
    const result = await runJob('observer_briefing', () => runObserverBriefing(env));
    results.push(result);

    // After Observer briefing: generate threat narratives for active brands with recent signals
    const narrativeResult = await runJob('threat_narratives', () => runThreatNarratives(env));
    results.push(narrativeResult);
  }

  // Daily at hour 13: per-user notification digest envelopes.
  // The briefing email itself moved to a dedicated `13 13 * * *` cron
  // trigger (see handleScheduled above) — gating it inside the hourly
  // mesh exhausted the worker budget every day before the briefing
  // could run, leaving the threat_briefings table without a single
  // `cron:daily` row for days. The digest envelope is lighter and
  // can stay here.
  if (hour === 13) {
    const digestResult = await runJob('notification_narrator', async () => {
      const { executeAgent } = await import('../lib/agentRunner');
      const { notificationNarratorAgent } = await import('../agents/notification_narrator');
      await executeAgent(env, notificationNarratorAgent);
    });
    results.push(digestResult);
  }

  // CT certificate monitoring — runs every hourly tick (was every 5 min when cron was */15)
  {
    const result = await runJob('ct_monitor', () => runCTMonitor(env));
    results.push(result);
  }

  // Lookalike domain checks — runs every hourly tick (was staggered to minute 15)
  {
    const result = await runJob('lookalike_check', () => runLookalikeDomainCheck(env));
    results.push(result);
  }

  // Trademark correlation — runs every hourly tick (internal-only, cheap;
  // unifies wordmark misuse across social/app-store/domain signals).
  {
    const result = await runJob('trademark_scan', () => runTrademarkScan(env));
    results.push(result);
  }

  // Log summary
  logger.info('cron_complete', {
    jobs_run: results.length,
    results: results.map(r => ({ job: r.job, status: r.status, ms: r.durationMs })),
  });

  // Store last cron run status in KV so the health endpoint can report it
  await env.CACHE.put('cron_last_run', JSON.stringify({
    timestamp: now.toISOString(),
    results,
  }), { expirationTtl: 7200 }); // 2 hour TTL
}

// ─── Flight Control v1: Agent Event Consumer ────────────────────
async function processAgentEvents(env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    const events = await env.DB.prepare(`
      SELECT id, event_type, source_agent, target_agent, payload_json, priority
      FROM agent_events
      WHERE status = 'pending'
      ORDER BY priority ASC, created_at ASC
      LIMIT 10
    `).all<{
      id: string;
      event_type: string;
      source_agent: string;
      target_agent: string;
      payload_json: string | null;
      priority: number;
    }>();

    if (events.results.length === 0) return;

    // Log Flight Control event processing decision to activity log
    await logFlightControlActivity(env, 'scaling', `Processing ${events.results.length} pending agent events`, {
      eventCount: events.results.length,
      eventTypes: events.results.map(e => e.event_type),
    }, 'info');

    const { agentModules } = await import('../agents/index');
    const { executeAgent } = await import('../lib/agentRunner');

    for (const event of events.results) {
      // Mark as processing to prevent double-processing
      await env.DB.prepare(
        `UPDATE agent_events SET status = 'processing' WHERE id = ?`
      ).bind(event.id).run();

      try {
        const payload = event.payload_json ? JSON.parse(event.payload_json) as Record<string, unknown> : {};
        // Telemetry-only events carry target_agent=NULL or an empty
        // string. They're written to give operators a forensic record
        // of agent completions (e.g. threats_enriched, nexus_complete)
        // but don't drive control flow — cron + FC already dispatch the
        // relevant downstream work on a fixed cadence. Mark as 'done'
        // without trying to dispatch and without warning.
        const isTelemetry = !event.target_agent || event.target_agent.length === 0;
        const mod = isTelemetry ? undefined : agentModules[event.target_agent];

        if (mod) {
          ctx.waitUntil(
            executeAgent(env, mod, { ...payload, triggeredByEvent: event.event_type }, "cron", "event")
          );
        } else if (!isTelemetry) {
          // target_agent was set but we don't have a module for it —
          // genuine misconfiguration worth surfacing.
          logger.warn('agent_event_unknown_target', {
            event_id: event.id,
            target_agent: event.target_agent,
            event_type: event.event_type,
          });
        }

        await env.DB.prepare(
          `UPDATE agent_events SET status = 'done', processed_at = datetime('now') WHERE id = ?`
        ).bind(event.id).run();

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('agent_event_processing_failed', {
          event_id: event.id,
          target_agent: event.target_agent,
          error: message,
        });
        await env.DB.prepare(
          `UPDATE agent_events SET status = 'failed' WHERE id = ?`
        ).bind(event.id).run();

        await logFlightControlActivity(env, 'recovery', `Agent event processing failed for ${event.target_agent}: ${message}`, {
          event_id: event.id,
          target_agent: event.target_agent,
          event_type: event.event_type,
        }, 'warning');
      }
    }

    logger.info('agent_events_processed', { count: events.results.length });
  } catch (err) {
    logger.error('agent_events_consumer_error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runJob(name: string, fn: () => Promise<void>): Promise<CronJobResult> {
  const start = Date.now();
  try {
    await fn();
    return { job: name, status: 'success', durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('cron_job_failed', { job: name, error: message });
    return { job: name, status: 'error', durationMs: Date.now() - start, details: message };
  }
}

// ─── Job Implementations ──────────────────────────────────────

/**
 * Called from handleScheduled() on the hourly orchestrator cron (7 * * * *).
 *
 * IMPORTANT: All time gates inside this function use hour-only checks.
 * Do NOT add minute-based gates — the cron fires at a single minute per hour
 * and any minute check that doesn't match that exact value silently kills
 * the gated code. If sub-hourly scheduling is needed, use Navigator
 * (every 5 min cron) or add a dedicated cron trigger.
 *
 * Bug history: The orchestrator was created with cron `0 * * * *` (hourly at :00).
 * On 2026-04-12 Wave 1A moved it to `7 * * * *` to decollide with Navigator.
 * The outer `minute === 0 || minute === 30` gate was not updated, silently
 * killing this function for ~22 hours until caught by static analysis.
 * Fix: all minute gates removed, hour-only gates retained (2026-04-12).
 *
 * Side effects of the fix: two pre-existing bugs were corrected at the same
 * time. The `minute === 15` lookalike check gate had been dead since the
 * original `0 * * * *` cron (never fired in production). The `minute % 5 === 0`
 * CT monitor gate was aspirational (it was hourly in practice because
 * 0 % 5 === 0 on the original cron). Both now run cleanly on the hourly cadence.
 */
async function runThreatFeedScan(env: Env, ctx: ExecutionContext, scheduledTime: Date): Promise<void> {
  const hour = scheduledTime.getUTCHours();

  // Geo enrichment
  try {
    const { enrichThreatsGeo } = await import('../lib/geoip');
    await enrichThreatsGeo(env.DB, env.CACHE);
  } catch (e) {
    logger.error('threat_feed_scan_geo_error', { error: e instanceof Error ? e.message : String(e) });
  }

  // NOTE: domain→IP resolution moved to the dedicated Enricher job
  // (cron/enricher.ts). Coupling it to feed ingest meant a feed
  // failure could starve the enrichment pipeline. The Enricher now
  // owns it, with full activity logging and stall detection.

  // Feed ingestion — wrapped in try/catch so enrichment/social still run on failure.
  //
  // History note: this catch swallowed a thrown error for ~3 days during the
  // 2026-04-30 → 05-02 blackout (column-name typo in autoRecoverStalePausedFeeds,
  // fixed in 50cb1e4). The orchestrator kept ticking, enrichment + social feeds
  // ran from their own try/catch blocks below, but every ingest feed was silently
  // skipped because runAllFeeds threw before reaching per-feed dispatch. Nothing
  // surfaced to operators except a `logger.error` line that no human reads.
  //
  // The fix has two layers:
  //  1. Right here — when this catch fires, emit a platform_feed_silent alert
  //     directly with the throw message. Catches the specific shape (throw from
  //     runAllFeeds before per-feed dispatch).
  //  2. In flightControlAgent — a hourly watchdog that flags any enabled feed
  //     whose last_successful_pull is older than 3× its schedule_cron interval.
  //     Catches the broader symptom regardless of cause.
  const { runAllFeeds, runAllEnrichmentFeeds } = await import('../lib/feedRunner');
  let feedResult = { feedsRun: 0, totalNew: 0, feedsFailed: 0, feedsSkipped: 0 };
  try {
    feedResult = await runAllFeeds(env, feedModules);
    logger.info('threat_feed_scan_feeds', {
      feedsRun: feedResult.feedsRun,
      totalNew: feedResult.totalNew,
      feedsFailed: feedResult.feedsFailed,
      feedsSkipped: feedResult.feedsSkipped,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cron] INGEST FEEDS FAILED:', msg);
    logger.error('ingest_feeds_error', { error: msg });

    // Layer 1: surface the throw immediately as a platform notification so
    // operators don't have to wait for the FC watchdog tick (or worse, for
    // someone to manually run diagnostics) to find out ingestion is dead.
    // Notification failures must never break the cron — wrap and swallow.
    try {
      await emitPlatformNotification(env, 'platform_feed_silent',
        renderPlatformFeedSilent({
          feed_ids: '(runAllFeeds threw before per-feed dispatch)',
          feed_count: 0,
          worst_ratio: 0,
          worst_feed: 'runAllFeeds',
          worst_hours_since_pull: 0,
          cause_hint: msg,
        })
      );
    } catch (notifyErr) {
      logger.error('ingest_feeds_alert_emit_failed', {
        error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      });
    }
  }

  // ─── API Key Health Check: log presence of enrichment API keys ───
  {
    const keyStatus = {
      GREYNOISE_API_KEY: !!env.GREYNOISE_API_KEY,
      SECLOOKUP_API_KEY: !!env.SECLOOKUP_API_KEY,
      VIRUSTOTAL_API_KEY: !!env.VIRUSTOTAL_API_KEY,
      ABUSEIPDB_API_KEY: !!env.ABUSEIPDB_API_KEY,
      HIBP_API_KEY: !!env.HIBP_API_KEY,
      GOOGLE_SAFE_BROWSING_KEY: !!env.GOOGLE_SAFE_BROWSING_KEY,
    };
    const missing = Object.entries(keyStatus).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
      console.warn(`[cron] Missing API keys: ${missing.join(', ')}`);
      logger.warn('enrichment_api_keys_missing', { missing, present: Object.entries(keyStatus).filter(([, v]) => v).map(([k]) => k) });
    } else {
      console.log('[cron] All enrichment API keys present');
    }
  }

  // Enrichment feeds (SURBL, VirusTotal, HIBP) — run AFTER ingest feeds
  try {
    const enrichmentNames = Object.keys(enrichmentModules);
    console.log(`[cron] About to run enrichment feeds...`);
    console.log(`[cron] Enrichment modules registered: ${enrichmentNames.join(', ')}`);
    const enrichResult = await runAllEnrichmentFeeds(env, enrichmentModules);
    console.log(`[cron] Enrichment feeds complete: run=${enrichResult.feedsRun} enriched=${enrichResult.totalEnriched} failed=${enrichResult.feedsFailed} skipped=${enrichResult.feedsSkipped}`);
    logger.info('threat_feed_scan_enrichment_feeds', {
      feedsRun: enrichResult.feedsRun,
      totalEnriched: enrichResult.totalEnriched,
      feedsFailed: enrichResult.feedsFailed,
      feedsSkipped: enrichResult.feedsSkipped,
    });
  } catch (err) {
    console.error('[cron] ENRICHMENT FEEDS FAILED:', err instanceof Error ? err.message : String(err));
    logger.error('enrichment_feeds_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // Social intelligence feeds (Reddit, GitHub) — insert into social_mentions
  try {
    const { runAllSocialFeeds } = await import('../lib/feedRunner');
    const socialResult = await runAllSocialFeeds(env, socialModules);
    console.log(`[cron] Social feeds complete: run=${socialResult.feedsRun} new=${socialResult.totalNew} failed=${socialResult.feedsFailed} skipped=${socialResult.feedsSkipped}`);
    logger.info('threat_feed_scan_social_feeds', {
      feedsRun: socialResult.feedsRun,
      totalNew: socialResult.totalNew,
      feedsFailed: socialResult.feedsFailed,
      feedsSkipped: socialResult.feedsSkipped,
    });

    // Trigger Watchdog if there are unclassified social mentions
    if (socialResult.totalNew > 0) {
      try {
        const socialBacklog = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM social_mentions WHERE status = 'new'"
        ).first<{ count: number }>();
        if ((socialBacklog?.count ?? 0) > 0) {
          const { agentModules: socialAgents } = await import('../agents/index');
          const watchdogMod = socialAgents["watchdog"];
          if (watchdogMod) {
            const { executeAgent: runAgent } = await import('../lib/agentRunner');
            await runAgent(env, watchdogMod, { trigger: 'social_feeds', backlog: socialBacklog?.count ?? 0 }, 'cron', 'event');
            logger.info('social_feeds_triggered_watchdog', { backlog: socialBacklog?.count ?? 0 });
          }
        }
      } catch (watchdogErr) {
        logger.error('social_feeds_watchdog_trigger_error', { error: watchdogErr instanceof Error ? watchdogErr.message : String(watchdogErr) });
      }
    }
  } catch (err) {
    console.error('[cron] SOCIAL FEEDS FAILED:', err instanceof Error ? err.message : String(err));
    logger.error('social_feeds_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // Enrichment pipeline
  //
  // Cadence gate (2026-05-16 cost sweep): runs at hour % 4 === 0
  // (00/04/08/12/16/20 UTC = 6×/day) instead of every hourly tick
  // (24×/day). Each invocation issues 5 COUNT(*) diagnostics +
  // touches every stage (DNS, geo, RDAP, brand, ranking, corroboration,
  // provider-counts sync). Most stages also run from dedicated
  // dispatch paths (Navigator dns-backfill every 5min, Cartographer
  // geo every hour, brand-match backfill below, Stage 4c gated to
  // 6h via KV stamp). 6×/day was empirically sufficient before the
  // hourly bump that came with the audit work.
  //
  // The manual /api/threats/enrich-all path remains hourly-or-on-demand
  // — operators can force a run when triaging.
  if (hour % 4 === 0) {
    try {
      const { runEnrichmentPipeline } = await import('../lib/enrichment');
      const enrichResult = await runEnrichmentPipeline(env);
      logger.info('threat_feed_scan_enrichment', {
        dnsResolved: enrichResult.dnsResolved,
        geoEnriched: enrichResult.geoEnriched,
        whoisEnriched: enrichResult.whoisEnriched,
        brandsMatched: enrichResult.brandsMatched,
        domainRanksChecked: enrichResult.domainRanksChecked,
      });
    } catch (err) {
      logger.error('threat_feed_scan_enrichment_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Brand match backfill (2 rounds)
  try {
    const { runBrandMatchBackfill } = await import('../handlers/admin');
    const pendingRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NULL AND (malicious_domain IS NOT NULL OR malicious_url IS NOT NULL OR ioc_value IS NOT NULL)"
    ).first<{ n: number }>();
    const pending = pendingRow?.n ?? 0;
    if (pending > 0) {
      let totalMatched = 0;
      for (let i = 0; i < 2; i++) {
        const bf = await runBrandMatchBackfill(env);
        totalMatched += bf.matched;
        if (bf.pending === 0 || bf.checked === 0) break;
      }
      logger.info('threat_feed_scan_brand_match', { pending, matched: totalMatched });
    }
  } catch (err) {
    logger.error('threat_feed_scan_brand_match_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // Email security scan (10 brands/cycle)
  try {
    const pendingEmail = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM brands WHERE email_security_scanned_at IS NULL AND canonical_domain IS NOT NULL"
    ).first<{ n: number }>();
    const emailPending = pendingEmail?.n ?? 0;
    if (emailPending > 0) {
      const { runEmailSecurityScan, saveEmailSecurityScan } = await import('../email-security');
      const brandsToScan = await env.DB.prepare(`
        SELECT b.id, COALESCE(b.canonical_domain, LOWER(b.name)) AS domain
        FROM brands b
        LEFT JOIN threats t ON t.target_brand_id = b.id AND t.status = 'active'
        WHERE b.email_security_scanned_at IS NULL
          AND (b.canonical_domain IS NOT NULL OR b.name IS NOT NULL)
        GROUP BY b.id
        ORDER BY COUNT(t.id) DESC
        LIMIT 10
      `).all<{ id: number; domain: string }>();
      let scanned = 0;
      for (const brand of brandsToScan.results) {
        try {
          const scanResult = await runEmailSecurityScan(brand.domain);
          await saveEmailSecurityScan(env.DB, brand.id, scanResult);
          await env.DB.prepare(
            "UPDATE brands SET email_security_score = ?, email_security_grade = ?, email_security_scanned_at = datetime('now') WHERE id = ?"
          ).bind(scanResult.score, scanResult.grade, brand.id).run();
          scanned++;
        } catch (e) {
          logger.error('threat_feed_scan_email_security_brand_error', { domain: brand.domain, error: e instanceof Error ? e.message : String(e) });
        }
      }
      logger.info('threat_feed_scan_email_security', { pending: emailPending, scanned });
    }
  } catch (err) {
    logger.error('threat_feed_scan_email_security_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // Email grade change detection — compare latest scan with previous grade
  try {
    const gradeChanges = await env.DB.prepare(`
      SELECT b.id AS brand_id, b.name, b.email_security_grade AS current_grade,
             ess.email_security_grade AS previous_grade
      FROM brands b
      JOIN email_security_scans ess ON ess.brand_id = b.id
      WHERE b.email_security_grade IS NOT NULL
        AND ess.email_security_grade IS NOT NULL
        AND b.email_security_grade != ess.email_security_grade
        AND ess.scanned_at < b.email_security_scanned_at
        AND ess.scanned_at = (
          SELECT MAX(e2.scanned_at) FROM email_security_scans e2
          WHERE e2.brand_id = b.id AND e2.scanned_at < b.email_security_scanned_at
        )
    `).all<{ brand_id: string; name: string; current_grade: string; previous_grade: string }>();

    for (const change of gradeChanges.results) {
      // Check if we already created an alert for this grade transition recently
      const existing = await env.DB.prepare(
        `SELECT id FROM alerts
         WHERE brand_id = ? AND alert_type = 'email_grade_change'
           AND created_at >= datetime('now', '-24 hours')
         LIMIT 1`
      ).bind(change.brand_id).first<{ id: string }>();

      if (existing) continue;

      // Determine severity based on direction and resulting grade
      const degraded = ['F', 'D'].includes(change.current_grade);
      const severity = degraded ? 'HIGH' : 'MEDIUM';

      // brand_profiles retired (R8, 2026-05-07). Email-grade-change
      // alerts are tenant-scoped at read time via brand_id → org_brands,
      // so creation attributes to a stable 'system' userId. The legacy
      // path looked up an owning user via brand_profiles; that table
      // is dead.
      const userId = 'system';

      await createAlert(env.DB, {
        brandId: change.brand_id,
        userId,
        alertType: 'email_grade_change',
        severity: severity as 'HIGH' | 'MEDIUM',
        title: `Email security grade changed: ${change.previous_grade} → ${change.current_grade}`,
        summary: `${change.name} email security grade changed from ${change.previous_grade} to ${change.current_grade}.${degraded ? ' The domain now has weak spoofing protection — phishing attacks are more likely to succeed.' : ''}`,
        details: {
          brand_name: change.name,
          previous_grade: change.previous_grade,
          current_grade: change.current_grade,
        },
        sourceType: 'email_security_scan',
      });

      logger.info('email_grade_change_alert', {
        brand_id: change.brand_id,
        brand_name: change.name,
        previous_grade: change.previous_grade,
        current_grade: change.current_grade,
        severity,
      });
    }

    if (gradeChanges.results.length > 0) {
      logger.info('email_grade_change_detection', { changes_detected: gradeChanges.results.length });
    }
  } catch (err) {
    logger.error('email_grade_change_detection_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // AI attribution (1 batch of 50)
  try {
    const unmatchedCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IS NULL AND threat_type IN ('phishing','credential_harvesting','typosquatting','impersonation')"
    ).first<{ n: number }>();
    const unmatched = unmatchedCount?.n ?? 0;
    if (unmatched > 500) {
      const today = scheduledTime.toISOString().slice(0, 10);
      const attrCallsToday = parseInt(await env.CACHE.get(`ai_attr_calls_${today}`) || '0', 10);
      if (attrCallsToday < 20) {
        const { runAiAttribution } = await import('../handlers/admin');
        const attrResult = await runAiAttribution(env, 50);
        logger.info('threat_feed_scan_ai_attribution', {
          attributed: attrResult.attributed,
          calls: attrResult.calls,
          costUsd: attrResult.costUsd,
        });
      }
    }
  } catch (err) {
    logger.error('threat_feed_scan_ai_attribution_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // Threat feed sync (PhishTank, URLhaus signals)
  try {
    const { runThreatFeedSync } = await import('../threat-feeds');
    const syncResult = await runThreatFeedSync(env);
    logger.info('threat_feed_scan_sync', {
      phishtank: `${syncResult.phishtank.matched}/${syncResult.phishtank.fetched}`,
      urlhaus: `${syncResult.urlhaus.matched}/${syncResult.urlhaus.fetched}`,
    });
  } catch (err) {
    logger.error('threat_feed_scan_sync_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // ─── AI Agents ─────────────────────────────────────────────────
  const { agentModules: allAgents } = await import('../agents/index');
  const { executeAgent } = await import('../lib/agentRunner');

  // Sentinel: event-triggered on new data
  if (feedResult.totalNew > 0) {
    try {
      const mod = allAgents["sentinel"];
      if (mod) {
        await executeAgent(env, mod, { newItems: feedResult.totalNew }, "cron", "event");
      }
    } catch (err) {
      logger.error('threat_feed_scan_sentinel_error', { error: err instanceof Error ? err.message : String(err) });
    }

    // Write feed_pulled event for traceability ONLY (target_agent = NULL).
    //
    // Pre-PR-L this was target_agent='cartographer' so the agent_events
    // consumer would dispatch cart on every feed pull. Now redundant —
    // cart runs from its own `9 * * * *` cron (PR-F) AND from FC's
    // scaleAgents on backlog growth. The event-driven dispatch was
    // creating a 3rd cart instance per hour for no incremental
    // throughput. Keeping the event as a forensic record of "sentinel
    // just produced N new items" — operators read it via
    // agent_activity_log / diagnostics, no auto-dispatch needed.
    try {
      await env.DB.prepare(`
        INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
        VALUES (?, 'feed_pulled', 'sentinel', NULL, ?, 2, 'pending')
      `).bind(crypto.randomUUID(), JSON.stringify({ newItems: feedResult.totalNew, trigger: 'immediate' })).run();
    } catch (err) {
      logger.error('sentinel_event_write_error', { error: err instanceof Error ? err.message : String(err) });
    }

    // Cartographer — dispatched from Flight Control via scaleAgents
    // (agent-module path). The Workflow dispatch that previously lived
    // here stopped firing around Apr 19 (symptom: zero entries in
    // agent_activity_log for cartographer/nexus from that date onward).
    // Until the Workflow platform issue is root-caused, Flight Control's
    // scaleAgents call keeps Cart backlog draining via the agent module;
    // no additional orchestrator dispatch needed here.
  }

  // Analyst agent — runs every hourly tick.
  // Inline await for the same reason as sparrow / strategist (PR #832):
  // ctx.waitUntil silently drops runs when the orchestrator invocation
  // is killed first. Analyst's avg duration is ~40-60s — fits comfortably
  // under the 15-min cron CPU ceiling alongside the other inline awaits.
  {
    try {
      const mod = allAgents["analyst"];
      if (mod) {
        await executeAgent(env, mod, {}, "cron", "scheduled");
      }
    } catch (err) {
      logger.error('threat_feed_scan_analyst_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Cartographer: see note above. Flight Control handles it via scaleAgents.

  // Strategist relocated to dedicated `10 */6 * * *` cron in PR-Q.
  // Was here as `hour % 6 === 0` inline await but routinely failed to
  // run when the orchestrator's parent worker exhausted its CPU budget
  // on analyst's 113s inline await above. FC's recoverStalledAgents
  // was catching up the gap — now unnecessary.

  // NEXUS workflow dispatch was relocated to handleScheduled() — fires
  // BEFORE runThreatFeedScan is entered so it isn't blocked behind the
  // analyst inline-await that exhausts the parent worker's CPU budget
  // (see the comment block above the dispatch site in handleScheduled).

  // Attributor — Phase C of the Threat Actors rebuild. Classifies
  // NEXUS clusters by responsible threat actor via Haiku, then writes
  // threat_attributions rows so the Threat Actors page surfaces real
  // cluster→actor links instead of static seed data.
  //
  // Dispatched at hour % 4 === 1 so it runs the cron tick AFTER NEXUS
  // (which writes/refreshes clusters at hour % 4 === 0). This gives
  // any new clusters a one-hour settling window before the attributor
  // tries to classify them. Bounded by CLUSTER_BATCH per run.
  if (hour % 4 === 1) {
    try {
      const mod = allAgents["attributor"];
      if (mod) {
        await executeAgent(env, mod, {}, "cron", "scheduled");
      }
    } catch (err) {
      logger.error('attributor_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // News Watcher — Phase D of the Threat Actors rebuild. Polls a
  // configured set of threat-intel RSS / Atom feeds (CISA, Microsoft
  // Threat Intel, Mandiant), extracts actor + geopolitical context
  // via Haiku, and writes news_articles + threat_actors upserts +
  // geopolitical_campaigns rows.
  //
  // Dispatched at hour % 6 === 2 — jittered off NEXUS (% 4 === 0),
  // Attributor (% 4 === 1), and Sparrow / Strategist (% 6 === 0)
  // so we don't pile Haiku throughput on the same tick. Bounded by
  // ARTICLES_PER_RUN per run.
  if (hour % 6 === 2) {
    try {
      const mod = allAgents["news_watcher"];
      if (mod) {
        await executeAgent(env, mod, {}, "cron", "scheduled");
      }
    } catch (err) {
      logger.error('news_watcher_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Sparrow relocated to dedicated `11 */6 * * *` cron in PR-Q.
  // Same rationale as strategist above — was getting starved by the
  // orchestrator's heavy inline awaits.

  // Observer + daily assessments — daily at midnight UTC
  if (hour === 0) {
    try {
      const mod = allAgents["observer"];
      if (mod) {
        await executeAgent(env, mod, {}, "cron", "scheduled");
      }
    } catch (err) {
      logger.error('threat_feed_scan_observer_error', { error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const { runDailyAssessments } = await import('../brand-threat-correlator');
      const assessResult = await runDailyAssessments(env);
      logger.info('threat_feed_scan_daily_assessments', {
        brandsAssessed: assessResult.brandsAssessed,
        highRiskBrands: assessResult.highRiskBrands,
        scoreSpikes: assessResult.scoreSpikes,
      });
    } catch (err) {
      logger.error('threat_feed_scan_daily_assessments_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Pathfinder — DEMOTED TO MANUAL TRIGGER 2026-04-29 (Phase 2.6 of
  // agent audit). The previous daily 03:00 UTC dispatch produced 1
  // run/24h and 0 records over 7d; the lead-creation Phase 1 was
  // throttled to once per 7 days via KV anyway. Operators now trigger
  // explicitly via POST /api/agents/pathfinder/trigger when sales
  // intelligence is desired. Resurrect by reverting this commit.

  // Daily snapshots — generate if none exist today
  try {
    const { generateDailySnapshots } = await import('../lib/snapshots');
    const today = scheduledTime.toISOString().slice(0, 10);
    const hasSnapshotToday = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM daily_snapshots WHERE date = ?"
    ).bind(today).first<{ n: number }>();
    if (hour === 0 || (hasSnapshotToday?.n ?? 0) === 0) {
      await generateDailySnapshots(env.DB, today);
    }
  } catch (err) {
    logger.error('threat_feed_scan_snapshots_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // ── Abuse mailbox classifier ──
  //
  // Moved to its own dedicated `17 * * * *` cron in PR-AY (handler at
  // the top of handleScheduled, alongside enricher/cartographer).
  // Reason: this block was positioned LATE in runThreatFeedScan (after
  // every heavy agent dispatch), and the orchestrator routinely hit
  // its CPU/wall ceiling before reaching here. Production evidence:
  // last Haiku call 2026-05-17 04:17 UTC, despite pending rows
  // arriving in the meantime.
  //
  // Same starvation pattern + same fix template as PR-E (enricher),
  // PR-F (cartographer), PR-Q (strategist/sparrow/etc). The new cron
  // dispatch runs with a fresh per-invocation budget.

  // NOTE: daily brand-score batch (computeBrandScoresBatch) was
  // gated on `hour === 0` here but routinely never executed —
  // analyst inline-await + scan workload exhausted the worker
  // before reaching this line, leaving `brand_score_snapshots`
  // at 0 rows since the feature shipped (and the Brands page
  // Improving/Declining cards permanently empty). PR-T moved
  // it to a dedicated `16 0 * * *` cron with its own CPU budget.

  // CT-driven brand candidate aggregator. Runs once daily at hour===0.
  // Surfaces apex domains seen ≥3x across ≥2 distinct issuers in the
  // last 30 days as proposed brand candidates for operator review.
  // Existing brands and existing candidates are skipped.
  if (hour === 0) {
    try {
      const { aggregateBrandCandidates } = await import('../lib/brand-candidates');
      const summary = await aggregateBrandCandidates(env);
      logger.info('brand_candidates_aggregator', summary);
    } catch (err) {
      logger.error('brand_candidates_aggregator_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function runSocialDiscovery(env: Env): Promise<void> {
  // Dispatch via executeAgent so every run lands in agent_runs / agent_outputs,
  // respects the circuit breaker, and surfaces in Flight Control + the Agents UI.
  const { executeAgent } = await import('../lib/agentRunner');
  const { socialDiscoveryAgent } = await import('../agents/socialDiscovery');
  await executeAgent(env, socialDiscoveryAgent, {}, 'orchestrator', 'scheduled');
}

async function runSocialMonitor(env: Env): Promise<void> {
  // Dispatch via executeAgent so every run lands in agent_runs / agent_outputs,
  // respects the circuit breaker, and surfaces in Flight Control + the Agents UI.
  const { executeAgent } = await import('../lib/agentRunner');
  const { socialMonitorAgent } = await import('../agents/socialMonitor');
  await executeAgent(env, socialMonitorAgent, {}, 'orchestrator', 'scheduled');
}

async function runAppStoreMonitor(env: Env): Promise<void> {
  // Dispatch via executeAgent so every run lands in agent_runs / agent_outputs,
  // respects the circuit breaker, and surfaces in Flight Control + the Agents UI.
  const { executeAgent } = await import('../lib/agentRunner');
  const { appStoreMonitorAgent } = await import('../agents/appStoreMonitor');
  await executeAgent(env, appStoreMonitorAgent, {}, 'orchestrator', 'scheduled');
}

async function runDarkWebMonitor(env: Env): Promise<void> {
  // Dispatch via executeAgent so every run lands in agent_runs / agent_outputs,
  // respects the circuit breaker, and surfaces in Flight Control + the Agents UI.
  const { executeAgent } = await import('../lib/agentRunner');
  const { darkWebMonitorAgent } = await import('../agents/darkWebMonitor');
  await executeAgent(env, darkWebMonitorAgent, {}, 'orchestrator', 'scheduled');
}

async function runObserverBriefing(env: Env): Promise<void> {
  // Daily Tranco import + brand matching (runs at 06:00 UTC).
  // Daily cron pulls top 100K. First run after deploy will INSERT the
  // delta (~90K rows) which takes ~90s of D1 batch time — well within
  // the orchestrator tick's compute budget when wrapped via the
  // existing await pattern. Subsequent daily runs are mostly dedupe-
  // skips + a small UPDATE pass for ranks that drifted week-over-week
  // (fast — single-digit seconds).
  try {
    const { handleImportTranco, runBrandMatchBackfill } = await import('../handlers/admin');
    const fakeReq = new Request('https://localhost/api/admin/import-tranco', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 100000 }),
    });
    const trancoRes = await handleImportTranco(fakeReq, env);
    const trancoData = await trancoRes.json() as { success: boolean; data?: { imported: number; updated?: number; message: string } };
    logger.info('observer_briefing_tranco', { message: trancoData.data?.message ?? 'unknown' });
    if (trancoData.data?.imported && trancoData.data.imported > 0) {
      let postImportMatched = 0;
      for (let i = 0; i < 5; i++) {
        const bf = await runBrandMatchBackfill(env);
        postImportMatched += bf.matched;
        if (bf.pending === 0 || bf.checked === 0) break;
      }
      logger.info('observer_briefing_post_tranco_match', { matched: postImportMatched });
    }
  } catch (err) {
    logger.error('observer_briefing_tranco_error', { error: err instanceof Error ? err.message : String(err) });
  }

  // NOTE: brand logo/HQ + sector/RDAP enrichment moved to the dedicated
  // Enricher job (cron/enricher.ts). Running it once per day from inside
  // Observer was a single point of failure with no observability and no
  // retries. The Enricher now owns it on every cron tick.

  // Seed Strategist agent
  try {
    const { seedStrategistAgent } = await import('../agents/seed-strategist');
    const { executeAgent } = await import('../lib/agentRunner');
    await executeAgent(env, seedStrategistAgent, {}, "cron", "scheduled");
  } catch (err) {
    logger.error('observer_briefing_seed_strategist_error', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function runCTMonitor(env: Env): Promise<void> {
  const { pollCertificates } = await import('../scanners/ct-monitor');
  await pollCertificates(env);
}

async function runLookalikeDomainCheck(env: Env): Promise<void> {
  // Phase 3.8 of agent audit: lookalike-scanner now goes through
  // the standard runner. ONE agent_runs row per hourly tick covers
  // all rows scanned by the underlying checkLookalikeBatch loop.
  // Per-row AI calls (Haiku) stay attributed to 'lookalike_scanner'
  // in budget_ledger via the existing analyzeWithHaiku path.
  const { lookalikeScannerAgent } = await import('../agents/lookalike-scanner');
  const { executeAgent } = await import('../lib/agentRunner');
  await executeAgent(env, lookalikeScannerAgent, {}, 'cron', 'scheduled');
}

async function runTrademarkScan(env: Env): Promise<void> {
  // Phase 1 trademark correlation — internal-only (no external calls / AI),
  // so it rides the hourly tick like ct_monitor + lookalike_check. ONE
  // agent_runs row per tick. See scanners/trademark-monitor.ts.
  const { trademarkMonitorAgent } = await import('../agents/trademarkMonitor');
  const { executeAgent } = await import('../lib/agentRunner');
  await executeAgent(env, trademarkMonitorAgent, {}, 'cron', 'scheduled');
}

async function runThreatNarratives(env: Env): Promise<void> {
  const { narratorAgent } = await import('../agents/narrator');
  const { executeAgent } = await import('../lib/agentRunner');

  const result = await executeAgent(env, narratorAgent, {}, 'cron', 'scheduled');

  logger.info('threat_narratives_complete', {
    status: result.status,
    narratives_generated: result.result?.itemsCreated ?? 0,
    brands_checked: (result.result?.output as { brands_checked?: number } | undefined)?.brands_checked ?? 0,
  });
}

// ─── Flight Control Activity Logger ──────────────────────────
async function logFlightControlActivity(
  env: Env,
  eventType: string,
  message: string,
  metadata: Record<string, unknown>,
  severity: 'info' | 'warning' | 'critical'
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
      VALUES (?, 'flight_control', ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      eventType,
      message,
      JSON.stringify(metadata),
      severity
    ).run();
  } catch {
    // Don't let activity logging failures break the cron
  }
}
