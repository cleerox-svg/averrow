/**
 * Feed Runner v2 — Central orchestrator for intelligence feed ingestion.
 *
 * Uses v2 tables: feed_configs, feed_status, feed_pull_history, threats
 *
 * Features:
 * - Schedule-based execution from feed_configs
 * - IOC deduplication via KV cache + DB INSERT OR IGNORE
 * - Per-feed execution logging to feed_pull_history
 * - Feed health status tracking in feed_status
 */

import type { Env } from "../types";
import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "../feeds/types";
import { createNotification } from "./notifications";
import { calculateConfidence, calculateSeverity, reclassifyThreatType } from "./threatScoring";
import { isPrivateIP } from "./geoip";

// ─── Deduplication ───────────────────────────────────────────────

/** Check if an IOC was already seen (KV-based, 24h TTL) */
export async function isDuplicate(env: Env, iocType: string, iocValue: string): Promise<boolean> {
  try {
    const key = `dedup:${iocType}:${iocValue}`;
    return (await env.CACHE.get(key)) !== null;
  } catch {
    return false;
  }
}

/** Mark an IOC as seen */
export async function markSeen(env: Env, iocType: string, iocValue: string): Promise<void> {
  try {
    const key = `dedup:${iocType}:${iocValue}`;
    await env.CACHE.put(key, "1", { expirationTtl: 86400 }); // 24h
  } catch { /* non-fatal */ }
}

// ─── Threat Insertion (v2 schema) ────────────────────────────────

export async function insertThreat(db: D1Database, threat: ThreatRow): Promise<void> {
  // Apply heuristic reclassification (first-pass before AI Analyst)
  const reclassified = reclassifyThreatType(
    threat.threat_type,
    threat.malicious_url ?? null,
    threat.malicious_domain ?? null,
  );
  const threatType = reclassified ?? threat.threat_type;

  // Apply confidence score calibration if not set by the feed
  const confidence = threat.confidence_score ??
    calculateConfidence(threat.source_feed, threatType, !!threat.target_brand_id);

  // Derive severity from confidence if not set by the feed
  const severity = threat.severity ?? calculateSeverity(confidence);

  // Materialize the private-IP classification at insert time so
  // cartographer's Phase 0 selector can index on `is_private_ip = 0`
  // instead of chained NOT LIKE predicates (see migration 0175).
  // Null IP → 0 (the cartographer selector also filters on
  // `ip_address IS NOT NULL`, so the column value is irrelevant
  // for those rows).
  const isPrivateIp = threat.ip_address ? (isPrivateIP(threat.ip_address) ? 1 : 0) : 0;

  await db.prepare(
    `INSERT OR IGNORE INTO threats
       (id, source_feed, threat_type, malicious_url, malicious_domain,
        target_brand_id, hosting_provider_id, ip_address, asn, country_code,
        registrar, status, confidence_score, campaign_id, ioc_value, severity,
        is_private_ip,
        first_seen, last_seen, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             datetime('now'), datetime('now'), datetime('now'))`
  ).bind(
    threat.id,
    threat.source_feed,
    threatType,
    threat.malicious_url,
    threat.malicious_domain,
    threat.target_brand_id ?? null,
    threat.hosting_provider_id ?? null,
    threat.ip_address ?? null,
    threat.asn ?? null,
    threat.country_code ?? null,
    threat.registrar ?? null,
    threat.status ?? "active",
    confidence,
    threat.campaign_id ?? null,
    threat.ioc_value ?? null,
    severity,
    isPrivateIp,
  ).run();
}

// ─── Feed Config Row ─────────────────────────────────────────────

export interface FeedConfigRow {
  feed_name: string;
  display_name: string;
  source_url: string | null;
  schedule_cron: string;
  rate_limit: number;
  batch_size: number;
  retry_count: number;
  enabled: number;
  /** NULL → use the global default from system_config */
  consecutive_failure_threshold?: number | null;
}

interface FeedStatusRow {
  feed_name: string;
  last_successful_pull: string | null;
  health_status: string;
}

// ─── Auto-pause threshold ────────────────────────────────────────

/** Default number of consecutive failures before a feed is auto-paused. */
const DEFAULT_FAILURE_THRESHOLD = 5;

/**
 * Cache for the global default threshold within a single worker
 * invocation so concurrent feed runs inside runAllFeeds don't all
 * re-query system_config. Reset by runAllFeeds at the start of
 * each coordinator pass.
 */
