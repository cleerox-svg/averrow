// Public-facing platform stats for the homepage hero.
//
// Surfaces a small set of numbers that change as the platform grows:
// total deployed agents, enabled feeds, threats detected, brands
// monitored. Cached in KV for 10 minutes so the homepage stays fast
// (the homepage Cache-Control already gives 5min, this layer covers
// the cache miss + reduces D1 traffic for high-traffic landing pages).
//
// Returns formatted strings (not raw numbers) so the template stays
// dumb — eg: "33+" for feeds, "18" for agents, "210K+" for threats.

import type { Env } from "../types";
import { cachedCount } from "./cached-count";
import { agentModules } from "../agents";

export interface PublicStats {
  agents_deployed: string;     // e.g. "42"
  feeds_protecting: string;    // e.g. "45+"
  threats_detected: string;    // e.g. "210K+"
  brands_monitored: string;    // e.g. "9.6K+"
  // Static marketing claims kept here so the template doesn't hardcode them
  // — change once, picked up everywhere.
  uptime_label: string;        // "24/7"
  detection_time_label: string; // "<5min"
}

const CACHE_KEY = "public_stats:v1";
const CACHE_TTL_S = 600; // 10 min

// agents_deployed is the SIZE OF THE AGENT REGISTRY (the number of entries
// in agentModules — currently 42), a stable platform fact. It is NOT the
// count of agents that happened to run in the last 7 days (~18): that number
// fluctuates and would contradict the "42 in the mesh" claim on the
// /platform and /why-averrow marketing pages. Derived from the registry so
// it stays correct as agents are added or retired.
const REGISTERED_AGENT_COUNT = Object.keys(agentModules).length;

const FALLBACK: PublicStats = {
  agents_deployed: String(REGISTERED_AGENT_COUNT),
  feeds_protecting: "45+",
  threats_detected: "210K+",
  brands_monitored: "9.6K+",
  uptime_label: "24/7",
  detection_time_label: "<5min",
};

function formatBigNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M+`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K+`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K+`;
  return `${n}`;
}

export async function getPublicStats(env: Env): Promise<PublicStats> {
  // Cache hit fast path. Failures fall through to a fresh read.
  try {
    const cached = await env.CACHE.get(CACHE_KEY);
    if (cached) return JSON.parse(cached) as PublicStats;
  } catch { /* ignore */ }

  try {
    // KV-backed inner caches share keys with handlers/stats.ts so the
    // homepage and /api/public/stats hit the same KV entries instead
    // of each one running its own COUNT(*). TTLs tuned per CLAUDE.md:
    // threats fast (15 min), feed_configs + brands slow (1 hour).
    const [feeds, threats, brands] = await Promise.all([
      cachedCount(env, 'count.feed_configs.enabled', 3600, async () => {
        const r = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM feed_configs WHERE enabled = 1",
        ).first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
      cachedCount(env, 'count.threats.total', 3600, async () => {
        const r = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM threats",
        ).first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
      cachedCount(env, 'count.brands.total', 3600, async () => {
        const r = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM brands",
        ).first<{ n: number }>();
        return r?.n ?? 0;
      }).then((n) => ({ n })),
    ]);

    const stats: PublicStats = {
      // Stable registry size — see REGISTERED_AGENT_COUNT above.
      agents_deployed: String(REGISTERED_AGENT_COUNT),
      feeds_protecting: feeds?.n ? `${feeds.n}+` : FALLBACK.feeds_protecting,
      threats_detected: threats?.n ? formatBigNumber(threats.n) : FALLBACK.threats_detected,
      brands_monitored: brands?.n ? formatBigNumber(brands.n) : FALLBACK.brands_monitored,
      uptime_label: FALLBACK.uptime_label,
      detection_time_label: FALLBACK.detection_time_label,
    };

    try {
      await env.CACHE.put(CACHE_KEY, JSON.stringify(stats), { expirationTtl: CACHE_TTL_S });
    } catch { /* ignore */ }

    return stats;
  } catch {
    // D1 down or schema missing — keep the homepage rendering. Fallback
    // values match the platform's current rough state so the page never
    // shows zeros.
    return FALLBACK;
  }
}
