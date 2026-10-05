// NRD retention — daily purge of old `nrd_domains` rows (tiered model).
//
// `nrd_domains` is the D1 reference table for newly-registered domains
// (feeds/nrd_hagezi.ts storeNrdReference). Since the D1 write cut
// (2026-10-05) the feed stores ONLY new NRDs byte-equal to a lookalike_domains
// or phantom_domains domain — a handful of rows a day instead of ~443K (the
// Hagezi 7-day NRD list, diffed daily); every new NRD goes to the R2 archive.
// The table is therefore small, but retention still applies: phantom-only
// rows (never brand_matched) age out, and rows stored before the cut (or by
// the feed's over-cap store-everything fallback) drain through the same
// purge. Tiered retention (owner decision 2026-10-05):
//
//   * HOT  — D1 keeps NRD_RETENTION_DAYS (30) days of rows.
//   * KEPT — rows with `brand_matched = 1` (set by the lookalike NRD matcher
//            on a hit) are NEVER purged, whatever their age.
//   * COLD — every NEW domain the feed processes (stored in D1 or not) is
//            archived, per run, to the NRD_ARCHIVE R2 bucket
//            (`daily/<registered_date>/…txt.gz`, feeds/nrd_hagezi.ts) before
//            the feed's diff snapshot advances; the binding is required, so
//            the feed fails rather than insert unarchived rows. So a purged row is preserved in R2 — EXCEPT
//            rows ingested before the archive shipped (2026-10-05), which
//            were never archived and are gone from the platform once
//            purged (their brand matches are already in `threats`).
//
// Readers and their holds:
//
// 1. Phantom matcher (lib/phantom-matcher.ts, nrd source) — manual/API
//    triggered; scans incrementally from a KV cursor
//    (PHANTOM_MATCHER_NRD_CURSOR_KEY) with `WHERE created_at >= cursor`. The
//    cursor is a "scanned up to" watermark: every row with created_at below
//    it has been covered by an incremental run. It moves ONLY when someone
//    runs the matcher incrementally. It used to be a HARD floor (no cursor →
//    purge nothing; a stale cursor → nothing newer ever purged), which with
//    a rarely-run manual matcher meant D1 grew without bound. It is now
//    CLAMPED at the age cutoff (now − NRD_RETENTION_DAYS): it may never hold
//    a row past 30 days, so in practice it never moves the cutoff — a
//    cursor newer than 30 days only covers rows the age cutoff keeps anyway,
//    and a missing or older cursor holds nothing (`phantom_hold_clamped`:
//    unscanned rows are leaving D1). Effective retention is therefore 30
//    days in the normal prod state (the manual matcher rarely runs).
//    Rationale: purged rows are in the R2 archive (see COLD above for the
//    exception), and a stuck manual matcher must not grow D1 without bound.
//    `full=1` phantom sweeps cover only the 30-day D1 window.
//
// 2. NRD <-> lookalike matcher (lib/lookalike-nrd-matcher.ts, every
//    lookalike_scanner run) — keyset cursor at LOOKALIKE_NRD_CURSOR_KEY. When
//    present, its created_at is a hold, CLAMPED to no earlier than
//    now − (NRD_MATCH_MAX_AGE_DAYS + NRD_RETENTION_HOLD_MARGIN_DAYS) = 37
//    days: rows older than that can never be claimed, and a stuck or
//    disabled matcher must not hold retention forever. With 30-day retention
//    this hold binds only when that HOURLY matcher is more than 30 days
//    behind (stuck), extending retention to at most 37 days.
//    Absent (never run) → no hold; its first run starts at now − 30 days of
//    ingest, so it never assumes a purged row still exists. Since nrd_domains
//    became sparse (only lookalike/phantom-equal NRDs), a caught-up cursor
//    can sit on an OLD row because nothing newer was ingested; the hold (and
//    `held_by_lookalike_matcher`) therefore applies only when an unscanned
//    row exists above the cursor key (NRD_RETENTION_UNSCANNED_SQL, one
//    indexed seek, only when the hold would bind).
//
// Retention rule:
//   age    = now − NRD_RETENTION_DAYS (30 days)
//   floor  = now − (NRD_MATCH_MAX_AGE_DAYS + margin) (37 days)
//   cutoff = min(age,
//                max(phantom cursor ?? age, age),   [never below age]
//                max(lookalike cursor, floor)       [only when it exists])
//   DELETE rows with created_at < cutoff AND brand_matched = 0
//     (strict <: the row AT a cursor is re-scanned by the matcher's `>=`)
// A FAILED or unrecognised cursor READ (either cursor) → purge nothing this
// run (any doubt → no delete). `held_by_matcher` / `phantom_hold_clamped` /
// `held_by_lookalike_matcher` in the KV last-result stamp (surfaced as
// `nrd_retention` in /api/internal/platform-diagnostics) show which hold set
// the cutoff.
//
// Both cursors and the age cutoff are compared as SQLite
// `YYYY-MM-DD HH:MM:SS` UTC strings — the format `datetime('now')` writes
// into created_at and the matchers copy verbatim into their cursors — so
// string order is time order.
//
// Deletes run in chunks through the PARTIAL index
// idx_nrd_domains_unmatched_created (migration 0283, `ON nrd_domains
// (created_at) WHERE brand_matched = 0`):
//   DELETE … WHERE rowid IN (SELECT rowid … WHERE created_at < ?
//                            AND brand_matched = 0
//                            ORDER BY created_at LIMIT ?)
// The `brand_matched = 0` term must stay textually identical to the index
// predicate or SQLite won't use the partial index. Through the full
// idx_nrd_domains_created (0279), the kept matched rows would sit at the
// old end of the range and every chunk would re-read all of them. 2 binds
// per statement, until a chunk deletes fewer than the chunk size or the
// soft wall-clock cap is hit (more_remaining=true; the next hour-0
// Navigator tick continues — see shouldRunNrdRetention).
//
// Never throws. Writes a JSON last-result stamp to KV (best-effort).

