/**
 * Daily Snapshot Aggregation — Compute daily threat metrics per brand & provider.
 *
 * Runs once daily (cron: 0 0 * * *). Aggregates threat data into
 * daily_snapshots table for trend analysis.
 */

/**
 * Generate daily snapshots for a given date (defaults to today).
 * Uses INSERT OR REPLACE to allow re-runs without duplicates.
 */
export async function generateDailySnapshots(
  db: D1Database,
  date?: string,
): Promise<{ brandSnapshots: number; providerSnapshots: number }> {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  // ─── Brand Snapshots ───────────────────────────────────────────
  const brandSnapshotsResult = await db.prepare(`
    INSERT OR REPLACE INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats, dominant_threat_type, dominant_hosting_provider)
    SELECT
      ? AS date,
      'brand' AS entity_type,
      target_brand_id AS entity_id,
      COUNT(CASE WHEN created_at >= ? AND created_at < date(?, '+1 day') THEN 1 END) AS new_threats,
      COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_threats,
      COUNT(CASE WHEN status = 'remediated' THEN 1 END) AS remediated_threats,
      (SELECT threat_type FROM threats t2
       WHERE t2.target_brand_id = threats.target_brand_id AND t2.status = 'active'
       GROUP BY threat_type ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_threat_type,
      (SELECT hp.name FROM threats t3
       JOIN hosting_providers hp ON t3.hosting_provider_id = hp.id
       WHERE t3.target_brand_id = threats.target_brand_id AND t3.status = 'active'
       GROUP BY hp.name ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_hosting_provider
    FROM threats
    WHERE target_brand_id IS NOT NULL
    GROUP BY target_brand_id
  `).bind(targetDate, targetDate, targetDate).run();

  // ─── Provider Snapshots ────────────────────────────────────────
  const providerSnapshotsResult = await db.prepare(`
    INSERT OR REPLACE INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats, dominant_threat_type)
    SELECT
      ? AS date,
      'provider' AS entity_type,
      hosting_provider_id AS entity_id,
      COUNT(CASE WHEN created_at >= ? AND created_at < date(?, '+1 day') THEN 1 END) AS new_threats,
      COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_threats,
      COUNT(CASE WHEN status = 'remediated' THEN 1 END) AS remediated_threats,
      (SELECT threat_type FROM threats t2
       WHERE t2.hosting_provider_id = threats.hosting_provider_id AND t2.status = 'active'
       GROUP BY threat_type ORDER BY COUNT(*) DESC LIMIT 1) AS dominant_threat_type
    FROM threats
    WHERE hosting_provider_id IS NOT NULL
    GROUP BY hosting_provider_id
  `).bind(targetDate, targetDate, targetDate).run();

  // ─── Update provider threat counters ───────────────────────────
  // Change-guarded: only write rows whose counts actually moved. The
  // long tail of dormant providers (stable counts) is skipped instead of
  // being rewritten daily — D1 bills no-op UPDATEs, so the guard removes
  // that churn from the write quota.
  //
  // trend_7d is deliberately NOT written here. It used to be overwritten
  // with a day-over-week delta (today's new_threats − the same day last
  // week, can be negative), which gave the column delta semantics from
  // every hour-0 run until the next NEXUS trend write, while
  // lib/provider-trends.ts (NEXUS) and
  // every reader (Cooling / accelerating / pivot, cartographer surge,
  // ops Providers) treat it as a 7-day COUNT. provider-trends.ts is now
  // its single writer. No reader needs the delta; if one ever does,
  // derive it from daily_snapshots rather than writing it into trend_7d.
  await db.prepare(`
    UPDATE hosting_providers SET
      active_threat_count = COALESCE(
        (SELECT COUNT(*) FROM threats WHERE hosting_provider_id = hosting_providers.id AND status = 'active'), 0
      ),
      total_threat_count = COALESCE(
        (SELECT COUNT(*) FROM threats WHERE hosting_provider_id = hosting_providers.id), 0
      )
    WHERE
      active_threat_count IS NOT COALESCE(
        (SELECT COUNT(*) FROM threats WHERE hosting_provider_id = hosting_providers.id AND status = 'active'), 0
      )
      OR total_threat_count IS NOT COALESCE(
        (SELECT COUNT(*) FROM threats WHERE hosting_provider_id = hosting_providers.id), 0
      )
  `).run();

  return {
    brandSnapshots: brandSnapshotsResult.meta.changes ?? 0,
    providerSnapshots: providerSnapshotsResult.meta.changes ?? 0,
  };
}
