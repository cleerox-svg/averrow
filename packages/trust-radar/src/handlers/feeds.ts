// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import { runAllFeeds, runFeed } from "../lib/feedRunner";
import type { FeedConfigRow } from "../lib/feedRunner";
import { feedModules } from "../feeds";
import type { Env, UpdateFeedBody } from "../types";

/** Mask a credential for safe display: show last 4 chars only */
function maskSecret(val: string | null): string | null {
  if (!val) return null;
  if (val.length <= 4) return "****";
  return "****" + val.slice(-4);
}

// ─── List all feed configs ──────────────────────────────────────
export async function handleListFeeds(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const configs = await env.DB.prepare(
      `SELECT c.*, s.last_successful_pull, s.last_failure, s.records_ingested_today, s.health_status
       FROM feed_configs c
       LEFT JOIN feed_status s ON c.feed_name = s.feed_name
       ORDER BY c.feed_name ASC
       LIMIT 100`
    ).all();

    // Enrich with last pull count and avg duration from feed_pull_history
    const lastPulls = await env.DB.prepare(
      `SELECT feed_name, records_ingested AS last_pull_count, duration_ms
       FROM feed_pull_history
       WHERE id IN (SELECT id FROM feed_pull_history GROUP BY feed_name HAVING started_at = MAX(started_at))`
    ).all<{ feed_name: string; last_pull_count: number; duration_ms: number | null }>();

    const avgDurations = await env.DB.prepare(
      `SELECT feed_name, AVG(duration_ms) AS avg_duration_ms
       FROM feed_pull_history
       WHERE started_at >= datetime('now', '-1 day') AND duration_ms IS NOT NULL
       GROUP BY feed_name`
    ).all<{ feed_name: string; avg_duration_ms: number }>();

    const lastPullMap = new Map(lastPulls.results.map(r => [r.feed_name, r]));
    const avgDurMap = new Map(avgDurations.results.map(r => [r.feed_name, r.avg_duration_ms]));

    const masked = configs.results.map((r: Record<string, unknown>) => ({
      ...r,
      api_key_encrypted: maskSecret(r.api_key_encrypted as string | null),
      last_pull_count: lastPullMap.get(r.feed_name as string)?.last_pull_count ?? null,
      avg_duration_ms: avgDurMap.get(r.feed_name as string) ?? null,
    }));
    return json({ success: true, data: masked }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Get single feed detail ─────────────────────────────────────
export async function handleGetFeed(request: Request, env: Env, feedName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const feed = await env.DB.prepare(
      `SELECT c.*, s.last_successful_pull, s.last_failure, s.records_ingested_today, s.health_status
       FROM feed_configs c
       LEFT JOIN feed_status s ON c.feed_name = s.feed_name
       WHERE c.feed_name = ?`
    ).bind(feedName).first();

    if (!feed) return json({ success: false, error: "Feed not found" }, 404, origin);

    // Recent pull history
    const pulls = await env.DB.prepare(
      `SELECT id, status, records_ingested, records_rejected, error_message, duration_ms, started_at, completed_at
       FROM feed_pull_history WHERE feed_name = ? ORDER BY started_at DESC LIMIT 20`
    ).bind(feedName).all();

    const result: Record<string, unknown> = { ...feed as Record<string, unknown> };
    result.api_key_encrypted = maskSecret(result.api_key_encrypted as string | null);

    return json({ success: true, data: { feed: result, pulls: pulls.results } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Update feed config ─────────────────────────────────────────
export async function handleUpdateFeed(request: Request, env: Env, feedName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as UpdateFeedBody;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.enabled != null) {
      updates.push("enabled = ?");
      values.push(body.enabled ? 1 : 0);
      // Mirror the new pause metadata so manual vs auto-pause stays
      // distinguishable from now on. Disabling via this endpoint is
      // by definition a human action → 'manual'. Re-enabling clears
      // the marker.
      if (body.enabled) {
        updates.push("paused_reason = NULL");
      } else {
        updates.push("paused_reason = 'manual'");
      }
    }
    if (body.display_name) {
      updates.push("display_name = ?");
      values.push(body.display_name);
    }
    if (body.description != null) {
      updates.push("description = ?");
      values.push(body.description);
    }
    if (body.source_url) {
      updates.push("source_url = ?");
      values.push(body.source_url);
    }
    if (body.schedule_cron) {
      updates.push("schedule_cron = ?");
      values.push(body.schedule_cron);
    }
    if (body.rate_limit != null) {
      updates.push("rate_limit = ?");
      values.push(body.rate_limit);
    }
    if (body.batch_size != null) {
      updates.push("batch_size = ?");
      values.push(body.batch_size);
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No valid fields to update" }, 400, origin);
    }

    updates.push("updated_at = datetime('now')");
    values.push(feedName);

    await env.DB.prepare(
      `UPDATE feed_configs SET ${updates.join(", ")} WHERE feed_name = ?`
    ).bind(...values).run();

    const updated = await env.DB.prepare("SELECT * FROM feed_configs WHERE feed_name = ?").bind(feedName).first();
    return json({ success: true, data: updated }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Manually trigger a single feed ─────────────────────────────
export async function handleTriggerFeed(request: Request, env: Env, feedName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const mod = feedModules[feedName];
    if (!mod) {
      return json({ success: false, error: "Feed module not implemented" }, 501, origin);
    }

    const config = await env.DB.prepare("SELECT * FROM feed_configs WHERE feed_name = ?").bind(feedName).first<FeedConfigRow>();
    if (!config) return json({ success: false, error: "Feed not found" }, 404, origin);

    // Use runFeed() so feed_status and feed_pull_history are properly updated
    const result = await runFeed(env, config, mod);

    // Bust the feeds_overview cache so the UI sees the new pull
    // immediately (was stale up to 5 min after PR #1178 added KV).
    try {
      await env.CACHE.delete('feeds_overview:v1');
      await env.CACHE.delete('feeds_aggregate_stats:v1');
    } catch { /* ignore */ }

    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    console.error(`[triggerFeed] "${feedName}" threw:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Trigger all feeds (full ingest cycle) ──────────────────────
export async function handleTriggerAll(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const result = await runAllFeeds(env, feedModules);
    try {
      await env.CACHE.delete('feeds_overview:v1');
      await env.CACHE.delete('feeds_aggregate_stats:v1');
    } catch { /* ignore */ }
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Trigger feeds by tier (stub — tiers removed in v2) ─────────
export async function handleTriggerTier(request: Request, env: Env, _tier: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  return json({ success: false, error: "Tier-based triggering not available in v2. Use /api/feeds/trigger-all." }, 410, origin);
}

// ─── Feed stats ─────────────────────────────────────────────────
export async function handleFeedStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // KV cache: feed stats rarely change — cache for 5 minutes
    const cacheKey = "feed_configs_status";
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    const totals = await env.DB.prepare(`
      SELECT
        COUNT(*) as total_feeds,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_feeds
      FROM feed_configs
    `).first();

    const statusSummary = await env.DB.prepare(`
      SELECT health_status, COUNT(*) as count
      FROM feed_status GROUP BY health_status
    `).all();

    const recentPulls = await env.DB.prepare(`
      SELECT feed_name, status, records_ingested, duration_ms, started_at
      FROM feed_pull_history ORDER BY started_at DESC LIMIT 50
    `).all();

    const data = {
      success: true,
      data: {
        summary: totals,
        statusBreakdown: statusSummary.results,
        recentPulls: recentPulls.results,
      },
    };

    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    return json(data, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Pull history (replaces ingestion jobs) ─────────────────────
export async function handleIngestionJobs(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(500, parseInt(url.searchParams.get("limit") ?? "20", 10));
    const rows = await env.DB.prepare(
      "SELECT * FROM feed_pull_history ORDER BY started_at DESC LIMIT ?"
    ).bind(limit).all();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Reset feed health (replaces circuit breaker reset) ─────────
export async function handleResetCircuit(request: Request, env: Env, feedName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    await env.DB.prepare(
      `UPDATE feed_status SET health_status = 'healthy', last_failure = NULL WHERE feed_name = ?`
    ).bind(feedName).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Feed quota (stub — quota tracking deferred to Phase 2) ─────
export async function handleFeedQuota(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  return json({ success: true, data: [] }, 200, origin);
}

// ─── Feeds overview with aggregated pull stats ─────────────────
//
// KV cache: 2 parallel queries — cache for 5 minutes. v1 prefix
// is the first cached version of this handler; bump if the
// response shape changes. Rides the same Navigator pre-warm
// pattern as /api/agents (see CLAUDE.md §8).
export async function handleFeedsOverview(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const cacheKey = 'feeds_overview:v1';
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    // Bug fix: status='error' never matched the CHECK constraint
    // (schema only allows 'success'/'partial'/'failed'), so the
    // `errors` field in the response has been 0 forever. Switched
    // to status='failed' to count actual failed pulls.
    const [rowsResult, hourlyResult] = await Promise.all([
      env.DB.prepare(`
        SELECT
          fc.feed_name,
          fc.display_name,
          fc.description,
          fc.source_url,
          fc.enabled,
          fc.schedule_cron,
          fc.batch_size,
          fc.rate_limit,
          fc.filters,
          fc.retry_count,
          fc.retry_delay_seconds,
          fc.paused_reason,
          fc.consecutive_failure_threshold,
          fs.consecutive_failures,
          fs.last_error,
          COUNT(fph.id) as total_pulls,
          COALESCE(SUM(fph.records_ingested), 0) as total_ingested,
          COALESCE(SUM(fph.records_rejected), 0) as total_rejected,
          SUM(CASE WHEN fph.status='success' THEN 1 ELSE 0 END) as successes,
          SUM(CASE WHEN fph.status='failed'  THEN 1 ELSE 0 END) as errors,
          MAX(fph.started_at) as last_run,
          MAX(fph.completed_at) as last_completed
        FROM feed_configs fc
        LEFT JOIN feed_status fs ON fs.feed_name = fc.feed_name
        LEFT JOIN feed_pull_history fph ON fph.feed_name = fc.feed_name
        GROUP BY fc.feed_name
        ORDER BY total_ingested DESC
      `).all(),

      // Hourly buckets for the per-card sparkline. 24h window keeps
      // the index range scan cheap (idx_feed_pulls_feed). One row
      // per (feed_name, hour) bucket; frontend rebuilds 24-element
      // arrays from these.
      env.DB.prepare(`
        SELECT
          feed_name,
          CAST(strftime('%H', started_at) AS INTEGER) AS hour,
          COUNT(*) AS pulls,
          COALESCE(SUM(records_ingested), 0) AS ingested,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS errors
        FROM feed_pull_history
        WHERE started_at >= datetime('now', '-1 day')
        GROUP BY feed_name, hour
      `).all<{ feed_name: string; hour: number; pulls: number; ingested: number; errors: number }>(),
    ]);

    // Build per-feed 24-element arrays, indexed so position 0 is
    // 24h ago and position 23 is the current hour. Same convention
    // /api/agents uses for activity[].
    const currentHour = new Date().getUTCHours();
    const pullsMap    = new Map<string, number[]>();
    const ingestedMap = new Map<string, number[]>();
    const errorsMap   = new Map<string, number[]>();
    for (const row of hourlyResult.results) {
      if (!pullsMap.has(row.feed_name))    pullsMap.set(row.feed_name,    new Array(24).fill(0));
      if (!ingestedMap.has(row.feed_name)) ingestedMap.set(row.feed_name, new Array(24).fill(0));
      if (!errorsMap.has(row.feed_name))   errorsMap.set(row.feed_name,   new Array(24).fill(0));
      const idx = (row.hour - currentHour + 24) % 24;
      pullsMap.get(row.feed_name)![idx]    = row.pulls    ?? 0;
      ingestedMap.get(row.feed_name)![idx] = row.ingested ?? 0;
      errorsMap.get(row.feed_name)![idx]   = row.errors   ?? 0;
    }

    const data = (rowsResult.results as Record<string, unknown>[]).map(r => ({
      ...r,
      pulls_per_hour:    pullsMap.get(r.feed_name as string)    ?? new Array(24).fill(0),
      ingested_per_hour: ingestedMap.get(r.feed_name as string) ?? new Array(24).fill(0),
      errors_per_hour:   errorsMap.get(r.feed_name as string)   ?? new Array(24).fill(0),
    }));

    const responseData = { success: true, data };
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 300 });
    return json(responseData, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Unpause a feed (manual or auto-paused) ─────────────────────
//
// Single server-side call that clears all three fields in one
// logical transaction:
//   1. feed_configs: enabled = 1, paused_reason = NULL
//   2. feed_status:  consecutive_failures = 0,
//                    health_status = 'healthy',
//                    last_error = NULL
//
// D1 doesn't expose multi-statement transactions to Workers, but
// env.DB.batch([...]) runs the statements atomically from the
// caller's point of view. If any statement fails the whole batch
// is rejected.
export async function handleUnpauseFeed(request: Request, env: Env, feedName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Sanity check: feed must exist
    const existing = await env.DB.prepare(
      "SELECT feed_name FROM feed_configs WHERE feed_name = ?"
    ).bind(feedName).first();
    if (!existing) return json({ success: false, error: "Feed not found" }, 404, origin);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE feed_configs
           SET enabled = 1,
               paused_reason = NULL,
               updated_at = datetime('now')
           WHERE feed_name = ?`
      ).bind(feedName),
      env.DB.prepare(
        `UPDATE feed_status
           SET consecutive_failures = 0,
               health_status = 'healthy',
               last_error = NULL
           WHERE feed_name = ?`
      ).bind(feedName),
    ]);

    try {
      await env.CACHE.delete('feeds_overview:v1');
      await env.CACHE.delete('feeds_aggregate_stats:v1');
    } catch { /* ignore */ }

    return json({ success: true, data: { feed_name: feedName } }, 200, origin);
  } catch (err) {
    console.error(`[unpauseFeed] "${feedName}" threw:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Manually pause a feed ──────────────────────────────────────
//
// Counterpart to handleUnpauseFeed. Sets enabled=0 +
// paused_reason='manual'. Does NOT touch feed_status — preserves
// the failure history so an operator's manual pause doesn't
// pretend the feed was healthy.
//
// The feed runner skips disabled feeds, so this is the kill-switch
// for noisy or known-broken sources without retiring the config row.
export async function handlePauseFeed(request: Request, env: Env, feedName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const existing = await env.DB.prepare(
      "SELECT feed_name FROM feed_configs WHERE feed_name = ?"
    ).bind(feedName).first();
    if (!existing) return json({ success: false, error: "Feed not found" }, 404, origin);

    await env.DB.prepare(
      `UPDATE feed_configs
         SET enabled = 0,
             paused_reason = 'manual',
             updated_at = datetime('now')
         WHERE feed_name = ?`
    ).bind(feedName).run();

    // Bust the feeds_overview cache so the UI reflects the new state
    // without a stale-cache window.
    try {
      await env.CACHE.delete('feeds_overview:v1');
      await env.CACHE.delete('feeds_aggregate_stats:v1');
    } catch { /* ignore */ }

    return json({ success: true, data: { feed_name: feedName } }, 200, origin);
  } catch (err) {
    console.error(`[pauseFeed] "${feedName}" threw:`, err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Feed pull history for a specific feed ────────────────────
export async function handleFeedPullHistory(request: Request, env: Env, feedName: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10));

    const rows = await env.DB.prepare(`
      SELECT id, feed_name, started_at, completed_at, duration_ms,
             records_ingested, records_rejected, status, error_message
      FROM feed_pull_history
      WHERE feed_name = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).bind(feedName, limit).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Aggregated feed stats ────────────────────────────────────
//
// KV cache: single query — cache for 15 minutes. v1 prefix is the
// first cached version; bump if the response shape changes. Warmed by
// Navigator Phase B every 15 min (see cron/navigator.ts); the 900s TTL
// outlives that cadence so real page loads hit warm cache (a 300s TTL
// would leave the cache cold for ~2/3 of each warm cycle). Busted
// alongside feeds_overview:v1 on every feed mutation below.
export async function handleFeedsAggregateStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const cacheKey = 'feeds_aggregate_stats:v1';
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    // total_ingested reads the pre-aggregated per-feed counter
    // feed_status.records_ingested_today (~44 rows) instead of an
    // unbounded SUM over feed_pull_history (44.6K rows and growing
    // forever — EXPLAIN was a full SCAN feed_pull_history). Bounded by
    // feed count, not history depth; EXPLAIN no longer touches
    // feed_pull_history.
    const stats = await env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN enabled=1 THEN 1 END) as active,
        COUNT(CASE WHEN enabled=0 THEN 1 END) as disabled,
        COALESCE((
          SELECT SUM(records_ingested_today) FROM feed_status
        ), 0) as total_ingested
      FROM feed_configs
    `).first();

    const responseData = { success: true, data: stats };
    await env.CACHE.put(cacheKey, JSON.stringify(responseData), { expirationTtl: 900 });
    return json(responseData, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
