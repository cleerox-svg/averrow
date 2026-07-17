// Cube builder — Phase 2 of the Observatory OLAP rollout.
//
// Builds one hour bucket at a time into the two cube tables:
//   - threat_cube_geo       (0.01° lat/lng grid for Observatory map/clusters/arcs)
//   - threat_cube_provider  (narrow provider aggregates, joins at query time)
//
// Both tables use INSERT OR REPLACE keyed on the full PK, so calling a builder
// repeatedly for the same hour is idempotent and safe to re-run. Partial hours
// (the currently-ticking hour) are valid inputs — each refresh just overwrites
// the rolling window.
//
// These functions are intentionally thin: they take a single hour_bucket, run
// one grouped INSERT, and return a structured result. They do NOT log to
// agent_runs. The caller (admin backfill endpoint now, Navigator refresh in
// Phase 3) owns logging and orchestration.
//
// NOTE on hour_bucket format: callers must pass 'YYYY-MM-DD HH:00:00'. The
// window computed downstream is [hour_bucket, hour_bucket + 1 hour), which
// matches SQLite's datetime() arithmetic exactly.

import type { Env } from '../types';

export interface CubeBuildResult {
  rowsWritten: number;
  durationMs: number;
  error: string | null;
}

/**
 * Compute the exclusive upper bound of a one-hour window.
 * Input  : '2026-04-11 13:00:00'
 * Output : '2026-04-11 14:00:00'
 *
 * Done in JS rather than SQL so we can bind a single literal string to both
 * the hour_bucket PK column and the WHERE range predicate.
 */
