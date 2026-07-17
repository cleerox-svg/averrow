// Cache key versioning helper.
//
// KV doesn't support wildcard delete, so to invalidate "all cache keys
// belonging to scope X" we don't actually delete anything — we bump a
// version stored at `cache_version:${scope}`, and consumers include
// that version in their cache keys. Stale entries become unreachable
// and KV's per-key TTL eventually evicts them.
//
// Usage (read path):
//   const version = await getCacheVersion(env, 'darkweb');
//   const cacheKey = `darkweb_overview:v${version}:${scopeKey}:default`;
//
// Usage (write path, e.g. PATCH a mention):
//   await bumpCacheVersion(env, 'darkweb');
//
// Trade-off: every cached read does ONE extra KV read for the version.
// KV reads are 10M/day on the paid plan — at ~100 RPS to cached endpoints
// that's 8.6M/day, comfortable. The version key itself stays in CF's
// edge cache so reads are sub-millisecond.

import type { Env } from "../types";

const VERSION_TTL_S = 30 * 24 * 60 * 60; // 30 days

/**
 * Return the current cache version for a scope. Defaults to "0" when
 * no version has ever been written (first deploy / cold start).
 */
export async function getCacheVersion(env: Env, scope: string): Promise<string> {
  const key = `cache_version:${scope}`;
  return (await env.CACHE.get(key)) ?? "0";
}

/**
 * Bump the cache version for a scope. Uses Date.now() so concurrent
 * writers don't have to read-modify-write — the higher timestamp wins
 * naturally and any race produces a valid (newer) version.
 */
export async function bumpCacheVersion(env: Env, scope: string): Promise<void> {
  const key = `cache_version:${scope}`;
  await env.CACHE.put(key, String(Date.now()), { expirationTtl: VERSION_TTL_S });
}
