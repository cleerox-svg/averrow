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
import { cachedCount, THREATS_TOTAL_TTL_S } from "./cached-count";
import { agentModules } from "../agents";

export interface PublicStats {
  agents_deployed: string;     // e.g. "42"
  feeds_protecting: string | null;    // e.g. "45+"; null when unknown
  threats_detected: string | null;    // e.g. "1.3M+" — formatted from threats_total
  /** The ONE published threat total: all-time `COUNT(*) FROM threats`
   *  (cachedCount `count.threats.total`). `threats_detected` is this number
   *  formatted, and /api/v1/public/stats `total_threats` is this number raw,
   *  so the two can never disagree (disclosure register L20). */
  threats_total: number | null;
  /** Size of the brand CATALOG (`COUNT(*) FROM brands`, incl. the passive
   *  tier='tracked' rows), formatted. The key name is legacy (the /legacy
   *  homepage template + `brands_monitored_label` read it); it is NOT the
   *  monitored-brand count — see proof.monitored_brands (register L12). */
  brands_monitored: string | null;    // e.g. "124K+"
  // Static marketing claim kept here so the template doesn't hardcode it.
  uptime_label: string;        // "24/7"
  // detection_time_label ("<5min") was REMOVED (register L4/G1): it was a
  // hard-coded constant that no metric measured. Do not reintroduce a
  // detection-time claim without an instrumented source.
}

// v3: shape changed (threats_total added, detection_time_label removed,
// D1-derived fields nullable) —
// a v1 payload must not be served into the new shape.
const CACHE_KEY = "public_stats:v3";
const CACHE_TTL_S = 600; // 10 min

// agents_deployed is the SIZE OF THE AGENT REGISTRY (the number of entries
// in agentModules — currently 42), a stable platform fact. It is NOT the
// count of agents that happened to run in the last 7 days (~18): that number
// fluctuates and would contradict the "42 in the mesh" claim on the
// /platform and /why-averrow marketing pages. Derived from the registry so
// it stays correct as agents are added or retired.
const REGISTERED_AGENT_COUNT = Object.keys(agentModules).length;

// Last-known-good copy of the computed stats, written on every successful
// compute and read only when D1 fails. 30-day expiry so a long outage
// eventually publishes "unknown" (null) rather than an ever-staler number.
// There is deliberately NO invented fallback number: when neither D1 nor
// the LKG copy is available, the D1-derived fields are null and consumers
// (averrow-marketing's fetch-stats.mjs keeps its own last build's values on
// a non-string) decide what to render.
const LKG_KEY = "public_stats:lkg:v1";
const LKG_TTL_S = 30 * 86400;

const UNKNOWN: PublicStats = {
  agents_deployed: String(REGISTERED_AGENT_COUNT),
  feeds_protecting: null,
  threats_detected: null,
  threats_total: null,
  brands_monitored: null,
  uptime_label: "24/7",
};

async function readLastKnownGood(env: Env): Promise<PublicStats | null> {
  try {
    const raw = await env.CACHE.get(LKG_KEY);
    return raw ? (JSON.parse(raw) as PublicStats) : null;
  } catch {
    return null;
  }
}

export function formatBigNumber(n: number): string {
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
      cachedCount(env, 'count.threats.total', THREATS_TOTAL_TTL_S, async () => {
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

    // A zero count is treated as "unknown" (a real platform never has 0
    // threats/brands/feeds) and filled from the last-known-good copy.
    const lkg = feeds.n && threats.n && brands.n ? null : await readLastKnownGood(env);
    const stats: PublicStats = {
      // Stable registry size — see REGISTERED_AGENT_COUNT above.
      agents_deployed: String(REGISTERED_AGENT_COUNT),
      feeds_protecting: feeds.n ? `${feeds.n}+` : lkg?.feeds_protecting ?? null,
      // threats_detected and threats_total always come from the same
      // source (fresh count, or the same LKG copy) so they cannot disagree.
      threats_detected: threats.n ? formatBigNumber(threats.n) : lkg?.threats_detected ?? null,
      threats_total: threats.n ? threats.n : lkg?.threats_total ?? null,
      brands_monitored: brands.n ? formatBigNumber(brands.n) : lkg?.brands_monitored ?? null,
      uptime_label: UNKNOWN.uptime_label,
    };

    try {
      await env.CACHE.put(CACHE_KEY, JSON.stringify(stats), { expirationTtl: CACHE_TTL_S });
      if (feeds.n && threats.n && brands.n) {
        await env.CACHE.put(LKG_KEY, JSON.stringify(stats), { expirationTtl: LKG_TTL_S });
      }
    } catch { /* ignore */ }

    return stats;
  } catch {
    // D1 down or schema missing: serve the last-known-good copy, else
    // unknowns. Never an invented number.
    return (await readLastKnownGood(env)) ?? UNKNOWN;
  }
}
