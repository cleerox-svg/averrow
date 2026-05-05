// Averrow — KV-backed JSON value cache
//
// Generic helper for caching arbitrary JSON-serializable results from
// expensive D1 queries. Sister utility to `lib/cached-count.ts` —
// same TTL/fallthrough/observability semantics, but the value can be
// any shape (arrays, objects, nested) instead of a single integer.
//
// Use for handler responses, list-of-rows results, multi-column
// aggregates, etc. KV reads don't count against the D1 budget so
// every cache hit shaves a full query off the platform's main D1
// spend.
//
// Usage:
//   const recent = await cachedValue<Array<{ agent_id: string; last: string }>>(
//     env, 'agents.last_output_per_agent', 60,
//     async () => {
//       const res = await env.DB.prepare(
//         `SELECT agent_id, MAX(created_at) AS last FROM agent_outputs
//          WHERE created_at >= datetime('now', '-30 days') GROUP BY agent_id`
//       ).all<{ agent_id: string; last: string }>();
//       return res.results;
//     });
//
// Design rules (mirror cached-count.ts):
//   - Eventual-consistency is fine. If you need strict freshness,
//     pass a small TTL (60s).
//   - On any KV failure (get OR put) the helper falls through to the
//     compute path. Never crashes, never returns stale data on KV
//     errors — just slower.
//   - TTL is per-call; pass `0` to bypass the cache (kill-switch).
//   - Hit/miss/bypass outcomes recorded into the same KV stats ring
//     used by `cached-count.ts` so platform diagnostics show a
//     unified `cached_count.hit_rate` covering both helpers.
//
// See `docs/ARCHITECTURE.md` and `CLAUDE.md` §8 for the canonical
// pattern and migration story.

import type { Env } from "../types";

const CACHE_PREFIX = "cv:"; // distinct namespace from cc: (counter cache)
const STATS_KEY = "cc:_stats"; // shared stats ring with cached-count.ts
const STATS_RING_SIZE = 50;

interface CachedEntry<T> {
  /** Cached payload. JSON-serializable. */
  v: T;
  /** Epoch ms when the entry was written. */
  t: number;
}

/**
 * Read a JSON value from KV if fresh, otherwise run `compute`, write
 * the result back, and return it. On any KV error the helper falls
 * through to `compute()` — never crashes, never returns stale data.
 *
 * @param env          Worker environment (provides `CACHE` KV binding)
 * @param key          Stable cache key (e.g. `agents.last_output_per_agent`)
 * @param ttlSeconds   Freshness budget. Pass `0` to bypass cache entirely.
 * @param compute      Async function to run on a miss. Should return
 *                     the JSON-serializable value to cache.
 */
export async function cachedValue<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  if (ttlSeconds <= 0) {
    const value = await compute();
    void recordStat(env, "bypass");
    return value;
  }

  const cacheKey = CACHE_PREFIX + key;

  let cached: CachedEntry<T> | null = null;
  try {
    const raw = await env.CACHE.get(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw) as CachedEntry<T>;
      const ageSeconds = (Date.now() - parsed.t) / 1000;
      if (ageSeconds < ttlSeconds) {
        cached = parsed;
      }
    }
  } catch {
    // KV transient — fall through to compute.
  }

  if (cached) {
    void recordStat(env, "hit");
    return cached.v;
  }

  const value = await compute();
  void recordStat(env, "miss");

  try {
    const entry: CachedEntry<T> = { v: value, t: Date.now() };
    await env.CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: Math.max(ttlSeconds * 2, 60),
    });
  } catch {
    // Non-fatal.
  }

  return value;
}

// ─── Internal: hit/miss recording ─────────────────────────────────
//
// Shares the stats ring with cached-count.ts so the diagnostics
// endpoint surfaces a unified hit/miss view across both helpers.
async function recordStat(env: Env, outcome: "hit" | "miss" | "bypass"): Promise<void> {
  try {
    const raw = await env.CACHE.get(STATS_KEY);
    const ring = raw ? (JSON.parse(raw) as Array<string>) : [];
    ring.push(outcome);
    while (ring.length > STATS_RING_SIZE) ring.shift();
    await env.CACHE.put(STATS_KEY, JSON.stringify(ring), {
      expirationTtl: 86_400,
    });
  } catch {
    // Stats are observability — never fail the response path because of them.
  }
}