let cachedGlobalThreshold: number | null = null;

export function resetGlobalThresholdCache(): void {
  cachedGlobalThreshold = null;
}

async function getGlobalFailureThreshold(db: D1Database): Promise<number> {
  if (cachedGlobalThreshold != null) return cachedGlobalThreshold;
  try {
    const row = await db.prepare(
      "SELECT value FROM system_config WHERE key = 'feed_consecutive_failure_threshold'"
    ).first<{ value: string }>();
    const parsed = row?.value != null ? parseInt(row.value, 10) : NaN;
    cachedGlobalThreshold = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FAILURE_THRESHOLD;
  } catch {
    cachedGlobalThreshold = DEFAULT_FAILURE_THRESHOLD;
  }
  return cachedGlobalThreshold;
}

/** Public for tests — given a config + global default, resolve the effective threshold. */
export function resolveFailureThreshold(
  config: Pick<FeedConfigRow, "consecutive_failure_threshold">,
  globalDefault: number,
): number {
  const override = config.consecutive_failure_threshold;
  if (override != null && override > 0) return override;
  return globalDefault;
}

// ─── Feed Execution ──────────────────────────────────────────────

export async function runFeed(
  env: Env,
  config: FeedConfigRow,
  feedModule: FeedModule,
): Promise<FeedResult> {
  const pullId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  // Create pull history entry
  await env.DB.prepare(
    `INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES (?, ?, ?, 'partial')`
  ).bind(pullId, config.feed_name, startedAt).run();

  const ctx: FeedContext = {
    env,
    feedName: config.feed_name,
    feedUrl: config.source_url ?? "",
  };

  const start = Date.now();

  try {
    const result = await feedModule.ingest(ctx);
    const durationMs = Date.now() - start;
    // Log success in pull history
    const pullUpdate = await env.DB.prepare(
      `UPDATE feed_pull_history SET
         status = 'success', records_ingested = ?, records_rejected = ?,
         duration_ms = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).bind(result.itemsNew, result.itemsDuplicate + result.itemsError, durationMs, pullId).run();

    // Ensure feed_status row exists (INSERT OR IGNORE), then update
    await env.DB.prepare(
      "INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES (?, 'healthy')"
    ).bind(config.feed_name).run();

    // Update feed_status: only set healthy if records were ingested, clear error.
    // consecutive_failures resets unconditionally on HTTP/parse success — feeds
    // like cisa_kev legitimately return zero most pulls, so we do NOT gate the
    // reset on itemsFetched > 0.
    const statusUpdate = await env.DB.prepare(
      `UPDATE feed_status SET
         last_successful_pull = datetime('now'),
         records_ingested_today = records_ingested_today + ?,
         health_status = CASE WHEN ? > 0 THEN 'healthy' ELSE health_status END,
         last_error = NULL,
         consecutive_failures = 0
       WHERE feed_name = ?`
    ).bind(result.itemsNew, result.itemsFetched, config.feed_name).run();

    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[runFeed] ${config.feed_name}: FAILED after ${durationMs}ms — ${errorMsg}`);
    if (err instanceof Error && err.stack) console.error(`[runFeed] ${config.feed_name}: stack:`, err.stack);

    // Log failure in pull history
    await env.DB.prepare(
      `UPDATE feed_pull_history SET
         status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).bind(errorMsg, durationMs, pullId).run();

    // Check previous status for transition notification + grab the current
    // counter so we can increment locally and avoid an extra round trip.
    const prevStatus = await env.DB.prepare(
      `SELECT health_status, consecutive_failures FROM feed_status WHERE feed_name = ?`
    ).bind(config.feed_name).first<{ health_status: string; consecutive_failures: number | null }>();

    const newFailureCount = (prevStatus?.consecutive_failures ?? 0) + 1;

    // Update feed_status to degraded with error message + incremented counter
    await env.DB.prepare(
      `UPDATE feed_status SET
         last_failure = datetime('now'),
         health_status = 'degraded',
         last_error = ?,
         consecutive_failures = ?
       WHERE feed_name = ?`
    ).bind(errorMsg.slice(0, 500), newFailureCount, config.feed_name).run();

    // Notify only on status CHANGE (healthy → degraded)
    if (prevStatus?.health_status === 'healthy') {
      try {
        await createNotification(env, {
          type: 'feed_health',
          severity: 'high',
          title: `Feed degraded: ${config.display_name}`,
          message: `${config.display_name} returned errors. Check Admin → Feeds.`,
          link: '/admin/feeds',
          metadata: { feed_name: config.feed_name },
        });
      } catch (e) {
        console.error(`[runFeed] notification error:`, e);
      }
    }

    // ── Auto-pause check ──────────────────────────────────────
    // Resolve the effective threshold (per-feed override or global default)
    // and flip enabled=0 + set paused_reason if we've crossed it. The
    // dispatch query in runAllFeeds just stops selecting this feed on the
    // next tick — no other plumbing needed.
    try {
      const globalThreshold = await getGlobalFailureThreshold(env.DB);
      const threshold = resolveFailureThreshold(config, globalThreshold);
      if (newFailureCount >= threshold) {
        await autoPauseFeed(env, config, newFailureCount, threshold, errorMsg);
      }
    } catch (e) {
      console.error(`[runFeed] auto-pause check failed for ${config.feed_name}:`, e);
    }

    // Re-throw so callers (handleTriggerFeed) can distinguish success from failure.
    // runAllFeeds uses Promise.allSettled, so this won't break the coordinator.
    const feedError = new Error(`Feed ${config.feed_name} failed: ${errorMsg}`);
    (feedError as Error & { feedResult: FeedResult }).feedResult = { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    throw feedError;
  }
}

// ─── Auto-recovery helper ────────────────────────────────────────

/**
 * Auto-recover feeds that were paused by `autoPauseFeed` but whose
 * upstream may have since recovered. Fixes the gap where a feed
 * with a transient-5xx fix gets stuck in 'enabled = 0' because the
 * dispatch loop never runs it after pausing — so the failure
 * counter never resets.
 *
 * Selection criteria (all must hold):
 *   - feed_configs.enabled = 0
 *   - feed_configs.paused_reason = 'auto:consecutive_failures'
 *     (ONLY the auto path; manual / operator pauses are untouched)
 *   - feed_status.last_failure IS NULL OR < now - 4 hours
 *
 * Action per matched feed:
 *   - feed_configs: enabled = 1, paused_reason = NULL
 *   - feed_status:  consecutive_failures = 0,
 *                   health_status = 'healthy',
 *                   last_error = NULL
 *
 * No notification fires — operators don't need a "thing recovered"
 * popup; they get one already if the recovered feed promptly
 * re-pauses (autoPauseFeed's existing notification path). The log
 * line below gives forensic trail without notification noise.
 *
 * Returns the count of recovered feeds for the caller's diagnostics.
 */
async function autoRecoverStalePausedFeeds(env: Env): Promise<number> {
  const stale = await env.DB.prepare(`
    SELECT fc.feed_name FROM feed_configs fc
    LEFT JOIN feed_status fs ON fs.feed_name = fc.feed_name
    WHERE fc.enabled = 0
      AND fc.paused_reason = 'auto:consecutive_failures'
      AND (fs.last_failure IS NULL
           OR fs.last_failure < datetime('now', '-4 hours'))
  `).all<{ feed_name: string }>();

  if (stale.results.length === 0) return 0;

  for (const row of stale.results) {
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE feed_configs
             SET enabled = 1,
                 paused_reason = NULL,
                 updated_at = datetime('now')
           WHERE feed_name = ?
             AND paused_reason = 'auto:consecutive_failures'`
        ).bind(row.feed_name),
        env.DB.prepare(
          `UPDATE feed_status
             SET consecutive_failures = 0,
                 health_status = 'healthy',
                 last_error = NULL
           WHERE feed_name = ?`
        ).bind(row.feed_name),
      ]);
      console.log(`[runAllFeeds] auto-recovered ${row.feed_name} (auto-paused, last failure > 4h ago)`);
    } catch (err) {
      console.error(`[runAllFeeds] auto-recovery failed for ${row.feed_name}:`, err);
    }
  }

  return stale.results.length;
}

