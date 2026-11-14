// DMARC aggregate-report retention (B1c, review L1) — keeps the sensor's
// tables bounded at whatever the ingest caps allow.
//
// Runs on EVERY Navigator tick (every 5 min, no hour/minute gate): when
// nothing is due each phase is one indexed seek that returns nothing, so
// a tick costs 4 cheap statements; a backlog is deleted in bounded steps.
//
//   reports + records  180 days by received_at. Expired report ids are read
//                      oldest-first (idx_dmarc_reports_received), then their
//                      records (idx_drr_report) and the report rows go in ONE
//                      batch — records first (FK order), so no emptied report
//                      is ever re-scanned and no orphan records are left.
//   dmarc_source_daily 180 days by report date (idx_dmarc_source_daily_date)
//   dmarc_report_seen  DMARC_SEEN_RETENTION_DAYS (63) — longer than any
//                      acceptable replay: a report is accepted while its end
//                      date is within [now − 60 d, now + 2 d], so its dedup
//                      key (written at acceptance) must outlive end + 60 d ≤
//                      acceptance + 62 d.
//   dmarc_rate_counters  windows older than 2 days (idx_dmarc_rate_counters_period)
// dmarc_daily_stats (one row per brand-day) and dmarc_enrollment (one row
// per brand) are not swept.
//
// Throughput vs the ingest caps (lib/dmarc-enrollment.ts):
//   max ingest/day   200 verified/h × 24 = 4,800 reports × ≤1,000 records
//                    + 50 unverified/h × 24 = 1,200 reports × ≤250 records
//                    = 6,000 reports, ≤ 5.1M record rows, ≤ 1.2M new
//                    dmarc_source_daily rows (≤200 per report).
//   max sweep/day    288 ticks × 4 chunks × 10 reports = 11,520 reports
//                    (≤ 11.5M record rows); 288 × 3 × 2,000 = 1.73M source
//                    rows; 288 × 5,000 seen rows.
// So the sweep's ceiling is ~2× the ingest ceiling in every table, if each
// tick finishes its batches inside the Navigator soft cap (a tick that runs
// out of budget stops early and the next tick continues).
//
// Never throws.

import type { Env } from "../types";
import { DMARC_REPORT_DATE_WINDOW } from "./dmarc-aggregate-xml";

export const DMARC_RETENTION_DAYS = 180;
export const DMARC_SEEN_RETENTION_DAYS = DMARC_REPORT_DATE_WINDOW.pastDays + DMARC_REPORT_DATE_WINDOW.futureDays + 1;
export const DMARC_COUNTER_RETENTION_DAYS = 2;

export const DMARC_PURGE_LIMITS = {
  /** Reports deleted (with their records) per batch. */
  reportChunk: 10,
  reportBatchesPerTick: 4,
  sourceChunk: 2_000,
  sourceBatchesPerTick: 3,
  seenChunk: 5_000,
  counterChunk: 5_000,
} as const;

export interface DmarcPurgeResult {
  records_deleted: number;
  reports_deleted: number;
  sources_deleted: number;
  seen_deleted: number;
  counters_deleted: number;
  statements: number;
  more_remaining: boolean;
  error: string | null;
}

export const DMARC_EXPIRED_REPORTS_SQL = `SELECT id FROM dmarc_reports
  WHERE received_at < datetime('now', ?) ORDER BY received_at LIMIT ?`;

export const DMARC_SOURCES_PURGE_SQL = `DELETE FROM dmarc_source_daily WHERE rowid IN (
  SELECT rowid FROM dmarc_source_daily WHERE date < date('now', ?) LIMIT ?
)`;

export const DMARC_SEEN_PURGE_SQL = `DELETE FROM dmarc_report_seen WHERE rowid IN (
  SELECT rowid FROM dmarc_report_seen WHERE first_seen_at < datetime('now', ?) LIMIT ?
)`;

export const DMARC_COUNTERS_PURGE_SQL = `DELETE FROM dmarc_rate_counters WHERE rowid IN (
  SELECT rowid FROM dmarc_rate_counters WHERE period < ? LIMIT ?
)`;

const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

export async function purgeExpiredDmarcData(
  env: Pick<Env, "DB">,
  opts: { softCapMs?: number; limits?: Partial<typeof DMARC_PURGE_LIMITS>; nowMs?: number } = {},
): Promise<DmarcPurgeResult> {
  const L = { ...DMARC_PURGE_LIMITS, ...opts.limits };
  const start = Date.now();
  const db = env.DB;
  const res: DmarcPurgeResult = {
    records_deleted: 0, reports_deleted: 0, sources_deleted: 0, seen_deleted: 0, counters_deleted: 0,
    statements: 0, more_remaining: false, error: null,
  };
  const overCap = () => opts.softCapMs !== undefined && Date.now() - start > opts.softCapMs;
  const age = `-${DMARC_RETENTION_DAYS} days`;
  try {
    // Reports + their records, oldest first, in id chunks.
    for (let b = 0; b < L.reportBatchesPerTick; b++) {
      if (overCap()) { res.more_remaining = true; break; }
      const ids = ((await db.prepare(DMARC_EXPIRED_REPORTS_SQL).bind(age, L.reportChunk).all<{ id: number }>()).results ?? []).map((r) => r.id);
      res.statements++;
      if (ids.length === 0) break;
      const out = await db.batch([
        db.prepare(`DELETE FROM dmarc_report_records WHERE report_id IN (${ph(ids.length)})`).bind(...ids),
        db.prepare(`DELETE FROM dmarc_reports WHERE id IN (${ph(ids.length)})`).bind(...ids),
      ]);
      res.statements += 2;
      res.records_deleted += out[0]?.meta?.changes ?? 0;
      res.reports_deleted += out[1]?.meta?.changes ?? 0;
      if (ids.length < L.reportChunk) break;
      if (b === L.reportBatchesPerTick - 1) res.more_remaining = true;
    }

    for (let b = 0; b < L.sourceBatchesPerTick && !overCap(); b++) {
      const r = await db.prepare(DMARC_SOURCES_PURGE_SQL).bind(age, L.sourceChunk).run();
      res.statements++;
      const n = r.meta?.changes ?? 0;
      res.sources_deleted += n;
      if (n < L.sourceChunk) break;
      if (b === L.sourceBatchesPerTick - 1) res.more_remaining = true;
    }

    if (!overCap()) {
      const r = await db.prepare(DMARC_SEEN_PURGE_SQL).bind(`-${DMARC_SEEN_RETENTION_DAYS} days`, L.seenChunk).run();
      res.statements++;
      res.seen_deleted = r.meta?.changes ?? 0;
      if (res.seen_deleted >= L.seenChunk) res.more_remaining = true;
    }

    if (!overCap()) {
      // Day ('YYYY-MM-DD') and hour ('YYYY-MM-DDTHH') periods both sort
      // below the cutoff day string once they are older than it.
      const cutoff = new Date((opts.nowMs ?? Date.now()) - DMARC_COUNTER_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
      const r = await db.prepare(DMARC_COUNTERS_PURGE_SQL).bind(cutoff, L.counterChunk).run();
      res.statements++;
      res.counters_deleted = r.meta?.changes ?? 0;
      if (res.counters_deleted >= L.counterChunk) res.more_remaining = true;
    }
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err);
  }
  return res;
}