function nextHour(hourBucket: string): string {
  // Treat as UTC — D1's datetime('now') is UTC and all created_at values are
  // stored in the same UTC form.
  const iso = hourBucket.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 1);
  // Render back to 'YYYY-MM-DD HH:00:00'
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:00:00`;
}

/**
 * Probe the threats table for the "shape" of a single hour: the
 * MAX(created_at) and COUNT(*) within the hour's range. Together
 * these form a watermark that Navigator can use to detect whether
 * the hour's source data has changed since the last cube rebuild.
 *
 * Index-supported via idx_threats_created_brand /
 * idx_threats_status_created — the range scan is bounded by the
 * hour window so this stays well under per-tick budget.
 *
 * Used by Navigator to skip prev-hour cube rebuilds when the
 * source data hasn't moved (D1 write-budget Phase 1 change C —
 * cubes were the dominant write driver pre-2026-05-20, with 12
 * rebuilds per hour for each previous hour even when nothing new
 * landed for that hour).
 *
 * Format: `${max_created_at_iso}|${count}`. Both fields together
 * because COUNT alone can be unchanged if a row was inserted AND
 * an old row deleted in the same tick (rare but possible during
 * threat lifecycle transitions).
 */
export async function getCubeSourceWatermark(
  env: Env,
  hourBucket: string,
): Promise<string> {
  const windowEnd = nextHour(hourBucket);
  const probe = await env.DB.prepare(`
    SELECT MAX(created_at) AS max_ts, COUNT(*) AS n
    FROM threats
    WHERE created_at >= ? AND created_at < ?
  `).bind(hourBucket, windowEnd).first<{ max_ts: string | null; n: number }>();
  return `${probe?.max_ts ?? ''}|${probe?.n ?? 0}`;
}

/**
 * Best-effort extraction of "rows written" from a D1 run() result.
 * Newer D1 meta exposes rows_written directly; older ones only expose
 * changes. For INSERT OR REPLACE both map to the same semantic value
 * (rows affected by this statement).
 */
function extractRowsWritten(meta: D1Result['meta'] | undefined): number {
  if (!meta) return 0;
  const m = meta as { rows_written?: number; changes?: number };
  if (typeof m.rows_written === 'number') return m.rows_written;
  if (typeof m.changes === 'number') return m.changes;
  return 0;
}

/**
 * Build (or rebuild) a single hour of the geo cube.
 *
 * Window: [hourBucket, hourBucket + 1 hour)
 * Source: threats WHERE status='active' AND lat IS NOT NULL AND lng IS NOT NULL
 * Grain : (hour, round(lat,2), round(lng,2), country_code, threat_type, severity, source_feed)
 *
 * Rows with NULL country/type/severity/source_feed fall into the 'XX'/'unknown'
 * buckets rather than being dropped — we never want a NULL in a PK column.
 * Rows with NULL lat/lng are dropped entirely (not representable on the map).
 */
export async function buildGeoCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    // PR-BO: UPSERT WITH WHERE — skip the row mutation when threat_count
    // is unchanged. INSERT OR REPLACE was billing 1 row written per
    // existing bucket on every Navigator tick (12×/hour for the
    // current hour); UPSERT with the IS-NOT guard drops that to 0 rows
    // written for stable buckets, only mutating when the count moves.
    const result = await env.DB.prepare(`
      INSERT INTO threat_cube_geo
        (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity,
         source_feed, threat_count, updated_at)
      SELECT
        ?1,
        ROUND(lat * 100) / 100.0,
        ROUND(lng * 100) / 100.0,
        COALESCE(country_code, 'XX'),
        COALESCE(threat_type, 'unknown'),
        COALESCE(severity, 'unknown'),
        COALESCE(source_feed, 'unknown'),
        COUNT(*),
        datetime('now')
      FROM threats
      WHERE created_at >= ?2
        AND created_at < ?3
        AND status = 'active'
        AND lat IS NOT NULL
        AND lng IS NOT NULL
      GROUP BY 2, 3, 4, 5, 6, 7
      ON CONFLICT(hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed)
      DO UPDATE SET
        threat_count = excluded.threat_count,
        updated_at = excluded.updated_at
      WHERE threat_cube_geo.threat_count IS NOT excluded.threat_count
    `).bind(hourBucket, hourBucket, windowEnd).run();

    return {
      rowsWritten: extractRowsWritten(result.meta),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build (or rebuild) a single hour of the provider cube.
 *
 * Window: [hourBucket, hourBucket + 1 hour)
 * Source: threats WHERE status='active' AND hosting_provider_id IS NOT NULL
 * Grain : (hour, hosting_provider_id, threat_type, severity, source_feed)
 *
 * Rows with NULL hosting_provider_id are dropped entirely (not useful for
 * provider analytics). Other nullable columns fall into the 'unknown' bucket.
 */
export async function buildProviderCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    // PR-BO: UPSERT WITH WHERE — see buildGeoCubeForHour rationale.
    const result = await env.DB.prepare(`
      INSERT INTO threat_cube_provider
        (hour_bucket, hosting_provider_id, threat_type, severity, source_feed,
         threat_count, updated_at)
      SELECT
        ?1,
        hosting_provider_id,
        COALESCE(threat_type, 'unknown'),
        COALESCE(severity, 'unknown'),
        COALESCE(source_feed, 'unknown'),
        COUNT(*),
        datetime('now')
      FROM threats
      WHERE created_at >= ?2
        AND created_at < ?3
        AND status = 'active'
        AND hosting_provider_id IS NOT NULL
      GROUP BY 2, 3, 4, 5
      ON CONFLICT(hour_bucket, hosting_provider_id, threat_type, severity, source_feed)
      DO UPDATE SET
        threat_count = excluded.threat_count,
        updated_at = excluded.updated_at
      WHERE threat_cube_provider.threat_count IS NOT excluded.threat_count
    `).bind(hourBucket, hourBucket, windowEnd).run();

    return {
      rowsWritten: extractRowsWritten(result.meta),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dry-run equivalent of buildGeoCubeForHour — returns the number of grouped
 * rows the INSERT would produce for this hour, without writing anything.
 * Used by the backfill endpoint's dry_run mode to size the backfill before
 * committing to it.
 */
export async function countGeoCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult & { groupedRows: number }> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1
        FROM threats
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND lat IS NOT NULL
          AND lng IS NOT NULL
        GROUP BY
          ROUND(lat * 100) / 100.0,
          ROUND(lng * 100) / 100.0,
          COALESCE(country_code, 'XX'),
          COALESCE(threat_type, 'unknown'),
          COALESCE(severity, 'unknown'),
          COALESCE(source_feed, 'unknown')
      )
    `).bind(hourBucket, windowEnd).first<{ n: number }>();

    return {
      rowsWritten: 0,
      groupedRows: row?.n ?? 0,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      groupedRows: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dry-run equivalent of buildProviderCubeForHour — see countGeoCubeForHour.
 */
export async function countProviderCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult & { groupedRows: number }> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1
        FROM threats
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND hosting_provider_id IS NOT NULL
        GROUP BY
          hosting_provider_id,
          COALESCE(threat_type, 'unknown'),
          COALESCE(severity, 'unknown'),
          COALESCE(source_feed, 'unknown')
      )
    `).bind(hourBucket, windowEnd).first<{ n: number }>();

    return {
      rowsWritten: 0,
      groupedRows: row?.n ?? 0,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      groupedRows: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build (or rebuild) a single hour of the brand cube.
 *
 * Window: [hourBucket, hourBucket + 1 hour)
 * Source: threats WHERE status='active' AND target_brand_id IS NOT NULL
 * Grain : (hour, target_brand_id, threat_type, severity, source_feed)
 *
 * Rows with NULL target_brand_id are dropped entirely (not useful for
 * brand analytics). Other nullable columns fall into the 'unknown' bucket.
 */
export async function buildBrandCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    // PR-BO: UPSERT WITH WHERE — see buildGeoCubeForHour rationale.
    const result = await env.DB.prepare(`
      INSERT INTO threat_cube_brand
        (hour_bucket, target_brand_id, threat_type, severity, source_feed,
         threat_count, updated_at)
      SELECT
        ?1,
        target_brand_id,
        COALESCE(threat_type, 'unknown'),
        COALESCE(severity, 'unknown'),
        COALESCE(source_feed, 'unknown'),
        COUNT(*),
        datetime('now')
      FROM threats
      WHERE created_at >= ?2
        AND created_at < ?3
        AND status = 'active'
        AND target_brand_id IS NOT NULL
      GROUP BY 2, 3, 4, 5
      ON CONFLICT(hour_bucket, target_brand_id, threat_type, severity, source_feed)
      DO UPDATE SET
        threat_count = excluded.threat_count,
        updated_at = excluded.updated_at
      WHERE threat_cube_brand.threat_count IS NOT excluded.threat_count
    `).bind(hourBucket, hourBucket, windowEnd).run();

    return {
      rowsWritten: extractRowsWritten(result.meta),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dry-run equivalent of buildBrandCubeForHour — see countGeoCubeForHour.
 */
export async function countBrandCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult & { groupedRows: number }> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1
        FROM threats
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND target_brand_id IS NOT NULL
        GROUP BY
          target_brand_id,
          COALESCE(threat_type, 'unknown'),
          COALESCE(severity, 'unknown'),
          COALESCE(source_feed, 'unknown')
      )
    `).bind(hourBucket, windowEnd).first<{ n: number }>();

    return {
      rowsWritten: 0,
      groupedRows: row?.n ?? 0,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      groupedRows: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build (or rebuild) a single hour of the status cube.
 *
 * Window: [hourBucket, hourBucket + 1 hour)
 * Source: threats — NO status filter, NO dimension NOT NULL filter.
 * Grain : (hour, threat_type, severity, source_feed, status)
 *
 * This is the "no exclusions" cube: every threats row in the window
 * appears here. Used by Group 3 callers that need true totals
 * (COUNT(*), COUNT(*) WHERE status='active', COUNT(DISTINCT threat_type),
 * GROUP BY threat_type) without paying the read cost of scanning
 * the threats OLTP table.
 *
 * Status is mutable, so the rolling 5-min refresh keeps the most-recent
 * 2 hours fresh and the 6h cube-healer rebuild reconciles the 30-day
 * tail. Lag for older hours is up to 6 hours.
 */
export async function buildStatusCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    // PR-BO: UPSERT WITH WHERE — see buildGeoCubeForHour rationale.
    const result = await env.DB.prepare(`
      INSERT INTO threat_cube_status
        (hour_bucket, threat_type, severity, source_feed, status,
         threat_count, updated_at)
      SELECT
        ?1,
        COALESCE(threat_type, 'unknown'),
        COALESCE(severity, 'unknown'),
        COALESCE(source_feed, 'unknown'),
        COALESCE(status, 'unknown'),
        COUNT(*),
        datetime('now')
      FROM threats
      WHERE created_at >= ?2
        AND created_at < ?3
      GROUP BY 2, 3, 4, 5
      ON CONFLICT(hour_bucket, threat_type, severity, source_feed, status)
      DO UPDATE SET
        threat_count = excluded.threat_count,
        updated_at = excluded.updated_at
      WHERE threat_cube_status.threat_count IS NOT excluded.threat_count
    `).bind(hourBucket, hourBucket, windowEnd).run();

    return {
      rowsWritten: extractRowsWritten(result.meta),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dry-run equivalent of buildStatusCubeForHour — see countGeoCubeForHour.
 */
export async function countStatusCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult & { groupedRows: number }> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1
        FROM threats
        WHERE created_at >= ?1
          AND created_at < ?2
        GROUP BY
          COALESCE(threat_type, 'unknown'),
          COALESCE(severity, 'unknown'),
          COALESCE(source_feed, 'unknown'),
          COALESCE(status, 'unknown')
      )
    `).bind(hourBucket, windowEnd).first<{ n: number }>();

    return {
      rowsWritten: 0,
      groupedRows: row?.n ?? 0,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      groupedRows: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Brand-keyed summary tables ──────────────────────────────────
//
// Different shape from the hour-bucketed cubes above: dark-web and app-store
// handlers query "all active mentions per brand" with no time slice, so the
// summary table holds one row per brand (not per hour × brand) — minimum-
// work answer for the read pattern. INSERT OR REPLACE on brand_id keeps
// rebuilds idempotent.

export async function buildDarkWebBrandSummary(env: Env): Promise<CubeBuildResult> {
  const start = Date.now();
  try {
    // Write-quota note: was INSERT OR REPLACE (DELETE+INSERT every brand
    // row each 6h rebuild, billed even when unchanged). Now a guarded
    // upsert — a brand whose counts didn't move between rebuilds is not
    // rewritten. updated_at is left out of the WHERE so it only refreshes
    // when a real data column changed. Same pattern as the threat cubes.
    const result = await env.DB.prepare(`
      INSERT INTO dark_web_brand_summary
        (brand_id, total_active,
         confirmed_active, suspicious_active,
         critical_active, high_active, medium_active, low_active,
         updated_at)
      SELECT
        brand_id,
        COUNT(*),
        SUM(CASE WHEN classification = 'confirmed' THEN 1 ELSE 0 END),
        SUM(CASE WHEN classification = 'suspicious' THEN 1 ELSE 0 END),
        SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END),
        SUM(CASE WHEN severity = 'HIGH' THEN 1 ELSE 0 END),
        SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END),
        SUM(CASE WHEN severity = 'LOW' THEN 1 ELSE 0 END),
        datetime('now')
      FROM dark_web_mentions
      WHERE status = 'active' AND brand_id IS NOT NULL
      GROUP BY brand_id
      ON CONFLICT(brand_id) DO UPDATE SET
        total_active      = excluded.total_active,
        confirmed_active  = excluded.confirmed_active,
        suspicious_active = excluded.suspicious_active,
        critical_active   = excluded.critical_active,
        high_active       = excluded.high_active,
        medium_active     = excluded.medium_active,
        low_active        = excluded.low_active,
        updated_at        = excluded.updated_at
      WHERE dark_web_brand_summary.total_active      IS NOT excluded.total_active
         OR dark_web_brand_summary.confirmed_active  IS NOT excluded.confirmed_active
         OR dark_web_brand_summary.suspicious_active IS NOT excluded.suspicious_active
         OR dark_web_brand_summary.critical_active   IS NOT excluded.critical_active
         OR dark_web_brand_summary.high_active       IS NOT excluded.high_active
         OR dark_web_brand_summary.medium_active     IS NOT excluded.medium_active
         OR dark_web_brand_summary.low_active        IS NOT excluded.low_active
    `).run();

    return {
      rowsWritten: extractRowsWritten(result.meta),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function buildAppStoreBrandSummary(env: Env): Promise<CubeBuildResult> {
  const start = Date.now();
  try {
    // Write-quota note: was INSERT OR REPLACE (full-table DELETE+INSERT
    // every 6h, billed even when unchanged). Now a guarded upsert keyed on
    // brand_id — unchanged brands are skipped. updated_at refreshes only
    // when a data column actually moved. Mirrors the threat-cube pattern.
    const result = await env.DB.prepare(`
      INSERT INTO app_store_brand_summary
        (brand_id, total_active,
         impersonation_active, suspicious_active, legitimate_active, official_active,
         critical_active, high_active,
         updated_at)
      SELECT
        brand_id,
        COUNT(*),
        SUM(CASE WHEN classification = 'impersonation' THEN 1 ELSE 0 END),
        SUM(CASE WHEN classification = 'suspicious'   THEN 1 ELSE 0 END),
        SUM(CASE WHEN classification = 'legitimate'   THEN 1 ELSE 0 END),
        SUM(CASE WHEN classification = 'official'     THEN 1 ELSE 0 END),
        SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END),
        SUM(CASE WHEN severity = 'HIGH'     THEN 1 ELSE 0 END),
        datetime('now')
      FROM app_store_listings
      WHERE status = 'active' AND brand_id IS NOT NULL
      GROUP BY brand_id
      ON CONFLICT(brand_id) DO UPDATE SET
        total_active         = excluded.total_active,
        impersonation_active = excluded.impersonation_active,
        suspicious_active    = excluded.suspicious_active,
        legitimate_active    = excluded.legitimate_active,
        official_active      = excluded.official_active,
        critical_active      = excluded.critical_active,
        high_active          = excluded.high_active,
        updated_at           = excluded.updated_at
      WHERE app_store_brand_summary.total_active         IS NOT excluded.total_active
         OR app_store_brand_summary.impersonation_active IS NOT excluded.impersonation_active
         OR app_store_brand_summary.suspicious_active    IS NOT excluded.suspicious_active
         OR app_store_brand_summary.legitimate_active    IS NOT excluded.legitimate_active
         OR app_store_brand_summary.official_active      IS NOT excluded.official_active
         OR app_store_brand_summary.critical_active      IS NOT excluded.critical_active
         OR app_store_brand_summary.high_active          IS NOT excluded.high_active
    `).run();

    return {
      rowsWritten: extractRowsWritten(result.meta),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build (or rebuild) a single hour of the arcs cube.
 *
 * Window: [hourBucket, hourBucket + 1 hour)
 * Source: threats WHERE status='active'
 *                   AND target_brand_id IS NOT NULL
 *                   AND lat IS NOT NULL AND lng IS NOT NULL
 * Grain : (hour, country_code, target_brand_id, threat_type, severity, source_feed)
 *
 * Aggregates `threat_count`, `source_lat`, `source_lng` (centroid of
 * attacking IPs in the country bucket — better than the previous arcs
 * SQL's arbitrary-pick), `first_seen` (MIN created_at), `last_seen`
 * (MAX created_at).
 *
 * Replaces the per-request 43K-row scan in handleObservatoryArcs +
 * handleObservatoryBrandArcs with a single index lookup against this cube.
 */
export async function buildArcsCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    // PR-BO: UPSERT WITH WHERE — arcs is the heaviest cube writer
    // (134K rows/day pre-PR-BO). Most buckets in the prev-hour window
    // are stable, so the WHERE-skip drops mutations dramatically.
    const result = await env.DB.prepare(`
      INSERT INTO threat_cube_arcs
        (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed,
         threat_count, source_lat, source_lng, first_seen, last_seen, updated_at)
      SELECT
        ?1,
        COALESCE(country_code, 'XX'),
        target_brand_id,
        COALESCE(threat_type, 'unknown'),
        COALESCE(severity, 'unknown'),
        COALESCE(source_feed, 'unknown'),
        COUNT(*),
        ROUND(AVG(lat), 1),
        ROUND(AVG(lng), 1),
        MIN(created_at),
        MAX(created_at),
        datetime('now')
      FROM threats
      WHERE created_at >= ?2
        AND created_at < ?3
        AND status = 'active'
        AND lat IS NOT NULL
        AND lng IS NOT NULL
        AND target_brand_id IS NOT NULL
      GROUP BY 2, 3, 4, 5, 6
      ON CONFLICT(hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed)
      DO UPDATE SET
        threat_count = excluded.threat_count,
        source_lat = excluded.source_lat,
        source_lng = excluded.source_lng,
        first_seen = excluded.first_seen,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
      WHERE threat_cube_arcs.threat_count IS NOT excluded.threat_count
         OR threat_cube_arcs.last_seen IS NOT excluded.last_seen
         OR threat_cube_arcs.source_lat IS NOT excluded.source_lat
         OR threat_cube_arcs.source_lng IS NOT excluded.source_lng
    `).bind(hourBucket, hourBucket, windowEnd).run();

    return {
      rowsWritten: extractRowsWritten(result.meta),
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dry-run equivalent of buildArcsCubeForHour — see countGeoCubeForHour.
 */
export async function countArcsCubeForHour(
  env: Env,
  hourBucket: string,
): Promise<CubeBuildResult & { groupedRows: number }> {
  const start = Date.now();
  try {
    const windowEnd = nextHour(hourBucket);
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1
        FROM threats
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND lat IS NOT NULL
          AND lng IS NOT NULL
          AND target_brand_id IS NOT NULL
        GROUP BY
          COALESCE(country_code, 'XX'),
          target_brand_id,
          COALESCE(threat_type, 'unknown'),
          COALESCE(severity, 'unknown'),
          COALESCE(source_feed, 'unknown')
      )
    `).bind(hourBucket, windowEnd).first<{ n: number }>();

    return {
      rowsWritten: 0,
      groupedRows: row?.n ?? 0,
      durationMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      rowsWritten: 0,
      groupedRows: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