// ─── Auto-pause helper ───────────────────────────────────────────

/**
 * Flip a feed to enabled=0 with paused_reason='auto:consecutive_failures',
 * fire a critical notification (exactly once per transition — guarded by
 * checking that the feed was still enabled BEFORE this update), and
 * write to agent_activity_log the same way flight_control does for other
 * state transitions.
 *
 * Guarded by a check-then-update sequence: if the feed is already
 * auto-paused (e.g. a concurrent run already flipped it), we skip the
 * notification so the "exactly one critical notification per transition"
 * invariant holds.
 */
async function autoPauseFeed(
  env: Env,
  config: FeedConfigRow,
  failureCount: number,
  threshold: number,
  lastError: string,
): Promise<void> {
  // Read the current enabled state so we only fire the notification on
  // the enabled → paused transition. This also short-circuits if two
  // concurrent failing runs both hit the threshold in the same tick.
  const current = await env.DB.prepare(
    "SELECT enabled, paused_reason FROM feed_configs WHERE feed_name = ?"
  ).bind(config.feed_name).first<{ enabled: number; paused_reason: string | null }>();

  if (!current || current.enabled === 0) {
    // Already paused (manually or by a concurrent auto-pause) — nothing to do.
    return;
  }

  // Auth failures (HTTP 401/403) are not transient — they need operator
  // action (rotate the API key). The 4-hour auto-recovery sweep below
  // matches only `paused_reason = 'auto:consecutive_failures'`, so
  // routing auth errors to a distinct reason `auto:auth_failure`
  // keeps them paused until manually resumed. Symptom this fixes:
  // OTX cycling through pause → recover → fail → pause every 4h
  // because last_failure aged out of the freshness window.
  const isAuthError = /\b(401|403)\b/.test(lastError);
  const pausedReason = isAuthError
    ? 'auto:auth_failure'
    : 'auto:consecutive_failures';

  await env.DB.prepare(
    `UPDATE feed_configs
       SET enabled = 0,
           paused_reason = ?,
           updated_at = datetime('now')
       WHERE feed_name = ? AND enabled = 1`
  ).bind(pausedReason, config.feed_name).run();

  const truncatedError = lastError.slice(0, 500);

  try {
    await createNotification(env, {
      type: 'feed_health',
      severity: 'critical',
      title: isAuthError
        ? `Feed auto-paused (auth failure): ${config.display_name}`
        : `Feed auto-paused: ${config.display_name}`,
      message: isAuthError
        ? `${config.display_name} was paused after ${failureCount} consecutive HTTP 401/403 responses. The API key needs rotation; the feed will stay paused until manually resumed. Last error: ${truncatedError}`
        : `${config.display_name} was paused after ${failureCount} consecutive failures (threshold ${threshold}). Last error: ${truncatedError}`,
      link: '/admin/feeds',
      metadata: {
        feed_name: config.feed_name,
        auto_paused: true,
        paused_reason: pausedReason,
        consecutive_failures: failureCount,
        threshold,
        last_error: truncatedError,
      },
    });
  } catch (e) {
    console.error(`[runFeed] auto-pause notification failed for ${config.feed_name}:`, e);
  }

  // Log to agent_activity_log — same shape as flight_control's state
  // transitions. This is an operational event, not an agent insight,
  // so it intentionally does NOT go to agent_outputs.
  try {
    await env.DB.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
       VALUES (?, 'feed_runner', 'feed_auto_paused', ?, ?, 'critical')`
    ).bind(
      crypto.randomUUID(),
      `Feed ${config.feed_name} auto-paused after ${failureCount} consecutive failures (threshold ${threshold})`,
      JSON.stringify({
        feed_name: config.feed_name,
        display_name: config.display_name,
        consecutive_failures: failureCount,
        threshold,
        last_error: truncatedError,
      }),
    ).run();
  } catch (e) {
    console.error(`[runFeed] activity log failed for ${config.feed_name}:`, e);
  }
}

// ─── Coordinator ─────────────────────────────────────────────────

/** Run all enabled feeds */
export async function runAllFeeds(
  env: Env,
  feedModules: Record<string, FeedModule>,
): Promise<{
  feedsRun: number;
  feedsSkipped: number;
  feedsFailed: number;
  totalNew: number;
}> {
  // Reset the global-threshold cache so a fresh coordinator pass
  // picks up any system_config edit made since the last run.
  resetGlobalThresholdCache();

  // ── Auto-recover stale auto-paused feeds ─────────────────────
  // When a feed's upstream throws 5xx repeatedly (e.g. crt.sh hit
  // five HTTP 502s on 2026-04-27 and tripped ct_logs into
  // auto-pause), the transient-error handler in the feed module
  // prevents future failures from incrementing the counter. But
  // the feed is already paused, so the dispatch loop never runs
  // it, and the counter never resets. Manual unpause is the only
  // path out.
  //
  // This loop closes that gap: any feed auto-paused for
  // 'consecutive_failures' whose last failure is older than 4
  // hours gets re-enabled with a clean counter. If the upstream
  // has recovered, the feed ingests normally on the next
  // dispatch and stays clean. If it's still down, autoPauseFeed
  // re-pauses it on the very next failure — no harm done.
  //
  // Manual pauses (paused_reason starts with anything other than
  // 'auto:') are NEVER touched by this recovery loop.
  await autoRecoverStalePausedFeeds(env);

  // Fetch enabled feed configs
  const configs = await env.DB.prepare(
    "SELECT * FROM feed_configs WHERE enabled = 1"
  ).all<FeedConfigRow>();

  // Fetch feed status for last-run checks
  const statuses = await env.DB.prepare(
    "SELECT * FROM feed_status"
  ).all<FeedStatusRow>();
  const statusMap = new Map(statuses.results.map(s => [s.feed_name, s]));

  let feedsRun = 0;
  let feedsSkipped = 0;
  let feedsFailed = 0;
  let totalNew = 0;

  const now = new Date();

  // Determine which feeds to run based on their cron schedule
  const toRun: Array<{ config: FeedConfigRow; mod: FeedModule }> = [];

  for (const config of configs.results) {
    const mod = feedModules[config.feed_name];
    if (!mod) {
      feedsSkipped++;
      continue;
    }

    const status = statusMap.get(config.feed_name);
    const shouldRun = shouldRunNow(config, status, now);
    if (!shouldRun) {
      feedsSkipped++;

      // Write persistent diagnostic for CF scanner skips
      if (config.feed_name === 'cloudflare_scanner') {
        const intervalMs = parseCronIntervalMs(config.schedule_cron);
        const lastRun = status?.last_successful_pull ? new Date(status.last_successful_pull + 'Z').getTime() : null;
        const elapsed = lastRun ? now.getTime() - lastRun : null;
        try {
          await env.DB.prepare(
            "INSERT INTO agent_outputs (id, agent_id, type, summary, created_at) VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))"
          ).bind(
            'diag_cf_skip_' + Date.now(),
            `CF Scanner SKIPPED by shouldRunNow: last_pull=${status?.last_successful_pull || 'NULL'}, interval=${intervalMs}ms (${intervalMs / 60000}min), elapsed=${elapsed !== null ? elapsed + 'ms (' + Math.round(elapsed / 60000) + 'min)' : 'N/A'}, now=${now.toISOString()}`,
          ).run();
        } catch { /* non-fatal */ }
      }
      continue;
    }

    toRun.push({ config, mod });
  }

  // Run all eligible feeds concurrently
  const results = await Promise.allSettled(
    toRun.map(({ config, mod }) => runFeed(env, config, mod))
  );

  for (const [i, r] of results.entries()) {
    const name = toRun[i]!.config.feed_name;
    feedsRun++;
    if (r.status === "fulfilled") {
      totalNew += r.value.itemsNew;
    } else {
      feedsFailed++;
      console.error(`[feedRunner] ${name}: REJECTED — ${r.reason}`);
    }
  }

  return { feedsRun, feedsSkipped, feedsFailed, totalNew };
}

// ─── Schedule Check ──────────────────────────────────────────────

/**
 * Simple interval-based check derived from cron expression.
 * Parses the minute field of the cron to determine interval.
 */
function shouldRunNow(config: FeedConfigRow, status: FeedStatusRow | undefined, now: Date): boolean {
  if (!status) return true; // No status row = never run before
  if (!status.last_successful_pull) return true; // Never succeeded

  // Parse interval from cron: "*/5 * * * *" → 5 min, "0 * * * *" → 60 min, "0 */12 * * *" → 720 min
  const intervalMs = parseCronIntervalMs(config.schedule_cron);
  // Append 'Z' if missing — SQLite datetime('now') omits timezone, JS would parse as local
  const lastPull = status.last_successful_pull;
  const lastRun = new Date(lastPull.includes('Z') || lastPull.includes('+') ? lastPull : lastPull + 'Z').getTime();

  // 60s tolerance: cron triggers may fire slightly before the exact interval boundary
  return now.getTime() - lastRun >= intervalMs - 60_000;
}

export function parseCronIntervalMs(cron: string): number {
  const parts = cron.split(/\s+/);
  if (parts.length < 5) return 5 * 60 * 1000; // default 5 min

  const minute = parts[0] ?? "*";
  const hour = parts[1] ?? "*";

  // "*/N * * * *" — every N minutes
  if (minute.startsWith("*/")) {
    return parseInt(minute.slice(2), 10) * 60 * 1000;
  }

  // "0 */N * * *" — every N hours
  if (minute === "0" && hour.startsWith("*/")) {
    return parseInt(hour.slice(2), 10) * 60 * 60 * 1000;
  }

  // "0 * * * *" — hourly
  if (minute === "0" && hour === "*") {
    return 60 * 60 * 1000;
  }

  // "0 0 * * *" — daily (specific hour, no wildcard)
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return 24 * 60 * 60 * 1000;
  }

  // Default: 5 minutes
  return 5 * 60 * 1000;
}

// ─── Run Enrichment Feeds (after ingest) ────────────────────────

/**
 * Run enrichment feeds — these enrich existing threats rather than ingesting new ones.
 * Called AFTER runAllFeeds so enrichment operates on freshly ingested data.
 *
 * Single-path approach: iterate the module map, check feed_configs for enabled
 * status (fallback: run all), check schedule, run each in its own try/catch.
 */
export async function runAllEnrichmentFeeds(
  env: Env,
  enrichmentModules: Record<string, FeedModule>,
): Promise<{
  feedsRun: number;
  feedsSkipped: number;
  feedsFailed: number;
  totalEnriched: number;
}> {
  let feedsRun = 0;
  let feedsSkipped = 0;
  let feedsFailed = 0;
  let totalEnriched = 0;

  try {
    // Build a map of DB configs keyed by feed_name (empty if query fails)
    const configMap = new Map<string, FeedConfigRow>();
    try {
      const configs = await env.DB.prepare(
        "SELECT * FROM feed_configs WHERE feed_type = 'enrichment'"
      ).all<FeedConfigRow>();
      for (const c of configs.results) configMap.set(c.feed_name, c);
      console.log(`[enrichment] feed_configs: ${configs.results.length} enrichment rows (${configs.results.map(c => `${c.feed_name}:${c.enabled ? 'on' : 'off'}`).join(', ')})`);
    } catch {
      // feed_type column may not exist — run all modules
      console.warn('[enrichment] feed_configs query failed — will run all registered modules');
    }

    // Load feed_status for schedule checks
    let statusMap = new Map<string, FeedStatusRow>();
    try {
      const statuses = await env.DB.prepare("SELECT * FROM feed_status").all<FeedStatusRow>();
      statusMap = new Map(statuses.results.map(s => [s.feed_name, s]));
    } catch {
      console.warn('[enrichment] feed_status query failed — will run all modules unconditionally');
    }

    const now = new Date();
    const moduleNames = Object.keys(enrichmentModules);
    console.log(`[enrichment] Registered modules: ${moduleNames.join(', ')}`);

    // Iterate every registered enrichment module
    for (const [name, mod] of Object.entries(enrichmentModules)) {
      // Check enabled status: if we have config data and feed is disabled, skip
      const dbConfig = configMap.get(name);
      if (dbConfig && !dbConfig.enabled) {
        console.log(`[enrichment] ${name}: disabled in feed_configs — skipping`);
        feedsSkipped++;
        continue;
      }

      // Build config: use DB config if available, otherwise synthetic
      const config: FeedConfigRow = dbConfig ?? {
        feed_name: name,
        display_name: name,
        source_url: null,
        schedule_cron: '*/30 * * * *',
        rate_limit: 0,
        batch_size: 0,
        retry_count: 0,
        enabled: 1,
      };

      // Check schedule timing
      const status = statusMap.get(name);
      if (status && !shouldRunNow(config, status, now)) {
        console.log(`[enrichment] ${name}: not due yet (last_pull=${status.last_successful_pull ?? 'never'}) — skipping`);
        feedsSkipped++;
        continue;
      }

      // Run the feed — isolated try/catch so one failure cannot kill others
      feedsRun++;
      try {
        console.log(`[enrichment] Running: ${name}`);
        const result = await runFeed(env, config, mod);
        totalEnriched += result.itemsNew;
        console.log(`[enrichment] ${name}: fetched=${result.itemsFetched} enriched=${result.itemsNew} errors=${result.itemsError}`);
      } catch (err) {
        feedsFailed++;
        console.error(`[enrichment] ${name} FAILED:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (outerErr) {
    // Outer catch ensures the function NEVER throws
    console.error('[enrichment] FATAL outer error:', outerErr instanceof Error ? outerErr.message : String(outerErr));
  }

  console.log(`[enrichment] Done: ${feedsRun} ran, ${feedsFailed} failed, ${feedsSkipped} skipped, ${totalEnriched} enriched`);
  return { feedsRun, feedsSkipped, feedsFailed, totalEnriched };
}

// ─── Run Social Feeds (after enrichment) ────────────────────────

/**
 * Run social feeds — these monitor social platforms for brand mentions.
 * They insert into social_mentions table (not threats directly).
 * Watchdog agent handles classification and escalation.
 *
 * Single-path approach: iterate the module map, check feed_configs for enabled
 * status (fallback: run all), check schedule, run each in its own try/catch.
 */
export async function runAllSocialFeeds(
  env: Env,
  socialModules: Record<string, FeedModule>,
): Promise<{
  feedsRun: number;
  feedsSkipped: number;
  feedsFailed: number;
  totalNew: number;
}> {
  let feedsRun = 0;
  let feedsSkipped = 0;
  let feedsFailed = 0;
  let totalNew = 0;

  try {
    // Build a map of DB configs keyed by feed_name (empty if query fails)
    const configMap = new Map<string, FeedConfigRow>();
    try {
      const configs = await env.DB.prepare(
        "SELECT * FROM feed_configs WHERE feed_type = 'social'"
      ).all<FeedConfigRow>();
      for (const c of configs.results) configMap.set(c.feed_name, c);
      console.log(`[social] feed_configs: ${configs.results.length} social rows (${configs.results.map(c => `${c.feed_name}:${c.enabled ? 'on' : 'off'}`).join(', ')})`);
    } catch {
      // feed_type column may not exist — run all modules
      console.warn('[social] feed_configs query failed — will run all registered modules');
    }

    // Load feed_status for schedule checks
    let statusMap = new Map<string, FeedStatusRow>();
    try {
      const statuses = await env.DB.prepare("SELECT * FROM feed_status").all<FeedStatusRow>();
      statusMap = new Map(statuses.results.map(s => [s.feed_name, s]));
    } catch {
      console.warn('[social] feed_status query failed — will run all modules unconditionally');
    }

    const now = new Date();
    const moduleNames = Object.keys(socialModules);
    console.log(`[social] Registered modules: ${moduleNames.join(', ')}`);

    // Iterate every registered social module
    for (const [name, mod] of Object.entries(socialModules)) {
      // Check enabled status: if we have config data and feed is disabled, skip
      const dbConfig = configMap.get(name);
      if (dbConfig && !dbConfig.enabled) {
        console.log(`[social] ${name}: disabled in feed_configs — skipping`);
        feedsSkipped++;
        continue;
      }

      // Build config: use DB config if available, otherwise synthetic
      const config: FeedConfigRow = dbConfig ?? {
        feed_name: name,
        display_name: name,
        source_url: null,
        schedule_cron: '0 */2 * * *',
        rate_limit: 0,
        batch_size: 0,
        retry_count: 0,
        enabled: 1,
      };

      // Check schedule timing
      const status = statusMap.get(name);
      if (status && !shouldRunNow(config, status, now)) {
        console.log(`[social] ${name}: not due yet (last_pull=${status.last_successful_pull ?? 'never'}) — skipping`);
        feedsSkipped++;
        continue;
      }

      // Run the feed — isolated try/catch so one failure cannot kill others
      feedsRun++;
      try {
        console.log(`[social] Running: ${name}`);
        const result = await runFeed(env, config, mod);
        totalNew += result.itemsNew;
        console.log(`[social] ${name}: fetched=${result.itemsFetched} new=${result.itemsNew} errors=${result.itemsError}`);
      } catch (err) {
        feedsFailed++;
        console.error(`[social] ${name} FAILED:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (outerErr) {
    // Outer catch ensures the function NEVER throws
    console.error('[social] FATAL outer error:', outerErr instanceof Error ? outerErr.message : String(outerErr));
  }

  console.log(`[social] Done: ${feedsRun} ran, ${feedsFailed} failed, ${feedsSkipped} skipped, ${totalNew} new`);
  return { feedsRun, feedsSkipped, feedsFailed, totalNew };
}

// ─── Reset daily counters (called at start of day) ───────────────

export async function resetDailyCounters(db: D1Database): Promise<void> {
  await db.prepare("UPDATE feed_status SET records_ingested_today = 0").run();
}
