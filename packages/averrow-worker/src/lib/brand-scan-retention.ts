// brand_scans retention — free-scan results are kept 90 days, then
// deleted (owner decision 2026-10-05; stated in templates/privacy.ts).
//
// Runs from Navigator's existing hour-0 maintenance block (no new cron):
// every hour-0 tick calls it, so a backlog larger than one run's cap is
// drained by the next tick. Each run is a few batched DELETEs riding
// idx_brand_scans_created_at; when nothing is due it costs one indexed
// read. Covers every brand_scans row (public and staff scans).
//
// Cached data: the only per-domain cache the scan writes is the KV
// lookalike result (`scan:lookalikes:<domain>`, lib/scan-lookalikes.ts),
// which expires after 24h — long before a row reaches 90 days — so there
// is nothing left in KV to delete here. scan_leads rows are NOT touched:
// leads are kept until the person asks us to delete them.

import type { Env } from "../types";

export const BRAND_SCAN_RETENTION_DAYS = 90;
export const BRAND_SCAN_PURGE_BATCH = 500;
export const BRAND_SCAN_PURGE_MAX_BATCHES = 10;

export interface BrandScanPurgeResult {
  deleted: number;
  batches: number;
  /** A batch came back full when the run stopped — more rows are due. */
  more_remaining: boolean;
  error: string | null;
}

export const BRAND_SCAN_PURGE_SQL = `DELETE FROM brand_scans WHERE id IN (
  SELECT id FROM brand_scans WHERE created_at < datetime('now', ?) ORDER BY created_at LIMIT ?
)`;

export async function purgeExpiredBrandScans(
  env: Pick<Env, "DB">,
  opts: { softCapMs?: number; batchSize?: number; maxBatches?: number } = {},
): Promise<BrandScanPurgeResult> {
  const start = Date.now();
  const batchSize = opts.batchSize ?? BRAND_SCAN_PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? BRAND_SCAN_PURGE_MAX_BATCHES;
  const result: BrandScanPurgeResult = { deleted: 0, batches: 0, more_remaining: false, error: null };
  try {
    while (result.batches < maxBatches) {
      if (opts.softCapMs !== undefined && Date.now() - start > opts.softCapMs) break;
      const r = await env.DB.prepare(BRAND_SCAN_PURGE_SQL)
        .bind(`-${BRAND_SCAN_RETENTION_DAYS} days`, batchSize)
        .run();
      const changes = r.meta?.changes ?? 0;
      result.batches++;
      result.deleted += changes;
      result.more_remaining = changes >= batchSize;
      if (!result.more_remaining) break;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
