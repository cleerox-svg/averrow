// NRD retention — daily purge of old `nrd_domains` rows.
//
// `nrd_domains` is the reference table every newly-registered domain lands
// in (feeds/nrd_hagezi.ts storeNrdReference). A feed day is ~443K rows (the
// Hagezi 7-day NRD list, diffed daily; ~40M rows at 90 days) and nothing ever
// deleted them, so the table grew without bound.
//
// Its only reader is the phantom matcher (lib/phantom-matcher.ts, nrd
// source), which is manual/API-triggered and scans incrementally from a KV
// cursor (PHANTOM_MATCHER_NRD_CURSOR_KEY) with `WHERE created_at >= cursor`.
// The cursor is a "scanned up to" watermark: every row with created_at below
// it has been covered by an incremental run (an untruncated run advances it
// to the table's MAX(created_at) read before its join, even with zero
// matches). It moves ONLY when the matcher runs incrementally — so this
// purge is gated on the matcher having RUN since the rows arrived; if the
// matcher never runs, nothing is ever purged.
//
// Retention rule (owner decision 2026-10-04):
//   cutoff = min(now − NRD_RETENTION_DAYS, matcher cursor)
//   DELETE rows with created_at < cutoff  (strict: the row AT the cursor is
//                                          re-scanned by the matcher's `>=`)
// so a row the matcher has not yet scanned is NEVER deleted. No cursor (the
// matcher has never run incrementally) or a failed/unrecognised cursor read
// → purge nothing. If the matcher stops running, the purge holds at the
// cursor of its last incremental run; `held_by_matcher` in the KV last-result stamp (surfaced as
// `nrd_retention` in /api/internal/platform-diagnostics) makes that visible.
//
// Both the cursor and the age cutoff are compared as SQLite
// `YYYY-MM-DD HH:MM:SS` UTC strings — the format `datetime('now')` writes
// into created_at and the matcher copies verbatim into its cursor — so
// string order is time order.
//
// Deletes run in chunks through idx_nrd_domains_created (migration 0279):
//   DELETE … WHERE rowid IN (SELECT rowid … WHERE created_at < ?
//                            ORDER BY created_at LIMIT ?)
// 2 binds per statement, until a chunk deletes fewer than the chunk size or
// the soft wall-clock cap is hit (more_remaining=true; the next hour-0
// Navigator tick continues — see shouldRunNrdRetention).
//
// Never throws. Writes a JSON last-result stamp to KV (best-effort).

import type { Env } from '../types';
import { PHANTOM_MATCHER_NRD_CURSOR_KEY } from './phantom-matcher';

export const NRD_RETENTION_DAYS = 90;

/** Rows per DELETE statement. Binds are fixed at 2, so this is bounded by
 *  per-statement work, not the 100-variable ceiling. */
export const NRD_RETENTION_CHUNK_SIZE = 5_000;

/**
 * Soft wall-clock cap per run. Lower than the dns-queue reaper's 25s
 * (REAPER_SOFT_CAP_MS) because both run on the same hour-0 Navigator ticks,
 * sequentially, under Navigator's 25s soft cap. A backlog larger than one
 * run's budget continues on the next hour-0 tick (12 per day).
 */
export const NRD_RETENTION_SOFT_CAP_MS = 10_000;

/** KV key for the JSON last-result stamp (read by diagnostics + the gate). */
export const NRD_RETENTION_LAST_RESULT_KEY = 'nrd_retention:last_result';
const LAST_RESULT_TTL_SECONDS = 86_400 * 14;

/** UTC hour the Navigator gate opens (hour-only, CLAUDE.md §6 cron-audit rule). */
export const NRD_RETENTION_HOUR_UTC = 0;

const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

export type NrdRetentionSkip = 'no_cursor' | 'cursor_read_failed' | 'cursor_unrecognized';

export interface NrdRetentionResult {
  /** ISO time the run started. */
  ran_at: string;
  deleted: number;
  /** Effective cutoff (rows with created_at < cutoff deleted); null when skipped. */
  cutoff: string | null;
  /** now − NRD_RETENTION_DAYS, SQLite `YYYY-MM-DD HH:MM:SS` UTC. */
  age_cutoff: string;
  /** Matcher nrd cursor as read from KV (null when absent / unreadable). */
  cursor: string | null;
  /** True when the matcher cursor is earlier than the age cutoff. */
  held_by_matcher: boolean;
  /** True when the soft cap stopped the loop before a short chunk. */
  more_remaining: boolean;
  statements: number;
  duration_ms: number;
  skipped?: NrdRetentionSkip;
  error?: string;
}

