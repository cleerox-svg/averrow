// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import { logger } from "../lib/logger";
import type { Env } from "../types";

interface HealthCheck {
  status: "ok" | "error";
  latency_ms?: number;
  error?: string;
}

interface HealthResponse {
  status: "healthy" | "degraded";
  version: string;
  timestamp: string;
  database: "connected" | "disconnected";
  checks: {
    d1: HealthCheck;
    kv: HealthCheck;
  };
  stats: {
    brands_monitored: number;
    threats_active: number;
    feeds_enabled: number;
  };
}

export async function handleHealthCheck(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const startTime = Date.now();

  // Check D1 connectivity and measure latency
  let d1Check: HealthCheck;
  try {
    const d1Start = performance.now();
    await env.DB.prepare("SELECT 1").first();
    const d1Latency = Math.round(performance.now() - d1Start);
    d1Check = { status: "ok", latency_ms: d1Latency };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    d1Check = { status: "error", error: message };
    logger.error("health.d1_check_failed", { error: message });
  }

  // Check KV availability
  let kvCheck: HealthCheck;
  try {
    const kvTestKey = "__health_check__";
    await env.CACHE.put(kvTestKey, "1", { expirationTtl: 60 });
    const val = await env.CACHE.get(kvTestKey);
    kvCheck = val === "1" ? { status: "ok" } : { status: "error", error: "read-back mismatch" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    kvCheck = { status: "error", error: message };
    logger.error("health.kv_check_failed", { error: message });
  }

  // Pull basic stats counts
  let brandsMonitored = 0;
  let threatsActive = 0;
  let feedsEnabled = 0;
  try {
    const [brands, threats, feeds] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as cnt FROM monitored_brands").first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
      env.DB.prepare("SELECT COALESCE(SUM(threat_count), 0) AS cnt FROM threat_cube_status WHERE status = 'active'").first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM feeds WHERE enabled = 1").first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
    ]);
    brandsMonitored = brands?.cnt ?? 0;
    threatsActive = threats?.cnt ?? 0;
    feedsEnabled = feeds?.cnt ?? 0;
  } catch {
    logger.warn("health.stats_query_failed");
  }

  const isHealthy = d1Check.status === "ok" && kvCheck.status === "ok";
  const dbStatus = d1Check.status === "ok" ? "connected" : "disconnected";

  const response: HealthResponse = {
    status: isHealthy ? "healthy" : "degraded",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    database: dbStatus,
    checks: {
      d1: d1Check,
      kv: kvCheck,
    },
    stats: {
      brands_monitored: brandsMonitored,
      threats_active: threatsActive,
      feeds_enabled: feedsEnabled,
    },
  };

  const statusCode = isHealthy ? 200 : 503;
  const totalLatency = Date.now() - startTime;

  logger.info("health.check_completed", {
    status: response.status,
    d1: d1Check.status,
    kv: kvCheck.status,
    latency_ms: totalLatency,
  });

  return json(response, statusCode, origin);
}
