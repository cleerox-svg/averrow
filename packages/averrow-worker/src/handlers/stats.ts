// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import type { Env } from "../types";
import { cachedCount } from "../lib/cached-count";

// The v1 scan aggregates (handleStats / handleSourceMix / handleQualityTrend,
// behind /api/dashboard/{stats,sources,trend}) were retired with the URL-scan
// feature (2026-10-04): they read `scans` / `domain_cache`, which never
// existed in prod.

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