export interface NrdRetentionOptions {
  /** Clock injection (tests). Default Date.now. */
  now?: () => number;
  chunkSize?: number;
  softCapMs?: number;
}

/** `YYYY-MM-DD HH:MM:SS` UTC — the format SQLite's datetime() emits. */
export function toSqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Exported for the query-plan pin (test/nrd-retention.test.ts). */
export const NRD_RETENTION_PURGE_SQL =
  `DELETE FROM nrd_domains WHERE rowid IN (SELECT rowid FROM nrd_domains WHERE created_at < ? ORDER BY created_at LIMIT ?)`;

export async function purgeNrdDomains(env: Env, opts: NrdRetentionOptions = {}): Promise<NrdRetentionResult> {
  const now = opts.now ?? Date.now;
  const chunkSize = Math.max(1, Math.floor(opts.chunkSize ?? NRD_RETENTION_CHUNK_SIZE));
  const softCapMs = opts.softCapMs ?? NRD_RETENTION_SOFT_CAP_MS;
  const start = now();
  const ageCutoff = toSqliteUtc(start - NRD_RETENTION_DAYS * 86_400_000);

  const result: NrdRetentionResult = {
    ran_at: new Date(start).toISOString(),
    deleted: 0,
    cutoff: null,
    age_cutoff: ageCutoff,
    cursor: null,
    held_by_matcher: false,
    more_remaining: false,
    statements: 0,
    duration_ms: 0,
  };

  const finish = async (): Promise<NrdRetentionResult> => {
    result.duration_ms = now() - start;
    try {
      await env.CACHE.put(NRD_RETENTION_LAST_RESULT_KEY, JSON.stringify(result), {
        expirationTtl: LAST_RESULT_TTL_SECONDS,
      });
    } catch {
      // Best-effort: the purge itself already happened (or was skipped).
    }
    return result;
  };

  // ── 1. Matcher cursor — the hard floor. Any doubt → purge nothing. ──
  let cursor: string | null;
  try {
    cursor = await env.CACHE.get(PHANTOM_MATCHER_NRD_CURSOR_KEY);
  } catch (err) {
    result.skipped = 'cursor_read_failed';
    result.error = err instanceof Error ? err.message : String(err);
    return finish();
  }
  result.cursor = cursor;
  if (!cursor) {
    result.skipped = 'no_cursor';
    return finish();
  }
  if (!SQLITE_TS_RE.test(cursor)) {
    // Not the created_at format we compare against; a string comparison
    // would be meaningless, so refuse rather than guess.
    result.skipped = 'cursor_unrecognized';
    return finish();
  }

  // ── 2. Effective cutoff = the earlier of age cutoff and cursor. ──
  result.held_by_matcher = cursor < ageCutoff;
  const cutoff = result.held_by_matcher ? cursor : ageCutoff;
  result.cutoff = cutoff;

  // ── 3. Chunked delete through idx_nrd_domains_created. ──
  try {
    for (;;) {
      const r = await env.DB.prepare(NRD_RETENTION_PURGE_SQL).bind(cutoff, chunkSize).run();
      result.statements++;
      const changes = Number(r.meta?.changes ?? 0);
      result.deleted += changes;
      if (changes < chunkSize) break;
      if (now() - start >= softCapMs) {
        result.more_remaining = true;
        break;
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    // A failed chunk may leave rows behind; let the gate retry.
    result.more_remaining = true;
  }

  return finish();
}

/** Parse the KV last-result stamp. Returns null for absent / malformed. */
export function parseNrdRetentionLastResult(raw: string | null): NrdRetentionResult | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && typeof (v as { ran_at?: unknown }).ran_at === 'string') {
      return v as NrdRetentionResult;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Navigator gate. Hour-only (CLAUDE.md §6 — no minute checks): opens on every
 * Navigator tick whose scheduled UTC hour is NRD_RETENTION_HOUR_UTC. Within
 * that hour it runs once per UTC day, except that a run which stopped early
 * (more_remaining — soft cap or a failed chunk) or errored is continued on
 * the next hour-0 tick. A skipped run (no cursor) counts as done for the day.
 */
export function shouldRunNrdRetention(scheduledTime: Date, last: NrdRetentionResult | null): boolean {
  if (scheduledTime.getUTCHours() !== NRD_RETENTION_HOUR_UTC) return false;
  if (!last) return true;
  const today = scheduledTime.toISOString().slice(0, 10);
  if (last.ran_at.slice(0, 10) !== today) return true;
  return last.more_remaining || !!last.error;
}
