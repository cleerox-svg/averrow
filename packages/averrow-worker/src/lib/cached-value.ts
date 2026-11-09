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
import { refreshAfterSeconds } from "./cache-refresh";

const CACHE_PREFIX = "cv:"; // distinct namespace from cc: (counter cache)
const STATS_KEY = "cc:_stats"; // shared stats ring with cached-count.ts
const STATS_RING_SIZE = 50;
const LOCK_PREFIX = "cvlock:"; // single-flight refill locks

/** Upper bound on a single-flight wait — far under the ~100s edge timeout. */
export const SINGLE_FLIGHT_MAX_WAIT_MS = 10_000;

/**
 * Opt-in stale-while-revalidate for `cachedValue` (see its doc): `ttlSeconds`
 * becomes how long an entry may be SERVED, `freshSeconds` how long it is
 * served without a refresh.
 */
export interface StaleWhileRevalidateOptions {
  /** Max entry age (s) served without a refresh — the endpoint's freshness promise. */
  freshSeconds: number;
  /**
   * `ExecutionContext.waitUntil`. With it, an entry older than
   * `freshSeconds` (but younger than `ttlSeconds`) is returned at once and
   * ONE caller — the holder of the `cvlock:` refill lock — recomputes it in
   * the background. Without it (no ExecutionContext) the entry is
   * recomputed inline, i.e. plain `freshSeconds` TTL semantics.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** KV TTL of the background-refill lock (KV minimum 60s). Default 60. */
  lockTtlSeconds?: number;
}

/** Opt-in single-flight refill for `cachedValue` (see its doc). */
export interface SingleFlightOptions {
  /** KV TTL of the refill lock (KV minimum 60s). Bounds how long a crashed holder's lock lingers. */
  lockTtlSeconds: number;
  /**
   * Only when there is NO entry at all (cold key) and another caller holds
   * the lock: how long to wait for its write before computing anyway.
   * Clamped to SINGLE_FLIGHT_MAX_WAIT_MS.
   */
  waitMs: number;
  /** Re-read interval during that wait. Default 1000ms. */
  pollMs?: number;
}

interface CachedEntry<T> {
  /** Cached payload. JSON-serializable. */
  v: T;
  /** Epoch ms when the entry was written (pre-aged for a short entry). */
  t: number;
  /**
   * 1 = a SHORT entry: written with a `ttlFor` below the caller's
   * `ttlSeconds` (e.g. a degraded result). Absent on full-TTL entries and on
   * envelopes written before the flag existed (both read as full).
   */
  s?: 1;
}

/**
 * Read a JSON value from KV if fresh, otherwise run `compute`, write
 * the result back, and return it. On any KV error the helper falls
 * through to `compute()` — never crashes, never returns stale data
 * (except via the opt-in `singleFlight` stale-while-revalidate below).
 *
 * @param env          Worker environment (provides `CACHE` KV binding)
 * @param key          Stable cache key (e.g. `agents.last_output_per_agent`)
 * @param ttlSeconds   Freshness budget. Pass `0` to bypass cache entirely.
 * @param compute      Async function to run on a miss. Should return
 *                     the JSON-serializable value to cache.
 * @param opts.ttlFor  Optional per-result freshness: return a SHORTER ttl (seconds) for a
 *                     result that should not live the full `ttlSeconds` (e.g. a degraded
 *                     response). The entry is stamped as if written `ttlSeconds - ttlFor`
 *                     ago, so readers (who only know `ttlSeconds`) treat it as expired
 *                     after `ttlFor`. A value <= 0 skips the write. Never lengthens.
 *                     A short result never displaces a usable FULL entry: when a
 *                     prior full-TTL entry is still servable to this caller (within
 *                     `ttlSeconds`, or any stored entry under `singleFlight`, which
 *                     serves stale), the PUT is skipped and the prior value is
 *                     returned, so a degraded refill during an overload can't
 *                     overwrite a good stale copy. With no such prior (cold key,
 *                     or the prior is itself short) the short entry is written.
 * @param opts.singleFlight Optional best-effort refill lock with
 *                     stale-while-revalidate. On an expired entry: if another
 *                     caller holds the lock, the STALE value is returned at once
 *                     (entries stay in KV for 2× their TTL, so stale ≤ 2× TTL
 *                     old); otherwise this caller takes the lock, re-reads, and
 *                     recomputes. Only a cold key (no entry at all) with the
 *                     lock held waits — at most `waitMs` (≤10s) — then computes.
 *                     Fails open on KV errors. This option is the one case
 *                     where the helper can return data older than `ttlSeconds`.
 * @param opts.staleWhileRevalidate Serve-stale-then-refresh: see
 *                     StaleWhileRevalidateOptions. `ttlSeconds` is then the
 *                     max servable age (keep it >= the warm interval) and
 *                     `freshSeconds` the live freshness. Ignored on a
 *                     `refresh` (warm) call.
 * @param opts.refresh Refresh-ahead for a Navigator warm (pass
 *                     `isCacheRefresh(request)`): the entry is treated as
 *                     expired once it is `refreshAfterSeconds(ttlSeconds)` old
 *                     (lib/cache-refresh.ts), so a warm on a cadence ≤ the TTL
 *                     recomputes the key before live readers see it lapse.
 *                     Live callers leave it unset.
 */
