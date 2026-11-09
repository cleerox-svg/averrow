// Averrow — stale-while-revalidate KV cache for page-load endpoints.
//
// Problem it solves (page-load perf, 2026-11): a page-load handler whose
// KV TTL is shorter than Navigator's warm interval (e.g. the admin dashboard
// at 75s vs. the 15-min Phase B warm) is cold on most first visits — the
// warm fills the key, it expires a minute later, and the next visitor pays
// the full compute. Raising the TTL alone would trade that for data up to
// one warm interval old, breaking the freshness the page promises.
//
// This helper separates the two:
//   - `ttlSeconds`   — how long the entry LIVES in KV. Set it >= the warm
//                      interval, so a first visit almost always finds an
//                      entry.
//   - `freshSeconds` — how old an entry a LIVE request accepts as-is (the
//                      endpoint's old TTL, i.e. its freshness promise).
//                      An older entry is still returned immediately, and
//                      recomputed in the background (`waitUntil`) so the
//                      next request — the page's own poll — is fresh.
//                      Without a `waitUntil` (a caller that has no
//                      ExecutionContext) a stale entry is recomputed
//                      inline, exactly like the old TTL expiry.
//   - Navigator warms (refresh-marked requests, lib/cache-refresh.ts)
//     recompute once the entry is `refreshAfterSeconds(ttlSeconds)` old,
//     the same refresh-ahead rule the Observatory handlers use, so the
//     key never lapses between warms.
//
// The entry is an envelope `{ v, t }` (payload + write time, epoch ms)
// stored with a plain `put`, so reads need only `get` (no metadata API).
// Keys written by this helper must not be read by anything else.
//
// Failure model: a KV read or write error never fails the request — a
// read error is a miss, a write error is ignored. A compute error on the
// inline path propagates to the handler (which answers 500 and caches
// nothing); a background refresh error is swallowed and the stale entry
// keeps serving until it expires.

import { isCacheRefresh, refreshAfterSeconds } from "./cache-refresh";

interface SwrEntry<T> {
  v: T;
  /** Epoch ms when the entry was written. */
  t: number;
}

export interface SwrCacheOptions {
  /** KV lifetime of an entry (seconds, >= 60). Keep it >= the warm interval. */
  ttlSeconds: number;
  /** Max age (seconds) a live request serves without a refresh. */
  freshSeconds: number;
  /**
   * `ExecutionContext.waitUntil` — refreshes a stale entry after the
   * response. Absent → a stale entry is refreshed inline.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Clock override for tests. */
  now?: () => number;
}

/** Where the returned value came from (exported for tests / logging). */
export type SwrSource = "fresh" | "stale" | "computed";

async function readEntry<T>(cache: KVNamespace, key: string): Promise<SwrEntry<T> | null> {
  try {
    const raw = await cache.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SwrEntry<T>>;
    if (typeof parsed.t !== "number" || !("v" in parsed)) return null;
    return parsed as SwrEntry<T>;
  } catch {
    return null;
  }
}

/** Write `value` under `key` in the swrCache envelope. Best-effort. */
export async function writeSwrEntry<T>(
  cache: KVNamespace,
  key: string,
  value: T,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<void> {
  try {
    const entry: SwrEntry<T> = { v: value, t: now };
    await cache.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, Math.ceil(ttlSeconds)) });
  } catch {
    // Non-fatal: the next request recomputes.
  }
}

/**
 * Read `key` through the stale-while-revalidate rules above, computing (and
 * storing) on a miss. Returns the payload and where it came from.
 */
export async function swrCache<T>(
  request: Request,
  cache: KVNamespace,
  key: string,
  opts: SwrCacheOptions,
  compute: () => Promise<T>,
): Promise<{ value: T; source: SwrSource }> {
  const now = opts.now ?? Date.now;
  const entry = await readEntry<T>(cache, key);
  const ageS = entry ? (now() - entry.t) / 1000 : Infinity;

  const refill = async (): Promise<T> => {
    const value = await compute();
    await writeSwrEntry(cache, key, value, opts.ttlSeconds, now());
    return value;
  };

  if (isCacheRefresh(request)) {
    // Navigator warm: refresh-ahead on the KV lifetime, not the live freshness.
    if (entry && ageS < refreshAfterSeconds(opts.ttlSeconds)) return { value: entry.v, source: "fresh" };
    return { value: await refill(), source: "computed" };
  }

  if (entry && ageS < opts.freshSeconds) return { value: entry.v, source: "fresh" };

  if (entry && opts.waitUntil) {
    opts.waitUntil(refill().catch(() => undefined));
    return { value: entry.v, source: "stale" };
  }

  return { value: await refill(), source: "computed" };
}
