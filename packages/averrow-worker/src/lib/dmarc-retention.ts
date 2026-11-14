// DMARC aggregate-report retention (B1c) — keeps the sensor's tables from
// growing without bound. Runs from Navigator's existing UTC-hour-0 block
// (hour-only gate, no new cron); a backlog over one run's batch cap drains
// on the next hour-0 tick. Same shape as lib/brand-scan-retention.ts.
//
//   dmarc_report_records  180 days (by the parent report's received_at;
//                         idx_dmarc_reports_received → idx_drr_report)
//   dmarc_reports         180 days, once its records are gone
//   dmarc_source_daily    180 days by report date (idx_dmarc_source_daily_date)
//   dmarc_report_seen     61 days (idx_dmarc_report_seen_first_seen) — longer
//                         than the 60-day report-date window
//                         (DMARC_REPORT_DATE_WINDOW.pastDays), so a dedup key
//                         outlives any report day it could collide with.
// dmarc_daily_stats (one row per brand-day) and dmarc_enrollment (one row
// per brand) are not swept.
//
// When nothing is due a run costs four indexed reads. Never throws.

import type { Env } from "../types";
import { DMARC_REPORT_DATE_WINDOW } from "./dmarc-aggregate-xml";

export const DMARC_RETENTION_DAYS = 180;
export const DMARC_SEEN_RETENTION_DAYS = DMARC_REPORT_DATE_WINDOW.pastDays + 1;
export const DMARC_PURGE_BATCH = 500;
export const DMARC_PURGE_MAX_BATCHES = 12;

export interface DmarcPurgeResult {
  records_deleted: number;
  reports_deleted: number;
  sources_deleted: number;
  seen_deleted: number;
  batches: number;
  more_remaining: boolean;
  error: string | null;
}

export const DMARC_RECORDS_PURGE_SQL = `DELETE FROM dmarc_report_records WHERE id IN (
  SELECT rr.id FROM dmarc_reports dr CROSS JOIN dmarc_report_records rr ON rr.report_id = dr.id
  WHERE dr.received_at < datetime('now', ?) LIMIT ?
)`;

export const DMARC_REPORTS_PURGE_SQL = `DELETE FROM dmarc_reports WHERE id IN (
  SELECT dr.id FROM dmarc_reports dr
  WHERE dr.received_at < datetime('now', ?)
    AND NOT EXISTS (SELECT 1 FROM dmarc_report_records rr WHERE rr.report_id = dr.id)
  LIMIT ?
)`;

export const DMARC_SOURCES_PURGE_SQL = `DELETE FROM dmarc_source_daily WHERE rowid IN (
  SELECT rowid FROM dmarc_source_daily WHERE date < date('now', ?) LIMIT ?
)`;

export const DMARC_SEEN_PURGE_SQL = `DELETE FROM dmarc_report_seen WHERE rowid IN (
  SELECT rowid FROM dmarc_report_seen WHERE first_seen_at < datetime('now', ?) LIMIT ?
)`;

type Phase = "records" | "reports" | "sources" | "seen" | "done";
const NEXT: Record<Exclude<Phase, "done">, Phase> = { records: "reports", reports: "sources", sources: "seen", seen: "done" };

export async function purgeExpiredDmarcData(
  env: Pick<Env, "DB">,
  opts: { softCapMs?: number; batchSize?: number; maxBatches?: number } = {},
): Promise<DmarcPurgeResult> {
  const start = Date.now();
  const batchSize = opts.batchSize ?? DMARC_PURGE_BATCH;
  const maxBatches = opts.maxBatches ?? DMARC_PURGE_MAX_BATCHES;
  const res: DmarcPurgeResult = {
    records_deleted: 0, reports_deleted: 0, sources_deleted: 0, seen_deleted: 0,
    batches: 0, more_remaining: false, error: null,
  };
  const age = `-${DMARC_RETENTION_DAYS} days`;
  const seenAge = `-${DMARC_SEEN_RETENTION_DAYS} days`;
  const overCap = () => opts.softCapMs !== undefined && Date.now() - start > opts.softCapMs;
  let phase: Phase = "records";
  try {
    while (phase !== "done" && res.batches < maxBatches && !overCap()) {
      const sql = phase === "records" ? DMARC_RECORDS_PURGE_SQL
        : phase === "reports" ? DMARC_REPORTS_PURGE_SQL
        : phase === "sources" ? DMARC_SOURCES_PURGE_SQL
        : DMARC_SEEN_PURGE_SQL;
      const r = await env.DB.prepare(sql).bind(phase === "seen" ? seenAge : age, batchSize).run();
      const changes = r.meta?.changes ?? 0;
      res.batches++;
      if (phase === "records") res.records_deleted += changes;
      else if (phase === "reports") res.reports_deleted += changes;
      else if (phase === "sources") res.sources_deleted += changes;
      else res.seen_deleted += changes;
      if (changes < batchSize) phase = NEXT[phase];
    }
    res.more_remaining = phase !== "done";
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err);
  }
  return res;
}
