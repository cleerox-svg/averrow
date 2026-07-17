// System metrics — TTL-backed counter cache for expensive aggregate queries.
//
// Used by Flight Control to avoid re-scanning the 174K-row threats table
// every tick for monitoring counters that drift by <0.1% per hour. The
// caller supplies a compute function and a TTL; this module handles
// freshness, writes through, and reports whether the returned value was
// served from cache (so stall detection and history writes can key off
// fresh recomputes).
//
// Note: D1 doesn't provide an atomic upsert-with-read, so a burst of
// concurrent calls on a cold key can each miss the cache and recompute
// in parallel. That's fine — INSERT OR REPLACE collapses the writes and
// the duplicate work is still bounded and strictly cheaper than the
// pre-cache baseline. No lock needed.

import type { D1Database } from '@cloudflare/workers-types';

export interface MetricResult {
  value: number;
  wasCached: boolean;
  computedAt: string;
}

/**
 * Read a metric from system_metrics if fresh, otherwise run computeFn,
 * write the result back, and return it.
 *
 * TTL is compared to the stored computed_at. A row older than ttlSeconds
 * is treated as a miss.
 */
export async function getOrComputeMetric(
  db: D1Database,
  key: string,
  ttlSeconds: number,
  computeFn: () => Promise<number>,
): Promise<MetricResult> {
  const row = await db.prepare(`
    SELECT value_int, computed_at,
           (strftime('%s','now') - strftime('%s', computed_at)) AS age_seconds
    FROM system_metrics
    WHERE metric_key = ?
  `).bind(key).first<{ value_int: number; computed_at: string; age_seconds: number }>();

  if (row && row.age_seconds < ttlSeconds) {
    return { value: row.value_int, wasCached: true, computedAt: row.computed_at };
  }

  const value = await computeFn();
  const computedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  await db.prepare(`
    INSERT INTO system_metrics (metric_key, value_int, computed_at, ttl_seconds)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(metric_key) DO UPDATE SET
      value_int = excluded.value_int,
      computed_at = excluded.computed_at,
      ttl_seconds = excluded.ttl_seconds
  `).bind(key, value, computedAt, ttlSeconds).run();

  return { value, wasCached: false, computedAt };
}
