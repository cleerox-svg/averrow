import { json } from "../lib/cors";
import { logger } from "../lib/logger";
import type { Env } from "../types";

/**
 * KV-backed sliding window rate limiter for Cloudflare Workers.
 * Uses KV with TTL to track request counts per IP/key window.
 */

export interface RateLimitConfig {
  /** Bucket key, e.g. 'scan', 'api' */
  key: string;
  /** Max requests per window */
  maxRequests: number;
  /** Window size in seconds */
  windowSeconds: number;
}

/**
 * Standard rate limit presets.
 *
 * POST /api/scan/report (public):   5/hour per IP
 * GET  /api/* (auth'd):           100/min per user
 * POST /api/brands (auth'd):      10/hour per user
 */
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  auth:        { key: "auth",        maxRequests: 10,  windowSeconds: 60 },     // 10 auth attempts per minute
  scan:        { key: "scan",        maxRequests: 30,  windowSeconds: 60 },     // 30 scans per minute
  scan_report: { key: "scan_report", maxRequests: 5,   windowSeconds: 3600 },   // 5 public scan reports per hour
  api:         { key: "api",         maxRequests: 100,  windowSeconds: 60 },    // 100 API calls per minute (auth'd)
  brands:      { key: "brands",      maxRequests: 10,  windowSeconds: 3600 },   // 10 brand creates per hour (auth'd)
};

function getClientIP(request: Request): string {
  // L2: CF-Connecting-IP only — X-Forwarded-For is client-spoofable and
  // would let an attacker rotate rate-limit identities for free.
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Apply rate limiting using a named preset bucket.
 * @param identifierOverride - Optional override for the rate-limit identity (e.g., user ID instead of IP).
 */
export async function rateLimit(
  request: Request,
  env: Env,
  bucket: keyof typeof RATE_LIMITS = "api",
  identifierOverride?: string,
): Promise<Response | null> {
  const config = RATE_LIMITS[bucket];
  if (!config || !env.CACHE) return null;

  const identifier = identifierOverride ?? getClientIP(request);
  const windowKey = Math.floor(Date.now() / (config.windowSeconds * 1000));
  const key = `rl:${config.key}:${identifier}:${windowKey}`;

  try {
    const current = parseInt(await env.CACHE.get(key) ?? "0", 10);

    if (current >= config.maxRequests) {
      const retryAfter = config.windowSeconds - Math.floor((Date.now() / 1000) % config.windowSeconds);
      const origin = request.headers.get("Origin");

      logger.warn("rate_limit.exceeded", {
        bucket: config.key,
        identifier,
        current,
        limit: config.maxRequests,
        window_seconds: config.windowSeconds,
      });

      return json(
        { success: false, error: "Too many requests. Please try again later." },
        429,
        origin,
      );
    }

    await env.CACHE.put(key, String(current + 1), { expirationTtl: config.windowSeconds * 2 });
  } catch {
    logger.warn("rate_limit.kv_error", { bucket: config.key, identifier });
    // L1: the auth bucket fails CLOSED — an attacker must not be able to
    // bypass login/credential throttling by inducing KV failures. All
    // other buckets keep failing open (availability over strictness).
    if (config.key === "auth") {
      return json(
        { success: false, error: "Too many requests. Please try again later." },
        429,
        request.headers.get("Origin"),
      );
    }
  }

  return null;
}

/**
 * Apply rate limiting with a custom configuration (for one-off endpoints).
 */
export async function rateLimitCustom(
  request: Request,
  env: Env,
  config: RateLimitConfig,
  identifierOverride?: string,
): Promise<Response | null> {
  if (!env.CACHE) return null;

  const identifier = identifierOverride ?? getClientIP(request);
  const windowKey = Math.floor(Date.now() / (config.windowSeconds * 1000));
  const key = `rl:${config.key}:${identifier}:${windowKey}`;

  try {
    const current = parseInt(await env.CACHE.get(key) ?? "0", 10);

    if (current >= config.maxRequests) {
      const origin = request.headers.get("Origin");

      logger.warn("rate_limit.exceeded", {
        bucket: config.key,
        identifier,
        current,
        limit: config.maxRequests,
        window_seconds: config.windowSeconds,
      });

      return json(
        { success: false, error: "Too many requests. Please try again later." },
        429,
        origin,
      );
    }

    await env.CACHE.put(key, String(current + 1), { expirationTtl: config.windowSeconds * 2 });
  } catch {
    logger.warn("rate_limit.kv_error", { bucket: config.key, identifier });
    // L1: keep parity with the preset path — an 'auth'-keyed custom
    // config also fails closed on KV errors.
    if (config.key === "auth") {
      return json(
        { success: false, error: "Too many requests. Please try again later." },
        429,
        request.headers.get("Origin"),
      );
    }
  }

  return null;
}