export async function cachedValue<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
  opts: {
    ttlFor?: (value: T) => number;
    singleFlight?: SingleFlightOptions;
    refresh?: boolean;
    staleWhileRevalidate?: StaleWhileRevalidateOptions;
  } = {},
): Promise<T> {
  if (ttlSeconds <= 0) {
    const value = await compute();
    void recordStat(env, "bypass");
    return value;
  }

  const cacheKey = CACHE_PREFIX + key;
  // Refresh-ahead (Navigator warm): an entry counts as fresh only until
  // refreshAfterSeconds(ttl), so the warm recomputes it before it expires.
  // Stale-while-revalidate: a live read is fresh only for `freshSeconds`
  // (a warm keeps the refresh-ahead rule on the full TTL).
  const swr = opts.refresh ? undefined : opts.staleWhileRevalidate;
  const freshFor = opts.refresh
    ? refreshAfterSeconds(ttlSeconds)
    : swr
      ? Math.min(swr.freshSeconds, ttlSeconds)
      : ttlSeconds;

  /** The stored entry (fresh or expired-but-still-in-KV), or null. */
  const readEntry = async (): Promise<{ entry: CachedEntry<T>; fresh: boolean; servable: boolean } | null> => {
    try {
      const raw = await env.CACHE.get(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedEntry<T>;
        const ageSeconds = (Date.now() - parsed.t) / 1000;
        return { entry: parsed, fresh: ageSeconds < freshFor, servable: ageSeconds < ttlSeconds };
      }
    } catch {
      // KV transient — fall through to compute.
    }
    return null;
  };

  const first = await readEntry();
  if (first?.fresh) {
    void recordStat(env, "hit");
    return first.entry.v;
  }

  /**
   * Whether `prior` may stand in for a SHORT result instead of being
   * overwritten by it: it must be a full-TTL entry (no `s` flag) that this
   * caller is allowed to serve — within `ttlSeconds`, or (singleFlight,
   * which serves stale up to the KV expiry) any entry still stored.
   */
  const keepsOverShort = (prior: CachedEntry<T> | null): prior is CachedEntry<T> => {
    if (!prior || prior.s === 1) return false;
    if (opts.singleFlight) return true;
    return (Date.now() - prior.t) / 1000 < ttlSeconds;
  };

  const computeAndStore = async (prior: CachedEntry<T> | null): Promise<T> => {
    const value = await compute();
    void recordStat(env, "miss");

    const effective = opts.ttlFor ? Math.min(ttlSeconds, opts.ttlFor(value)) : ttlSeconds;
    const short = effective < ttlSeconds;
    // A short (e.g. degraded) result must not overwrite a usable full entry.
    if (short && keepsOverShort(prior)) return prior.v;
    if (effective <= 0) return value;
    try {
      const entry: CachedEntry<T> = short
        ? { v: value, t: Date.now() - (ttlSeconds - effective) * 1000, s: 1 }
        : { v: value, t: Date.now() };
      await env.CACHE.put(cacheKey, JSON.stringify(entry), {
        expirationTtl: Math.max(effective * 2, 60),
      });
    } catch {
      // Non-fatal.
    }

    return value;
  };

  const lockKey = LOCK_PREFIX + key;

  // Stale-while-revalidate (opt-in): serve a stale-but-servable entry now;
  // the caller that takes the refill lock recomputes it under waitUntil,
  // everyone else just serves the stale value. Best-effort like singleFlight
  // (KV is not transactional) and fail-open.
  if (swr?.waitUntil && first?.servable) {
    let held = false;
    try {
      held = (await env.CACHE.get(lockKey)) !== null;
    } catch {
      held = false;
    }
    if (!held) {
      let locked = false;
      try {
        await env.CACHE.put(lockKey, String(Date.now()), {
          expirationTtl: Math.max(swr.lockTtlSeconds ?? 60, 60),
        });
        locked = true;
      } catch {
        // Fail open — refill without the lock.
      }
      swr.waitUntil((async () => {
        try {
          await computeAndStore(first.entry);
        } catch {
          // Background refill failed: the stale entry keeps serving until ttlSeconds.
        } finally {
          if (locked) {
            try { await env.CACHE.delete(lockKey); } catch { /* expires on its TTL */ }
          }
        }
      })());
    }
    void recordStat(env, "hit");
    return first.entry.v;
  }

  // Single-flight (opt-in), stale-while-revalidate: only one caller
  // refills an expensive key while the rest keep serving the expired entry.
  // KV is not transactional, so this is best-effort — it collapses the
  // common "several tabs miss at once" herd, not every race — and fails
  // open: a KV error, or a cold key whose lock holder hasn't written within
  // `waitMs`, falls through to computing here.
  let ownLock = false;
  let prior: CachedEntry<T> | null = first?.entry ?? null;
  if (opts.singleFlight) {
    const sf = opts.singleFlight;
    let held = false;
    try {
      held = (await env.CACHE.get(lockKey)) !== null;
    } catch {
      held = false;
    }
    if (held) {
      if (first) {
        // Someone is already refilling: serve the stale value, no wait.
        void recordStat(env, "hit");
        return first.entry.v;
      }
      // Cold key: nothing to serve. Wait briefly for the holder's write.
      const deadline = Date.now() + Math.min(sf.waitMs, SINGLE_FLIGHT_MAX_WAIT_MS);
      const pollMs = sf.pollMs ?? 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const filled = await readEntry();
        if (filled) {
          void recordStat(env, "hit");
          return filled.entry.v;
        }
      }
    } else {
      try {
        await env.CACHE.put(lockKey, String(Date.now()), {
          expirationTtl: Math.max(sf.lockTtlSeconds, 60),
        });
        ownLock = true;
      } catch {
        // Fail open — compute without the lock.
      }
      if (ownLock) {
        // Another caller may have finished a refill between our first read
        // and taking the lock.
        const again = await readEntry();
        if (again?.fresh) {
          try { await env.CACHE.delete(lockKey); } catch { /* expires on its TTL */ }
          void recordStat(env, "hit");
          return again.entry.v;
        }
        if (again) prior = again.entry;
      }
    }
  }

  try {
    return await computeAndStore(prior);
  } finally {
    if (ownLock) {
      try {
        await env.CACHE.delete(lockKey);
      } catch {
        // Lock expires on its own TTL.
      }
    }
  }
}

/** The KV key `cachedValue(env, key, …)` stores under — for callers that delete it. */
export function cachedValueKvKey(key: string): string {
  return CACHE_PREFIX + key;
}

/**
 * Write a value into the `cachedValue` cache from an authoritative path,
 * so the next `cachedValue(env, key, ttlSeconds, …)` read is a hit. Sister
 * of `seedCount` (lib/cached-count.ts): same envelope, key prefix and padded
 * `expirationTtl` as cachedValue's own PUT. Keep `ttlSeconds` equal to the
 * reader's TTL. Best-effort — a missing CACHE binding or KV failure is
 * swallowed.
 */
export async function seedValue<T>(
  env: { CACHE?: KVNamespace },
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0 || !env.CACHE) return;
  try {
    const entry: CachedEntry<T> = { v: value, t: Date.now() };
    await env.CACHE.put(CACHE_PREFIX + key, JSON.stringify(entry), {
      expirationTtl: Math.max(ttlSeconds * 2, 60),
    });
  } catch {
    // Non-fatal — same contract as cachedValue's PUT.
  }
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
