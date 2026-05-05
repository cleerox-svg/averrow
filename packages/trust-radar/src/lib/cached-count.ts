// Averrow — KV-backed counter cache
//
// Generic helper for caching the result of expensive `SELECT COUNT(*)`
// queries against the threats table (and any other counter that
// tolerates a few seconds of staleness). Replaces ad-hoc per-handler
// cache code and the legacy `system_metrics` D1-backed counter cache —
// KV reads do not count against the D1 budget, so every cache hit
// shaves rows-read from the platform's main D1 spend.
//
// Design rules:
//   - Eventual-consistency is fine. Counters are tile/dashboard data;
//     a 60s lag is invisible to the operator.
//   - On any KV failure (get OR put) the helper falls through to the
//     compute path. We never serve a stale value from a previous
//     compute when KV is unavailable, and we never crash the request.
//   - TTL is per-call, not global, so callers can pick a freshness
//     budget appropriate to the underlying drift rate. Total threat
//     count drifts <0.1%/min so 60-300s is generous; less-volatile
//     counters (brands, providers) can use 3600s.
//   - Hit/miss is recorded in a tiny KV ring so we can verify the
//     cache is doing real work after deploy. The ring is best-effort —
//     a write failure here must not affect the response path.
//
// Usage:
//   const total = await cachedCount(env, 'count.threats.total', 60,
//     () => env.DB.prepare('SELECT COUNT(*) AS n FROM threats')
//       .first<{ n: number }>().then(r => r?.n ?? 0));
//
// See `docs/ARCHITECTURE.md` and `CLAUDE.md` §8 for the canonical
// pattern and migration story.

import type { Env } from "../types";

const CACHE_PREFIX = "cc:"; // namespace KV keys to avoid collision with other caches
const STATS_KEY = "cc:_stats"; // small ring-buffer for hit/miss observability
const STATS_RING_SIZE = 50;

interface CachedEntry {
  /** Integer value being cached. */
  v: number;
  /** Epoch ms when the entry was written — used to compute age in diagnostics. */
  t: number;
}

/**
 * Read a counter from KV if fresh, otherwise run `compute`, write the
 * result back, and return it. On any KV error the helper falls through
 * to `compute()` — never crashes, never returns stale data.
 *
 * @param env          Worker environment (provides `CACHE` KV binding)
 * @param key          Stable cache key (e.g. `count.threats.total`)
 * @param ttlSeconds   Freshness budget. Pass `0` to bypass cache entirely
 *                     (useful as a kill-switch without code changes).
 * @param compute      Async function to run on a miss. Should return the
 *                     fresh integer value.
 */
export async function cachedCount(
  env: Env,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<number>,
): Promise<number> {
  // Bypass: TTL of 0 (or negative) means never use the cache. Lets
  // operators kill-switch a key by setting the TTL to 0 in code.
  if (ttlSeconds <= 0) {
    const value = await compute();
    void recordStat(env, "bypass");
    return value;
  }

  const cacheKey = CACHE_PREFIX + key;

  // GET — never throw out to the caller.
  let cached: CachedEntry | null = null;
  try {
    const raw = await env.CACHE.get(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw) as CachedEntry;
      const ageSeconds = (Date.now() - parsed.t) / 1000;
      if (ageSeconds < ttlSeconds) {
        cached = parsed;
      }
    }
  } catch {
    // KV transient — fall through to compute. Don't log every failure;
    // KV is generally rock-solid, and noisy logs would obscure real issues.
  }

  if (cached) {
    void recordStat(env, "hit");
    return cached.v;
  }

  // MISS — compute fresh value.
  const value = await compute();
  void recordStat(env, "miss");

  // PUT — best-effort. If this fails, the caller still gets the
  // correct fresh value; next request will just be another miss.
  try {
    const entry: CachedEntry = { v: value, t: Date.now() };
    // expirationTtl gives KV its own GC trigger so dead keys don't
    // accumulate. We pad it slightly past ttlSeconds so a request
    // racing past the TTL boundary still finds the entry to overwrite.
    await env.CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: Math.max(ttlSeconds * 2, 60),
    });
  } catch {
    // Non-fatal.
  }

  return value;
}

/**
 * Snapshot of cache hit/miss stats over the recent ring window. Used
 * by `/api/internal/platform-diagnostics` to verify the cache is
 * doing meaningful work after deploy.
 */
export interface CachedCountStats {
  hits: number;
  misses: number;
  bypasses: number;
  ring_size: number;
  /** hits / (hits + misses) — null when ring is empty. */
  hit_rate: number | null;
}

export async function getCachedCountStats(env: Env): Promise<CachedCountStats> {
  try {
    const raw = await env.CACHE.get(STATS_KEY);
    if (!raw) {
      return { hits: 0, misses: 0, bypasses: 0, ring_size: 0, hit_rate: null };
    }
    const ring = JSON.parse(raw) as Array<"hit" | "miss" | "bypass">;
    const hits = ring.filter((s) => s === "hit").length;
    const misses = ring.filter((s) => s === "miss").length;
    const bypasses = ring.filter((s) => s === "bypass").length;
    const denom = hits + misses;
    return {
      hits,
      misses,
      bypasses,
      ring_size: ring.length,
      hit_rate: denom > 0 ? Math.round((hits / denom) * 1000) / 10 : null,
    };
  } catch {
    return { hits: 0, misses: 0, bypasses: 0, ring_size: 0, hit_rate: null };
  }
}

// ─── Internal: hit/miss recording ─────────────────────────────────
//
// A fixed-size ring of recent outcomes. Bounded write rate, bounded
// storage. Concurrent writes can race — KV reads/writes aren't atomic —
// but for a stats counter that's fine; we'll lose a few samples and
// the rate stays representative.
async function recordStat(env: Env, outcome: "hit" | "miss" | "bypass"): Promise<void> {
  try {
    const raw = await env.CACHE.get(STATS_KEY);
    const ring = raw ? (JSON.parse(raw) as Array<string>) : [];
    ring.push(outcome);
    while (ring.length > STATS_RING_SIZE) ring.shift();
    await env.CACHE.put(STATS_KEY, JSON.stringify(ring), {
      // Long enough that idle environments still keep stats; short
      // enough that the ring rolls over after a quiet period.
      expirationTtl: 86_400,
    });
  } catch {
    // Stats are observability — never fail the response path because of them.
  }
}
