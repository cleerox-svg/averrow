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
// close to expiry (see `refreshAfterSeconds`).
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
 * Refresh-ahead margin. A warm recomputes a key once it is within this many
 * seconds of expiry — two 15-minute warm slots, so a single skipped warm
 * (budget soft-cap, CPU cap) still leaves one more chance before the key
 * lapses. Keys whose TTL is at or below the margin recompute on every warm.
 */
export const CACHE_REFRESH_MARGIN_S = 1800;

/** Minimum entry age (s) at which a refresh warm recomputes a key with `ttlSeconds`. */
export function refreshAfterSeconds(ttlSeconds: number): number {
  return Math.max(0, ttlSeconds - CACHE_REFRESH_MARGIN_S);
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