import type { Env } from '../types';
import { PHANTOM_MATCHER_NRD_CURSOR_KEY } from './phantom-matcher';
import {
  LOOKALIKE_NRD_CURSOR_KEY,
  NRD_MATCH_MAX_AGE_DAYS,
  NRD_RETENTION_HOLD_MARGIN_DAYS,
  parseNrdCursor,
} from './lookalike-nrd-matcher';

export const NRD_RETENTION_DAYS = 30;


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

/**
 * Why a run purged nothing. `no_cursor` is no longer produced (a missing
 * phantom cursor is now a clamped hold); it stays in the union so stamps
 * written by older deploys still parse.
 */
export type NrdRetentionSkip = 'no_cursor' | 'cursor_read_failed' | 'cursor_unrecognized';

export interface NrdRetentionResult {
  /** ISO time the run started. */
  ran_at: string;
  deleted: number;
  /** Effective cutoff (rows with created_at < cutoff deleted); null when skipped. */
  cutoff: string | null;
  /** now − NRD_RETENTION_DAYS, SQLite `YYYY-MM-DD HH:MM:SS` UTC. */
  age_cutoff: string;
  /** Phantom matcher nrd cursor as read from KV (null when absent / unreadable). */
  cursor: string | null;
  /**
   * True when the phantom matcher's hold set a cutoff earlier than the age
   * cutoff. Since the hold is clamped AT the age cutoff this is always false
   * now; kept so diagnostics and older stamps keep their shape.
   */
  held_by_matcher: boolean;
  /**
   * True when the phantom cursor is missing or older than the age cutoff
   * (now − NRD_RETENTION_DAYS), i.e. the manual matcher has not scanned the
   * rows being purged. Those rows leave D1 unscanned; post-2026-10-05 rows
   * remain in the NRD_ARCHIVE R2 bucket.
   */
  phantom_hold_clamped?: boolean;
  /**
   * created_at of the NRD <-> lookalike matcher's keyset cursor (null when
   * that matcher has never run, or its cursor is unreadable — no hold).
   */
  lookalike_cursor?: string | null;
  /** True when the lookalike matcher's cursor set the effective cutoff. */
  held_by_lookalike_matcher?: boolean;
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

/**
 * Does any nrd_domains row sit ABOVE the lookalike matcher's keyset cursor
 * (i.e. not yet scanned by it)? Same row-value seek as the matcher's window
 * probe (idx_nrd_domains_created).
 */
export const NRD_RETENTION_UNSCANNED_SQL =
  `SELECT 1 AS one FROM nrd_domains WHERE (created_at, rowid) > (?, ?) ORDER BY created_at, rowid LIMIT 1`;

/** Exported for the query-plan pin (test/nrd-retention.test.ts). */
export const NRD_RETENTION_PURGE_SQL =
  `DELETE FROM nrd_domains WHERE rowid IN (SELECT rowid FROM nrd_domains WHERE created_at < ? AND brand_matched = 0 ORDER BY created_at LIMIT ?)`;

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

