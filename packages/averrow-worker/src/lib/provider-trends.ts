// Provider trend write helper.
//
// Both nexus.ts (manual / fallback) and workflows/nexusRun.ts
// (canonical workflow path) compute rolling 7d/30d threat counts
// per hosting_provider_id and write them to `hosting_providers.
// trend_{7d,30d}`. Duplicated logic was previously the dominant
// per-row UPDATE pattern in the diagnostics top-write attribution
// (~20K UPDATEs/day, every hour the workflow tick re-wrote every
// provider row regardless of whether the counts changed).
//
// This module:
//   1. Aggregates the trend counts from threat_cube_provider.
//   2. Reads back the CURRENT trend values from hosting_providers.
//   3. Skips the UPDATE for rows whose new values match the old —
//      most providers' 7d/30d counts are stable hour-over-hour, so
//      the diff filter eliminates the no-op writes.
//   4. Batches the surviving UPDATEs 20 at a time (preserves the
//      original per-batch transient-tolerance behavior).
//   5. Zeroes trend_7d / trend_30d on providers that have DROPPED OUT
//      of the 30-day cube window entirely (see STALE_TRENDS_SQL).
//
// Semantics: trend_7d / trend_30d are non-negative 7-day / 30-day
// NEW-threat COUNTS. This module is their only writer (lib/snapshots.ts
// used to overwrite trend_7d with a day-over-week delta at hour 0 —
// removed in PR-D so the column has a single meaning).
//
// Returns `{ providers_evaluated, providers_updated, providers_zeroed }`
// so the caller can log the diff ratio for observability.

export interface ProviderTrendsResult {
  providers_evaluated: number;
  providers_updated: number;
  /** Providers absent from the 30d cube window whose stale non-zero
   *  trend_7d / trend_30d were reset to 0 this run. */
  providers_zeroed: number;
}

// Step 5 — zero providers absent from the 30d cube window.
//
// Steps 1-4 only ever touch providers that APPEAR in the cube
// aggregate. A provider whose threats all aged out of the 30-day window
// is absent from it, so without this step it would keep its last
// non-zero trend_7d / trend_30d forever — surfacing as a phantom
// "Cooling" provider (/api/providers/v2?sort=cooling) or a stale
// accelerating/pivot status.
//
// Cost: the "present" set is the step-1 aggregate already in memory, so
// the 30d cube window is NOT re-scanned. The only extra read is this
// change-guarded candidate list — providers currently holding a non-zero
// trend, a set bounded by the cube's distinct-provider count plus the
// stale rows — and the absent ones are diffed out in JS. Already-zero
// dormant providers are neither read nor written.
export const STALE_TRENDS_SQL = `
  SELECT id FROM hosting_providers
  WHERE COALESCE(trend_7d, 0) != 0 OR COALESCE(trend_30d, 0) != 0
`;

/** Bind ceiling per zeroing UPDATE — under D1's 100-bound-parameter limit. */
const ZERO_CHUNK = 90;

