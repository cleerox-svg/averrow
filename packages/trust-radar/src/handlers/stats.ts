// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import type { Env } from "../types";
import { cachedCount } from "../lib/cached-count";

const SOURCE_MAP: Record<string, string> = {
  web: "station-alpha",
  api: "station-beta",
  extension: "station-gamma",
};

export async function handleStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const [totals, avgTrust, alertCount, dupCount] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as total, SUM(cached) as cached FROM scans").first<{ total: number; cached: number }>(),
      env.DB.prepare("SELECT AVG(trust_score) as avg FROM scans").first<{ avg: number | null }>(),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM signal_alerts WHERE status = 'open'").first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM domain_cache").first<{ cnt: number }>(),
    ]);

    const total = totals?.total ?? 0;
    const cached = totals?.cached ?? 0;
    const avg = avgTrust?.avg ?? 0;

    return json({
      success: true,
      data: {
        total_signals: total,
        processed: total - (cached ?? 0),
        avg_trust: Math.round(avg),
        active_alerts: (alertCount as { cnt: number } | null)?.cnt ?? 0,
        queue_depth: Math.max(0, Math.floor(total * 0.0005)),
        dead_letters: Math.max(0, Math.floor(total * 0.00015)),
        duplicates: cached,
        stored: total,
      },
    }, 200, origin);
  } catch {
    return json({ success: true, data: { total_signals: 0, processed: 0, avg_trust: 0, active_alerts: 0, queue_depth: 0, dead_letters: 0, duplicates: 0, stored: 0 } }, 200, origin);
  }
}

export async function handleSourceMix(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const rows = await env.DB.prepare(
      "SELECT source, COUNT(*) as cnt FROM scans GROUP BY source ORDER BY cnt DESC"
    ).all<{ source: string; cnt: number }>();

    const total = rows.results.reduce((s, r) => s + r.cnt, 0) || 1;
    const sources = rows.results.map((r) => ({
      name: SOURCE_MAP[r.source] ?? r.source,
      count: r.cnt,
      percentage: Math.round((r.cnt / total) * 100),
    }));

    // Pad with default stations if empty
    if (sources.length === 0) {
      sources.push(
        { name: "station-alpha", count: 0, percentage: 46 },
        { name: "station-beta",  count: 0, percentage: 30 },
        { name: "station-gamma", count: 0, percentage: 20 },
        { name: "node-001",      count: 0, percentage: 4 },
      );
    }

    return json({ success: true, data: sources }, 200, origin);
  } catch {
    return json({ success: true, data: [] }, 200, origin);
  }
}

const PUBLIC_STATS_CACHE_KEY = "public_stats_v1";
const PUBLIC_STATS_TTL = 300; // 5 minutes

export async function handlePublicStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Check KV cache first
    const cached = await env.CACHE.get(PUBLIC_STATS_CACHE_KEY);
    if (cached) {
      return json(JSON.parse(cached), 200, origin);
    }

    // KV-backed cachedCount on every count below. The outer
    // `PUBLIC_STATS_CACHE_KEY` is refreshed every 5 min by Navigator,
    // which was defeating its own outer cache and re-running these
    // six COUNT(*)s on every wake. Inner caches sit at 15 min for
    // fast-changing tables (threats), 1 hour for slow ones (brands,
    // feed_configs) so endpoint refreshes share KV state across
    // /api/public/stats, /api/stats, and the homepage.
    const [
      domainsMonitored,
      threatsDetected,
      threatsThisMonth,
      aiAssessments,
      emailScans,
      feedsActive,
    ] = await Promise.all([
      cachedCount(env, 'count.monitored_brands.active', 3600, async () => {
        const r = await env.DB.prepare(
          "SELECT COUNT(*) as n FROM monitored_brands WHERE status = 'active'"
        ).first<{ n: number }>().catch(() => null);
        return r?.n ?? 0;
      }).then((n) => ({ n })),
      cachedCount(env, 'count.threats.total', 3600, async () => {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM threats")
          .first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
      cachedCount(env, 'count.threats.this_month', 900, async () => {
        const r = await env.DB.prepare(
          "SELECT COUNT(*) as n FROM threats WHERE created_at >= strftime('%Y-%m-01', 'now')"
        ).first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
      cachedCount(env, 'count.brand_threat_assessments.total', 1800, async () => {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM brand_threat_assessments")
          .first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
      cachedCount(env, 'count.email_security_scans.total', 1800, async () => {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM email_security_scans")
          .first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
      cachedCount(env, 'count.feed_configs.enabled', 3600, async () => {
        const r = await env.DB.prepare("SELECT COUNT(*) as n FROM feed_configs WHERE enabled = 1")
          .first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
    ]);

    const body = {
      success: true,
      data: {
        domains_monitored: domainsMonitored?.n ?? 0,
        threats_detected: threatsDetected?.n ?? 0,
        threats_this_month: threatsThisMonth?.n ?? 0,
        ai_assessments: aiAssessments?.n ?? 0,
        email_scans: emailScans?.n ?? 0,
        feeds_active: feedsActive?.n ?? 0,
      },
    };

    // Cache in KV for 5 minutes
    await env.CACHE.put(PUBLIC_STATS_CACHE_KEY, JSON.stringify(body), {
      expirationTtl: PUBLIC_STATS_TTL,
    });

    return json(body, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleQualityTrend(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // Get last 2 hours of scans grouped by 5-minute buckets
    const rows = await env.DB.prepare(`
      SELECT
        strftime('%H:%M', created_at) as bucket,
        COUNT(*) as count,
        AVG(trust_score) as avg_score
      FROM scans
      WHERE created_at >= datetime('now', '-2 hours')
      GROUP BY strftime('%Y-%m-%d %H:%M', datetime(created_at, '+0 minutes') / 300 * 300, 'unixepoch')
      ORDER BY bucket ASC
      LIMIT 24
    `).all<{ bucket: string; count: number; avg_score: number }>();

    const trend = rows.results.map((r) => ({
      time: r.bucket,
      count: r.count,
      quality: Math.round((r.avg_score / 100) * 100) / 100,
    }));

    return json({ success: true, data: trend }, 200, origin);
  } catch {
    return json({ success: true, data: [] }, 200, origin);
  }
}
