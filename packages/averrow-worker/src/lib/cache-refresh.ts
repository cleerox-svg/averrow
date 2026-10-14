// Cache-refresh marker for Navigator's KV pre-warm.
//
// Navigator warms page-load caches by calling handlers in-process with a
// synthetic Request. A handler that only checks `CACHE.get` returns the
// cached payload on a hit, so a warm never REFRESHES a key — it only fills
// misses, and the live client then hits the cold gap whenever the TTL
// lapses between warms.
//
// A handler that honours `isCacheRefresh(request)` treats the warm as a
// refresh-ahead: it recomputes and rewrites the key once the entry is
// close to expiry (see `refreshAfterSeconds`). Navigator marks warms only
// while the D1 read budget is under its soft-cap; over it, warms are plain
// fill-on-miss requests and never force a recompute.
//
// Spoofing: the marker is a module-private WeakSet keyed on the Request
// OBJECT, not a header or query param. Only Worker code that imports this
// module and holds the exact Request instance can mark it; a request that
// arrives over HTTP is a fresh object the set has never seen, so no
// external caller can force a recompute. (A header would be trivially
// forgeable; an internal-secret header would be safe but needlessly puts
// the secret on synthetic requests.) The WeakSet lets marked requests be
// garbage-collected normally.

const refreshRequests = new WeakSet<Request>();

/** Mark an in-process synthetic request as a cache refresh. Returns it. */
export function markCacheRefresh(request: Request): Request {
  refreshRequests.add(request);
  return request;
}

/** True only for a Request object passed through `markCacheRefresh`. */
export function isCacheRefresh(request: Request): boolean {
  return refreshRequests.has(request);
}

/**
 * Upper bound on the refresh-ahead margin: two 15-minute warm slots, so a
 * single skipped warm (CPU cap) still leaves one more chance before a long
 * key lapses.
 */
export const CACHE_REFRESH_MARGIN_S = 1800;

/**
 * Refresh-ahead margin for a key with `ttlSeconds`: min(1800, ttl/2). A warm
 * recomputes only once the key's REMAINING TTL drops below this margin.
 *
 * The margin is relative so a short key is not recomputed on every warm: a
 * fixed 1800s margin on a 900s key made every warm a recompute (worse than
 * the old fill-on-miss). With ttl/2, a key warmed every W seconds recomputes
 * on roughly every other warm when ttl ≈ 3W (e.g. 1800s TTL on the 10-min
 * Phase A warm: hit at age 600s, refresh at age 1200s, never lapses), and
 * long keys (arcs, 7200s) still get the full 1800s safety margin.
 */
export function refreshMarginSeconds(ttlSeconds: number): number {
  return Math.min(CACHE_REFRESH_MARGIN_S, ttlSeconds / 2);
}

/** Minimum entry age (s) at which a refresh warm recomputes a key with `ttlSeconds`. */
export function refreshAfterSeconds(ttlSeconds: number): number {
  return Math.max(0, ttlSeconds - refreshMarginSeconds(ttlSeconds));
}

/** Metadata stored alongside a refreshable KV entry. */
export interface CacheStampMetadata {
  cachedAt: number;
}

/**
 * Read a page-load cache key. Live requests read it plainly. A refresh warm
 * reads it with metadata and reports a miss once the entry is old enough to
 * refresh (or carries no stamp — written before this change).
 */
export async function readRefreshableCache(
  request: Request,
  cache: KVNamespace,
  key: string,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<string | null> {
  if (!isCacheRefresh(request)) return cache.get(key);
  const { value, metadata } = await cache.getWithMetadata<CacheStampMetadata>(key);
  if (value === null) return null;
  const cachedAt = metadata?.cachedAt;
  if (typeof cachedAt !== "number") return null;
  const ageS = (now - cachedAt) / 1000;
  return ageS < refreshAfterSeconds(ttlSeconds) ? value : null;
}

/** Write a page-load cache key with the stamp `readRefreshableCache` checks. */
export async function writeRefreshableCache(
  cache: KVNamespace,
  key: string,
  data: unknown,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<void> {
  const metadata: CacheStampMetadata = { cachedAt: now };
  await cache.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds, metadata });
}
