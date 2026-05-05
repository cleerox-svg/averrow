import { logger } from '../lib/logger';
import { feedModules, enrichmentModules, socialModules } from '../feeds/index';
import { createAlert } from '../lib/alerts';
import { cubeHealerAgent } from '../agents/cube-healer';
import { emitPlatformNotification, renderPlatformFeedSilent } from '../lib/platform-templates';
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
      await executeAgent(env, cubeHealerAgent, {}, 'cron', 'scheduled');
    } catch (err) {
      logger.error('cube_healer_dispatch_error', {
        error: err instanceof Error ? err.message : String(err),
      });
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
  const results: CronJobResult[] = [];

  // Threat feed scan + full agent mesh — runs every hourly tick.
  {
    const result = await runJob('threat_feed_scan', () => runThreatFeedScan(env, ctx, now));
    results.push(result);
  }

  // Enricher runs every cron tick — owns domain_geo, brand_logo_hq,
  // brand_sector_rdap. Decoupled from feed ingest so its failures
  // don't poison feeds and vice versa.
  //
  // Phase 2.5 of agent audit: enricher is now a standard AgentModule
  // dispatched through executeAgent — agent_runs row, FC supervision,
  // circuit breaker all uniform with every other agent. The legacy
  // agent_activity_log per-job rows are replaced by agent_outputs
  // entries (severity='high' on failure, 'info' on non-zero progress).
  try {
    const { enricherAgent } = await import('./enricher');
    const { executeAgent } = await import('../lib/agentRunner');
    await executeAgent(env, enricherAgent, {}, 'cron', 'scheduled');
  } catch (err) {
    logger.error('enricher_dispatch_error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Every 6 hours (hours 0/6/12/18): Social discovery + monitoring
  if (hour % 6 === 0) {
    // Discovery first — so newly found handles get monitored in the same cycle
    const discoveryResult = await runJob('social_discovery', () => runSocialDiscovery(env));
    results.push(discoveryResult);

    const result = await runJob('social_monitor', () => runSocialMonitor(env));
    results.push(result);

    // App-store impersonation monitor — iOS only for now (iTunes Search API).
    // Runs after social so the two share the same per-brand rhythm. Capped at
    // 20 brands/tick inside the scanner, iTunes is cached at the CF edge, so
    // awaiting inline is safe.
    const appStoreResult = await runJob('app_store_monitor', () => runAppStoreMonitor(env));
    results.push(appStoreResult);

    // Dark-web mention monitor — pastebin archives (PSBDMP) only for now.
    // Capped at 15 brands/tick inside the scanner; paste bodies are fetched
    // sequentially so the walk is bounded. Future Telegram / HIBP / Flare
    // sources add their own brand_monitor_schedule platform rows without
    // touching this call site.
    const darkWebResult = await runJob('dark_web_monitor', () => runDarkWebMonitor(env));
    results.push(darkWebResult);

    // Run Sentinel AI assessment in the background — it doesn't need to block the
    // cron mesh, and moving it to waitUntil frees up the hourly CPU ceiling for
    // other jobs (CT monitor, lookalike check, etc.).
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

  // Daily at 13:00 UTC (9 AM ET): Generate + email daily briefing
  // NOTE: hour 13 avoids collision with social ops (hour % 6 === 0 runs at 0/6/12/18)
  if (hour === 13) {
    console.log('[CRON] 13:00 UTC — starting daily briefing generation');
    const emailResult = await runJob('briefing_email', async () => {
      // Dedup: only skip if a cron briefing already exists for today (manual ones don't count)
      const today = now.toISOString().slice(0, 10);
      let existing: { count: number } | null = null;
      try {
        existing = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM threat_briefings
           WHERE report_date = ? AND trigger LIKE 'cron%' AND emailed = 1`
        ).bind(today).first<{ count: number }>();
      } catch (err) {
        console.error('[CRON] Briefing dedup check failed:', err instanceof Error ? err.message : String(err));
      }

      if (existing && existing.count > 0) {
        logger.info('briefing_email_skipped_duplicate', { date: today });
        console.log('[CRON] Briefing already generated for today, skipping');
        return;
      }

      console.log('[CRON] No existing cron briefing for today, generating...');
      const { generateAndEmailBriefing } = await import('../handlers/briefing');
      const result = await generateAndEmailBriefing(env);
      if (!result.emailSent) {
        logger.warn('briefing_email_not_sent', { briefingId: result.briefingId, error: result.error });
        console.error('[CRON] Briefing email not sent:', result.error);
      } else {
        logger.info('briefing_email_delivered', { briefingId: result.briefingId });
        console.log('[CRON] Briefing generated and emailed, id:', result.briefingId);
      }
    });
    results.push(emailResult);

    // B4 — notification_narrator: per-user daily digest envelopes.
    // Runs at the same hour as the legacy briefing email; the
    // digest envelope is additive in the bell, doesn't compete
    // with the email path.
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
        const mod = agentModules[event.target_agent];

        if (mod) {
          ctx.waitUntil(
            executeAgent(env, mod, { ...payload, triggeredByEvent: event.event_type }, "cron", "event")
          );
        } else {
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

      // Look up the brand owner (user_id) for the alert
      const brandOwner = await env.DB.prepare(
        `SELECT user_id FROM brand_profiles WHERE brand_id = ? LIMIT 1`
      ).bind(change.brand_id).first<{ user_id: string }>();

      const userId = brandOwner?.user_id ?? 'system';

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

    // Write feed_pulled event for traceability
    try {
      await env.DB.prepare(`
        INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
        VALUES (?, 'feed_pulled', 'sentinel', 'cartographer', ?, 2, 'pending')
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

  // Strategist — every 6 hours (0, 6, 12, 18).
  // Inline await so missed runs are visible in agent_runs. Was previously
  // ctx.waitUntil() which silently dropped runs when the orchestrator
  // invocation was killed before waitUntil resolved (observed 2026-04-27:
  // 18:07 cron tick fired but strategist's run never appeared, even though
  // adjacent agents like social_monitor did). Strategist's avg duration
  // is 264ms — negligible against the cron's 15-min CPU ceiling.
  if (hour % 6 === 0) {
    try {
      const mod = allAgents["strategist"];
      if (mod) {
        await executeAgent(env, mod, {}, "cron", "scheduled");
      }
    } catch (err) {
      logger.error('threat_feed_scan_strategist_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // NEXUS — every 4 hours (0, 4, 8, 12, 16, 20).
  // Dispatched via the agent module (writes to agent_runs) rather than
  // the Workflow path. The Workflow-based dispatch stopped firing around
  // Apr 19 (1 start in 7 days vs expected ~42); the agent module runs
  // the same core logic (runNexus) and takes ~60s which fits comfortably
  // under the cron CPU ceiling.
  //
  // Inline await for the same reason as sparrow / strategist (PR #832) —
  // ctx.waitUntil silently drops runs when the orchestrator invocation
  // is killed first.
  if (hour % 4 === 0) {
    try {
      const mod = allAgents["nexus"];
      if (mod) {
        await executeAgent(env, mod, {}, "cron", "scheduled");
      }
    } catch (err) {
      logger.error('nexus_dispatch_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

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

  // Sparrow (takedown agent) — every 6 hours (0, 6, 12, 18).
  // Inline await for the same reason as strategist above — ctx.waitUntil
  // silently dropped runs when the orchestrator invocation was killed
  // before waitUntil resolved. Sparrow's avg duration is ~30s, well
  // under the 15-min cron CPU ceiling. Same shape as the analyst dispatch
  // pattern (which is the next conversion candidate).
  if (hour % 6 === 0) {
    try {
      const mod = allAgents["sparrow"];
      if (mod) {
        await executeAgent(env, mod, {}, "cron", "scheduled");
      }
    } catch (err) {
      logger.error('cron_sparrow_error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

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
  // Daily Tranco import + brand matching (runs at 06:00 UTC)
  try {
    const { handleImportTranco, runBrandMatchBackfill } = await import('../handlers/admin');
    const fakeReq = new Request('https://localhost/api/admin/import-tranco', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10000 }),
    });
    const trancoRes = await handleImportTranco(fakeReq, env);
    const trancoData = await trancoRes.json() as { success: boolean; data?: { imported: number; message: string } };
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
