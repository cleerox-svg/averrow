// Averrow — Platform Status Handler
//
// Wraps lib/platform-status.computePlatformStatus with a 60s KV cache so
// the Home banner and (Phase 3) public status page can poll without
// hammering D1. The window is short on purpose — operators need the
// banner to flip within ~1 min of an outage starting.
//
// Auth-routing is owned by the caller:
//   /api/admin/platform-status     — JWT super_admin (routes/admin.ts)
//   /api/internal/platform-status  — AVERROW_INTERNAL_SECRET (index.ts)
// Both call this same handler.

import { json } from "../lib/cors";
import { computePlatformStatus, type PlatformStatus } from "../lib/platform-status";
import type { CategoryKey, CategoryRollup } from "@averrow/shared";
import type { Env } from "../types";

const CACHE_KEY = "platform_status:v1:30d";
const CACHE_TTL_SECONDS = 60;
const WINDOW_DAYS = 30;
const FALLBACK_CATEGORIES: CategoryKey[] = ["feeds", "agents", "processing"];

// Contract-faithful fallback for when computePlatformStatus throws. This
// endpoint is documented to return a PlatformStatus body DIRECTLY (never the
// {success,error} envelope), and its whole job is to REPORT outage state — so
// a compute failure is itself reported as an outage rather than as a
// shape-incompatible error object. Every required PlatformStatus field is
// present so a consumer can always read a valid CategoryStatus off `overall`.
function buildOutageFallback(note: string): PlatformStatus {
  const generatedAt = new Date().toISOString();
  const categories: CategoryRollup[] = FALLBACK_CATEGORIES.map((category) => ({
    category,
    current: "outage",
    uptime_30d_pct: 0,
    daily: [],
    realtime: "outage",
    realtime_note: note,
  }));
  return {
    generated_at: generatedAt,
    overall: "outage",
    overall_note: note,
    categories,
    window_days: WINDOW_DAYS,
  };
}

export async function handlePlatformStatus(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";

  if (!refresh) {
    try {
      const cached = await env.CACHE.get(CACHE_KEY);
      if (cached) {
        return json<PlatformStatus & { cached: true }>(
          { ...JSON.parse(cached) as PlatformStatus, cached: true },
          200,
          origin,
        );
      }
    } catch {
      // KV transient errors must never block the live computation. The
      // status endpoint is consulted during incidents — failing here
      // would make the banner go dark exactly when operators need it.
    }
  }

  try {
    const status = await computePlatformStatus(env);
    try {
      await env.CACHE.put(CACHE_KEY, JSON.stringify(status), { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      // Cache write failure is non-fatal — caller still gets the response.
    }
    return json<PlatformStatus & { cached: false }>({ ...status, cached: false }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the diagnostic — don't swallow the underlying compute failure.
    console.error(`platform-status compute failed: ${message}`);
    // Honor the endpoint's contract: return a PlatformStatus-shaped body
    // reporting an outage, NOT the generic {success,error} envelope (which is
    // shape-incompatible with PlatformStatus and crashed the staff dashboard).
    // HTTP 200 because this is a health rollup whose job is to survive
    // KV/D1 hiccups during incidents and always report a readable state.
    return json<PlatformStatus & { cached: false }>(
      { ...buildOutageFallback("Status data temporarily unavailable"), cached: false },
      200,
      origin,
    );
  }
}