export async function updateProviderTrends(
  db: D1Database,
): Promise<ProviderTrendsResult> {
  // 1. Aggregate from the cube (bounded by cube row count).
  const agg = await db.prepare(`
    SELECT
      hosting_provider_id,
      SUM(CASE WHEN hour_bucket >= datetime('now', '-7 days')
               THEN threat_count ELSE 0 END) as count_7d,
      SUM(CASE WHEN hour_bucket >= datetime('now', '-30 days')
               THEN threat_count ELSE 0 END) as count_30d
    FROM threat_cube_provider
    WHERE hour_bucket >= datetime('now', '-30 days')
    GROUP BY hosting_provider_id
  `).all<{
    hosting_provider_id: string;
    count_7d: number;
    count_30d: number;
  }>();

  // An EMPTY 30d cube means the cube is not populated (fresh/unbuilt
  // env) or its builders have stalled for >30 days — the builders use
  // INSERT OR REPLACE and never DELETE, so a live cube is never
  // transiently empty. Either way it is not evidence that every provider
  // went quiet: skip everything (including the step-5 zeroing) rather
  // than mass-zero the whole table and mass-rewrite it once the cube
  // recovers.
  if (agg.results.length === 0) {
    return { providers_evaluated: 0, providers_updated: 0, providers_zeroed: 0 };
  }

  // 2. Fetch current trend values in chunks (placeholder-limit safe).
  // 100 placeholders per chunk is well inside D1's max-vars ceiling
  // and keeps the read row-count comfortably small.
  const READ_CHUNK = 100;
  const current = new Map<string, { trend_7d: number; trend_30d: number }>();
  for (let i = 0; i < agg.results.length; i += READ_CHUNK) {
    const ids = agg.results.slice(i, i + READ_CHUNK).map(r => r.hosting_provider_id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT id, trend_7d, trend_30d FROM hosting_providers WHERE id IN (${placeholders})`,
    ).bind(...ids).all<{ id: string; trend_7d: number | null; trend_30d: number | null }>();
    for (const r of rows.results) {
      current.set(r.id, {
        trend_7d: r.trend_7d ?? 0,
        trend_30d: r.trend_30d ?? 0,
      });
    }
  }

  // 3. Diff filter — only keep rows whose new values differ from
  // current. A missing current row (new provider seen via the cube
  // but not yet in hosting_providers) is preserved as a write so
  // the UPDATE attempt logs visibly via meta.changes=0 rather than
  // silently dropping.
  const changed = agg.results.filter(r => {
    const cur = current.get(r.hosting_provider_id);
    if (!cur) return true;
    return cur.trend_7d !== r.count_7d || cur.trend_30d !== r.count_30d;
  });

  // 4. Batch UPDATEs 20 at a time (matches the original per-batch
  // transient tolerance — a DB hiccup affects one chunk, not all).
  let providersUpdated = 0;
  const BATCH = 20;
  for (let i = 0; i < changed.length; i += BATCH) {
    const chunk = changed.slice(i, i + BATCH);
    const stmts = chunk.map(r =>
      db.prepare(`
        UPDATE hosting_providers SET
          trend_7d = ?,
          trend_30d = ?
        WHERE id = ?
      `).bind(r.count_7d, r.count_30d, r.hosting_provider_id),
    );
    try {
      await db.batch(stmts);
      providersUpdated += chunk.length;
    } catch (batchErr) {
      console.error('[provider-trends] batch failed:', batchErr);
    }
  }

  // 5. Zero providers that fell out of the 30d window (see STALE_TRENDS_SQL).
  // Change-guarded twice over: the candidate SELECT only returns non-zero
  // rows, and the UPDATE re-checks it so a row zeroed between the read
  // and the write is not counted.
  let providersZeroed = 0;
  try {
    const present = new Set(agg.results.map(r => r.hosting_provider_id));
    const stale = await db.prepare(STALE_TRENDS_SQL).all<{ id: string }>();
    const absent = stale.results.map(r => r.id).filter(id => !present.has(id));
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < absent.length; i += ZERO_CHUNK) {
      const ids = absent.slice(i, i + ZERO_CHUNK);
      const placeholders = ids.map(() => '?').join(',');
      stmts.push(db.prepare(`
        UPDATE hosting_providers SET
          trend_7d = 0,
          trend_30d = 0
        WHERE id IN (${placeholders})
          AND (COALESCE(trend_7d, 0) != 0 OR COALESCE(trend_30d, 0) != 0)
      `).bind(...ids));
    }
    if (stmts.length > 0) {
      const results = await db.batch(stmts);
      for (const r of results) providersZeroed += r.meta?.changes ?? 0;
    }
  } catch (zeroErr) {
    console.error('[provider-trends] zero-absent update failed:', zeroErr);
  }

  return {
    providers_evaluated: agg.results.length,
    providers_updated: providersUpdated,
    providers_zeroed: providersZeroed,
  };
}
