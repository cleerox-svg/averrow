/**
 * Daily Snapshot Aggregation — compute daily threat metrics per brand &
 * provider into `daily_snapshots` for trend analysis.
 *
 * Scheduled path: the dedicated `28 0,12 * * *` cron
 * (`runDailySnapshotsCron` in `handlers/dailySnapshots.ts`), with
 * `skipExisting: true` — each entity type is generated only if today has no
 * row of that type yet, so the 00:28 run does the work and the 12:28 run is
 * a near-free repair pass. Manual path: `POST /api/snapshots/generate`
 * (`handlers/threats.ts`) forces regeneration of both types.
 *
 * Consumer: Flight Control's provider-escalation watcher compares
 * `hosting_providers.active_threat_count` to YESTERDAY's provider snapshot,
 * so a missing provider row for a day silences that watcher the next day.
 *
 * NOT done here (removed 2026-10-14): the hosting_providers
 * active/total_threat_count recount. `lib/provider-counts.ts`
 * (`syncHostingProviderCounts`) is that column pair's maintained writer —
 * enrichment Stage 5 every 4h (incl. hour 0) + the admin backfill — with the
 * identical COUNT definitions. Re-running it here was four correlated
 * COUNTs over threats per provider once a day for ~0 changed rows.
 */

export type SnapshotEntityType = "brand" | "provider";

export interface SnapshotTypeResult {
  /** 'generated' = INSERT ran; 'skipped' = rows for the date already existed. */
  action: "generated" | "skipped";
  rows: number;
}

export interface GenerateSnapshotsOptions {
  /**
   * When true, each entity type is first probed with a PK-prefix
   * `SELECT 1 … LIMIT 1` and skipped if the date already has rows of that
   * type. Default false (force — the manual endpoint's semantics).
   */
  skipExisting?: boolean;
}

const BRAND_SNAPSHOT_SQL = `
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
  `;

const PROVIDER_SNAPSHOT_SQL = `
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
  `;

const SNAPSHOT_SQL: Record<SnapshotEntityType, string> = {
  brand: BRAND_SNAPSHOT_SQL,
  provider: PROVIDER_SNAPSHOT_SQL,
};

/**
 * True when `daily_snapshots` already holds at least one row of
 * `entityType` for `date`. A PK-prefix probe on (date, entity_type, …) —
 * reads one row, never scans the day's ~23K rows.
 */
export async function hasSnapshotsFor(
  db: D1Database,
  date: string,
  entityType: SnapshotEntityType,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM daily_snapshots WHERE date = ? AND entity_type = ? LIMIT 1")
    .bind(date, entityType)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * Generate (or, with `skipExisting`, repair) one entity type's snapshots
 * for `date`. A single INSERT … SELECT statement, so each type is atomic:
 * a failure leaves that type absent for the date (and the next scheduled
 * pass repairs it) rather than half-written.
 */
export async function generateSnapshotType(
  db: D1Database,
  date: string,
  entityType: SnapshotEntityType,
  opts: GenerateSnapshotsOptions = {},
): Promise<SnapshotTypeResult> {
  if (opts.skipExisting && (await hasSnapshotsFor(db, date, entityType))) {
    return { action: "skipped", rows: 0 };
  }
  const res = await db.prepare(SNAPSHOT_SQL[entityType]).bind(date, date, date).run();
  return { action: "generated", rows: res.meta.changes ?? 0 };
}

/**
 * Generate daily snapshots for a given date (defaults to today, UTC).
 * Uses INSERT OR REPLACE so a forced re-run never duplicates rows.
 * Brand first, then provider — a brand failure throws before provider
 * runs (manual endpoint semantics; the cron path isolates the two types).
 */
export async function generateDailySnapshots(
  db: D1Database,
  date?: string,
  opts: GenerateSnapshotsOptions = {},
): Promise<{ brandSnapshots: number; providerSnapshots: number }> {
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const brand = await generateSnapshotType(db, targetDate, "brand", opts);
  const provider = await generateSnapshotType(db, targetDate, "provider", opts);
  return {
    brandSnapshots: brand.rows,
    providerSnapshots: provider.rows,
  };
}
