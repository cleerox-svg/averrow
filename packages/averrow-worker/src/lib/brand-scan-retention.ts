// brand_scans retention — free-scan results are kept 90 days, then
// deleted (owner decision 2026-10-05; stated in templates/privacy.ts).
//
// Runs from Navigator's existing hour-0 maintenance block (no new cron):
// every hour-0 tick calls it, so a backlog larger than one run's cap is
// drained by the next tick. Each run is a few batched DELETEs riding
// idx_brand_scans_created_at / idx_qualified_reports_created; when nothing
// is due it costs two indexed reads (one per table). Covers every
// brand_scans row (public and staff scans).
//
// Auto-delivered reports: a scan-only qualified_reports row produced by
// the lead form (generated_by = AUTO_REPORT_GENERATED_BY) snapshots the
// scan's results (posture + registered lookalike names), so it follows
// the same 90-day rule. Identified by generated_by — no new column.
// Renewing an auto report re-snapshots its payload and resets created_at
// (handleRenewQualifiedReport), so the 90 days run from the latest
// snapshot and the purge stays a plain created_at range on the index.
// Staff-generated reports (generated_by = a user id) are sales records
// and are not touched. The public scan path writes no
// email_security_scans rows (runPublicScan / the scan-only report never
// call saveEmailSecurityScan), so there is nothing to purge there.
//
// Cached data: the only per-domain cache the scan writes is the KV
// lookalike result (`scan:lookalikes:<domain>`, lib/scan-lookalikes.ts),
// which expires after 24h — long before a row reaches 90 days — so there
// is nothing left in KV to delete here. scan_leads rows are NOT touched:
// leads are kept until the person asks us to delete them.

import type { Env } from "../types";
import { AUTO_REPORT_GENERATED_BY } from "./free-scan-view";

export const BRAND_SCAN_RETENTION_DAYS = 90;
export const BRAND_SCAN_PURGE_BATCH = 500;
export const BRAND_SCAN_PURGE_MAX_BATCHES = 10;

export interface BrandScanPurgeResult {
  /** brand_scans rows deleted. */
  deleted: number;
  /** Auto-delivered qualified_reports rows deleted. */
  reports_deleted: number;
  batches: number;
  /** The run stopped (batch/time cap) before both passes drained — more rows may be due. */
  more_remaining: boolean;
  error: string | null;
}

export const BRAND_SCAN_PURGE_SQL = `DELETE FROM brand_scans WHERE id IN (
  SELECT id FROM brand_scans WHERE created_at < datetime('now', ?) ORDER BY created_at LIMIT ?
)`;

export const AUTO_REPORT_PURGE_SQL = `DELETE FROM qualified_reports WHERE id IN (
  SELECT id FROM qualified_reports WHERE generated_by = ? AND created_at < datetime('now', ?) ORDER BY created_at LIMIT ?
)`;

export async function purgeExpiredBrandScans(
  env: Pick<Env, "DB">,
  opts: { softCapMs?: number; batchSize?: number; maxBatches?: number } = {},
): Promise<BrandScanPurgeResult> {
  const start = Date.now();
  const batchSize = opts.batchSize ?? BRAND_SCAN_PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? BRAND_SCAN_PURGE_MAX_BATCHES;
  const result: BrandScanPurgeResult = { deleted: 0, reports_deleted: 0, batches: 0, more_remaining: false, error: null };
  const age = `-${BRAND_SCAN_RETENTION_DAYS} days`;
  const overCap = () => opts.softCapMs !== undefined && Date.now() - start > opts.softCapMs;
  try {
    // Both tables share one batch budget: brand_scans first, then reports.
    let phase: "scans" | "reports" | "done" = "scans";
    while (phase !== "done" && result.batches < maxBatches && !overCap()) {
      const r = phase === "scans"
        ? await env.DB.prepare(BRAND_SCAN_PURGE_SQL).bind(age, batchSize).run()
        : await env.DB.prepare(AUTO_REPORT_PURGE_SQL).bind(AUTO_REPORT_GENERATED_BY, age, batchSize).run();
      const changes = r.meta?.changes ?? 0;
      result.batches++;
      if (phase === "scans") result.deleted += changes; else result.reports_deleted += changes;
      if (changes < batchSize) phase = phase === "scans" ? "reports" : "done";
    }
    // Stopped by the batch/time cap before both passes drained → more may be due.
    result.more_remaining = phase !== "done";
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