  // ── 1. Phantom matcher cursor — a hold CLAMPED at the age cutoff. A
  //       failed or unrecognised read → purge nothing (any doubt → no
  //       delete). ──
  let cursor: string | null;
  try {
    cursor = await env.CACHE.get(PHANTOM_MATCHER_NRD_CURSOR_KEY);
  } catch (err) {
    result.skipped = 'cursor_read_failed';
    result.error = err instanceof Error ? err.message : String(err);
    return finish();
  }
  result.cursor = cursor;
  if (cursor && !SQLITE_TS_RE.test(cursor)) {
    // Not the created_at format we compare against; a string comparison
    // would be meaningless, so refuse rather than guess.
    result.skipped = 'cursor_unrecognized';
    return finish();
  }

  // ── 2. Effective cutoff = the earlier of age cutoff and phantom hold. ──
  // The phantom hold is clamped AT the age cutoff: a missing cursor (never
  // run incrementally) or one older than 30 days holds nothing, and a fresher
  // one only covers rows the age cutoff keeps anyway. The manual matcher
  // must not grow D1 without bound; purged rows are in the R2 archive.
  result.phantom_hold_clamped = !cursor || cursor < ageCutoff;
  const phantomHold = cursor && !result.phantom_hold_clamped ? cursor : ageCutoff;
  result.held_by_matcher = phantomHold < ageCutoff; // always false (clamped)
  let cutoff = ageCutoff;

  // ── 2b. The lookalike matcher's hold (only when it has a cursor). ──
  // A failed read here is NOT a skip: it would only make the purge less
  // conservative by its own hold, so treat it as "hold at the current
  // cutoff" — i.e. purge nothing this run, same any-doubt rule as step 1.
  let lookalikeKey: { created_at: string; rowid: number } | null = null;
  try {
    lookalikeKey = parseNrdCursor(await env.CACHE.get(LOOKALIKE_NRD_CURSOR_KEY));
  } catch (err) {
    result.skipped = 'cursor_read_failed';
    result.error = err instanceof Error ? err.message : String(err);
    return finish();
  }
  const lookalikeCursor = lookalikeKey?.created_at ?? null;
  result.lookalike_cursor = lookalikeCursor;
  result.held_by_lookalike_matcher = false;
  if (lookalikeCursor && !SQLITE_TS_RE.test(lookalikeCursor)) {
    result.skipped = 'cursor_unrecognized';
    return finish();
  }
  // CLAMPED: never hold earlier than the oldest row the matcher could still
  // claim (+ margin). A stuck or disabled matcher must not pin retention
  // forever, and a row older than this is unclaimable whether or not the
  // matcher ever reads it.
  const holdFloor = toSqliteUtc(start - (NRD_MATCH_MAX_AGE_DAYS + NRD_RETENTION_HOLD_MARGIN_DAYS) * 86_400_000);
  const lookalikeHold = lookalikeCursor && lookalikeCursor < holdFloor ? holdFloor : lookalikeCursor;
  if (lookalikeHold && lookalikeHold < cutoff && lookalikeKey) {
    // A SPARSE nrd_domains (the feed stores only lookalike/phantom-equal
    // NRDs since 2026-10-05) can leave the cursor parked on an old row
    // simply because nothing newer was ingested — the matcher is caught
    // up, not stuck, and every row is below its key and already scanned.
    // Only hold when an UNSCANNED row exists above the cursor key. One
    // keyset seek on idx_nrd_domains_created, only when the hold would
    // bind. A failed probe keeps the hold (any doubt → hold).
    let unscanned = true;
    try {
      const row = await env.DB.prepare(NRD_RETENTION_UNSCANNED_SQL)
        .bind(lookalikeKey.created_at, lookalikeKey.rowid)
        .first<{ one: number }>();
      unscanned = row !== null;
    } catch {
      unscanned = true;
    }
    if (unscanned) {
      cutoff = lookalikeHold;
      result.held_by_lookalike_matcher = true;
    }
  }
  result.cutoff = cutoff;

  // ── 3. Chunked delete through idx_nrd_domains_created (unmatched rows only). ──
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
 * the next hour-0 tick. A skipped run (cursor unreadable/unrecognised)
 * counts as done for the day.
 */
export function shouldRunNrdRetention(scheduledTime: Date, last: NrdRetentionResult | null): boolean {
  if (scheduledTime.getUTCHours() !== NRD_RETENTION_HOUR_UTC) return false;
  if (!last) return true;
  const today = scheduledTime.toISOString().slice(0, 10);
  if (last.ran_at.slice(0, 10) !== today) return true;
  return last.more_remaining || !!last.error;
}
