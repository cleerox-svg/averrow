/**
 * NRD <-> lookalike matcher: registry evidence for lookalike registrations.
 *
 * ── Why ─────────────────────────────────────────────────────────────
 *
 * The DNS checker (`scanners/lookalike-domains.ts`) learns about a
 * registration only when it gets to the row. With a first-contact queue
 * of ~35K rows (of ~39K lookalike rows) drained at 30/hour, a permutation that was registered while
 * it sat in that queue reads as a first-contact BASELINE ("registered, date
 * unknown") and never produces a "newly registered" signal. Live example:
 * tp-ink.com (a Tp Link typosquat) was registered 2026-10-03, was in our
 * own `nrd_domains` from 2026-10-04, and was never checked.
 *
 * `nrd_domains` (feeds/nrd_hagezi.ts — the WhoisDS free-tier daily
 * sample, ~70K rows/day) is a list of
 * domains the registries report as NEWLY registered. Joining it to
 * `lookalike_domains` by domain turns "the checker will get to it in ~48
 * days" into "we know it was registered on <date>, check it now":
 *
 *   * `first_seen` is stamped from `nrd_domains.registered_date` (the
 *     WhoisDS list date; the ingest time when that is unparseable), with
 *     `registration_evidence = 'nrd'` (migration 0282).
 *   * `check_due_at` goes to the epoch, the front of the checker's queue
 *     (the same value the operator rescan uses). The checker then treats
 *     the row as an OBSERVED registration, not a first-contact baseline,
 *     and files the new-registration alert (see
 *     `NEW_REGISTRATION_ALERT_SEVERITY` in lib/lookalike-alert-policy.ts).
 *   * `nrd_domains.brand_matched = 1` marks the NRD row as one that hit a
 *     monitored brand's permutation. Nothing else writes that column (it
 *     was declared by the feed's lazy DDL and left at its default).
 *
 * ── When a hit counts as a NEW registration ─────────────────────────
 *
 * The claim is a guarded UPDATE:
 *
 *   WHERE id = ? AND first_seen IS NULL
 *     AND NOT (registered = 1 AND baseline_established_at IS NOT NULL
 *              AND baseline_established_at < <registration date> - 2 days)
 *
 *   * `first_seen IS NULL`: one registration date per row. A row the
 *     checker already saw appear keeps its observed date; a second NRD
 *     listing of the same domain is a no-op.
 *   * A row we had ALREADY observed registered before the NRD date
 *     existed before it was "newly registered", so the listing says
 *     nothing new about it (typically a drop-catch the checker will see as
 *     a lapse + re-registration anyway). Skipped. The comparison carries
 *     2 days of slack: the WhoisDS list date is the day the domain was
 *     PUBLISHED as new, which trails the real registration by up to a day
 *     or so, and our baseline can legitimately land in between — that row
 *     is a new registration, not a pre-existing one.
 *   * A row baselined AFTER the date (the checker reached it, saw it
 *     registered, and could not date it) IS claimed: this is exactly the
 *     row the first-contact path could not alert on.
 *
 * Hits whose registration date is older than `NRD_MATCH_MAX_AGE_DAYS` are
 * not claimed: "newly registered" a month later is not news. For the same
 * reason the FIRST run (no cursor) starts at now − NRD_MATCH_MAX_AGE_DAYS
 * of ingest time rather than at the oldest retained row: nothing older
 * could be claimed, so reading it is pure D1 spend.
 *
 * ── What this matcher does NOT catch ────────────────────────────────
 *
 * A RE-registration of a domain that is still inside NRD retention. The
 * nrd_domains insert is `INSERT OR IGNORE` on `domain`, so a second NRD
 * listing of the same name (lapse + re-registration within ~90 days)
 * writes nothing new, and this keyset never sees it. Re-registrations are
 * caught by the DNS checker's observed path instead (an answered NXDOMAIN
 * lapse followed by a 0 -> 1 transition), on the re-check cadence.
 *
 * ── Scan discipline ─────────────────────────────────────────────────
 *
 * Driven from the NRD side, because that is the side that is NEW: each
 * run reads only rows ingested since its cursor and probes
 * `lookalike_domains` by `idx_lookalike_domain` (migration 0282). The
 * cursor is a KEYSET on (`created_at`, `rowid`):
 *
 *   * `created_at` is the ingestion stamp (datetime('now') at INSERT OR
 *     IGNORE time) and is monotonic with ingestion, never backdated —
 *     same reasoning as lib/phantom-matcher.ts, which explains why the
 *     intrinsic `registered_date` cannot be a cursor.
 *   * One `storeNrdReference` batch writes ~20K rows inside a second or
 *     two, so thousands of rows share a `created_at`. `rowid` breaks the
 *     tie, which is what lets a bounded window stop in the MIDDLE of a
 *     tie group and resume exactly after it.
 *
 * `(created_at, rowid) > (?, ?)` is a row-value comparison SQLite serves as
 * a range seek on idx_nrd_domains_created (whose entries carry the rowid),
 * in index order with no temp b-tree. Pinned by EXPLAIN QUERY PLAN in
 * test/lookalike-nrd-matcher.test.ts.
 *
 * Per window: one bounded probe for the window's end key (LIMIT 1 OFFSET
 * W-1, falling back to the table's max key for a partial window), then one
 * join over (lo, hi]. Both bind 4-5 parameters (D1's limit is 100). The
 * nrd side costs ~2 index reads per row, plus one index probe into
 * lookalike_domains: ~3 reads per NRD row, ~210K/day at ~70K NRD rows a
 * day. Bounded per run by `NRD_MATCH_MAX_WINDOWS_PER_RUN` x
 * `NRD_MATCH_WINDOW_ROWS` (50K rows — the feed lands once a day, so one
 * run normally absorbs a whole day's file) and a soft wall-clock cap, so a
 * larger backlog drains over several hourly runs.
 *
 * ── Retention ───────────────────────────────────────────────────────
 *
 * lib/nrd-retention.ts reads `LOOKALIKE_NRD_CURSOR_KEY` and will not delete
 * rows at or above the cursor's `created_at` — CLAMPED to no earlier than
 * now − (NRD_MATCH_MAX_AGE_DAYS + NRD_RETENTION_HOLD_MARGIN_DAYS), because
 * rows older than that can never be claimed anyway. The clamp is what stops
 * a stuck or disabled matcher from holding retention forever. With the
 * current 90-day retention the clamped hold sits well inside the window and
 * therefore never binds; it is a guard for a future shorter retention. Every
 * row below the cursor's created_at has a smaller (created_at, rowid) key,
 * i.e. it has been scanned. If retention has purged rows below a stale
 * cursor, the next window simply starts at the oldest surviving row — the
 * matcher never assumes a purged row exists.
 *
 * Runs inside the lookalike_scanner agent (hourly `22 * * * *` cron),
 * BEFORE the DNS checker, so a row claimed this tick is checked this tick.
 * Never inside the NRD feed pull: that pull's wall-clock budget belongs to
 * the feed (an overrun is reaped and trips the feed circuit breaker,
 * CLAUDE.md §6). Never throws for a per-hit failure; a top-level throw
 * leaves the cursor at the last fully processed window.
 */

import type { Env } from "../types";

/** KV key holding the cursor as JSON `{ "created_at": string, "rowid": number }`. */
export const LOOKALIKE_NRD_CURSOR_KEY = "lookalike_nrd_matcher:cursor";

/** NRD rows per window (one end-key probe + one join). */
export const NRD_MATCH_WINDOW_ROWS = 5_000;

/** Windows one run may scan. 10 x 5,000 = 50K NRD rows per hourly run. */
export const NRD_MATCH_MAX_WINDOWS_PER_RUN = 10;

/** Soft wall-clock cap per run; checked between windows. */
export const NRD_MATCH_SOFT_CAP_MS = 20_000;

/** A registration older than this is not claimed as "new". */
export const NRD_MATCH_MAX_AGE_DAYS = 30;

/**
 * Slack, in days, on top of NRD_MATCH_MAX_AGE_DAYS before nrd-retention
 * stops honouring this matcher's cursor (ingest lag between the WhoisDS
 * list date and our created_at, plus a stalled week).
 */
export const NRD_RETENTION_HOLD_MARGIN_DAYS = 7;

/** Claim statements per `DB.batch` call. */
const CLAIM_BATCH = 50;

/** The value the operator rescan uses for "front of the queue". */
export const NRD_MATCH_PRIORITY_DUE_AT = "1970-01-01 00:00:00";

export interface NrdCursor {
  created_at: string;
  rowid: number;
}

export interface LookalikeNrdMatchResult {
  /** NRD rows in the FULL windows this run scanned (a lower bound: the final partial window is not counted). */
  nrd_rows_scanned: number;
  windows: number;
  /** (nrd row, lookalike row) pairs the join returned. */
  hits: number;
  /** Lookalike rows newly stamped with NRD registration evidence. */
  claimed: number;
  /** Hits skipped because the registration date is past NRD_MATCH_MAX_AGE_DAYS. */
  stale: number;
  /** True when the window/time cap stopped the run with rows left. */
  more_remaining: boolean;
  cursor_before: NrdCursor | null;
  cursor_after: NrdCursor | null;
  /** Per-hit write failures (counted, never thrown). */
  claim_errors: number;
}

export interface LookalikeNrdMatchOptions {
  windowRows?: number;
  maxWindows?: number;
  softCapMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
  /**
   * Session for the two READS (window probe + join). Defaults to env.DB.
   * The agent passes a read-replica session (`getReadSession`). Safe on a
   * lagging replica: a replica snapshot is a prefix of the primary's
   * commits, and every row committed after it has a LARGER (created_at,
   * rowid) key than anything the snapshot holds (created_at is
   * datetime('now') at insert, rowid is max+1), so a lagged window just
   * ends earlier and the next run continues from it. Claims and marks
   * always write through env.DB.
   */
  read?: { prepare(query: string): D1PreparedStatement };
}

/** Parse the KV cursor. Anything malformed reads as "no cursor". */
export function parseNrdCursor(raw: string | null): NrdCursor | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (
      v && typeof v === "object" &&
      typeof (v as { created_at?: unknown }).created_at === "string" &&
      typeof (v as { rowid?: unknown }).rowid === "number"
    ) {
      return { created_at: (v as NrdCursor).created_at, rowid: (v as NrdCursor).rowid };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * End key of the next full window: the W-th row after the cursor, in
 * (created_at, rowid) order. NULL when fewer than W rows remain.
 * Exported for the query-plan pin.
 */
export const NRD_WINDOW_END_SQL =
  `SELECT created_at, rowid AS rid FROM nrd_domains
    WHERE (created_at, rowid) > (?, ?)
    ORDER BY created_at, rowid
    LIMIT 1 OFFSET ?`;

/** Highest key in the table — the end of a partial (final) window. */
export const NRD_MAX_KEY_SQL =
  `SELECT created_at, rowid AS rid FROM nrd_domains
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1`;

/**
 * The join over one window (lo, hi]. CROSS JOIN pins nrd_domains as the
 * outer (driving) table so each NRD row probes lookalike_domains by
 * idx_lookalike_domain, never the reverse. Exported for the plan pin.
 */
export const NRD_LOOKALIKE_JOIN_SQL =
  `SELECT l.id AS lookalike_id, n.domain AS domain,
          COALESCE(datetime(n.registered_date), n.created_at) AS registered_at
     FROM nrd_domains n
     CROSS JOIN lookalike_domains l ON l.domain = n.domain
    WHERE (n.created_at, n.rowid) > (?, ?)
      AND (n.created_at, n.rowid) <= (?, ?)`;

/**
 * The claim. See the module header for each guard. Exported so the
 * real-SQLite test runs THIS text.
 */
export const NRD_LOOKALIKE_CLAIM_SQL =
  `UPDATE lookalike_domains
      SET first_seen = ?,
          registration_evidence = 'nrd',
          check_due_at = ?,
          updated_at = datetime('now')
    WHERE id = ?
      AND first_seen IS NULL
      AND NOT (registered = 1
               AND baseline_established_at IS NOT NULL
               AND baseline_established_at < datetime(?, '-2 days'))`;

/** Mark the NRD row as having matched a monitored brand's permutation. */
export const NRD_BRAND_MATCHED_SQL =
  `UPDATE nrd_domains SET brand_matched = 1 WHERE domain = ? AND brand_matched = 0`;

interface KeyRow { created_at: string | null; rid: number | null }
interface HitRow { lookalike_id: string; domain: string; registered_at: string | null }

/** `YYYY-MM-DD HH:MM:SS` UTC. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function keyGt(a: NrdCursor, b: NrdCursor): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.rowid > b.rowid);
}

/**
 * Run one bounded pass. Reads through `opts.read` (a replica session in
 * production — see that option for why lag is safe), writes through
 * `env.DB`.
 */
export async function runLookalikeNrdMatch(
  env: Env,
  opts: LookalikeNrdMatchOptions = {},
): Promise<LookalikeNrdMatchResult> {
  const windowRows = Math.max(1, Math.floor(opts.windowRows ?? NRD_MATCH_WINDOW_ROWS));
  const maxWindows = Math.max(1, Math.floor(opts.maxWindows ?? NRD_MATCH_MAX_WINDOWS_PER_RUN));
  const softCapMs = opts.softCapMs ?? NRD_MATCH_SOFT_CAP_MS;
  const now = opts.now ?? Date.now;
  const read = opts.read ?? env.DB;
  const start = now();
  const staleBefore = sqliteUtc(start - NRD_MATCH_MAX_AGE_DAYS * 86_400_000);

  const cursorBefore = parseNrdCursor(await env.CACHE.get(LOOKALIKE_NRD_CURSOR_KEY));
  // No cursor (first run, or an unreadable one) = start at the oldest row
  // that could still be claimed: ingested within NRD_MATCH_MAX_AGE_DAYS.
  // rowid 0 sorts below every real rowid, so the whole boundary second is
  // included.
  let lo: NrdCursor = cursorBefore ?? { created_at: staleBefore, rowid: 0 };

  const result: LookalikeNrdMatchResult = {
    nrd_rows_scanned: 0,
    windows: 0,
    hits: 0,
    claimed: 0,
    stale: 0,
    more_remaining: false,
    cursor_before: cursorBefore,
    cursor_after: cursorBefore,
    claim_errors: 0,
  };

  try {
    for (;;) {
      if (result.windows >= maxWindows || now() - start >= softCapMs) {
        result.more_remaining = true;
        break;
      }

      const full = await read.prepare(NRD_WINDOW_END_SQL)
        .bind(lo.created_at, lo.rowid, windowRows - 1)
        .first<KeyRow>();
      let hiRow = full;
      if (!hiRow) {
        hiRow = await read.prepare(NRD_MAX_KEY_SQL).first<KeyRow>();
      }
      if (!hiRow || hiRow.created_at == null || hiRow.rid == null) break;
      const hi: NrdCursor = { created_at: hiRow.created_at, rowid: Number(hiRow.rid) };
      if (!keyGt(hi, lo)) break; // nothing new since the cursor

      const hits = await read.prepare(NRD_LOOKALIKE_JOIN_SQL)
        .bind(lo.created_at, lo.rowid, hi.created_at, hi.rowid)
        .all<HitRow>();
      result.windows += 1;
      // A full window is exactly windowRows rows. A partial (final) window
      // is "the rest", which was not counted, so it adds nothing here:
      // this is a lower bound, not a guess.
      result.nrd_rows_scanned += full ? windowRows : 0;
      result.hits += hits.results.length;

      if (!(await claimHits(env, hits.results, staleBefore, result))) {
        // A claim batch failed. Do NOT advance past this window: the next
        // run re-scans it, and every claim is idempotent (first_seen IS
        // NULL guard), so a retry cannot double-stamp. A persistent
        // failure shows as claim_errors on every run, not as lost hits.
        result.more_remaining = true;
        break;
      }

      lo = hi;
      result.cursor_after = hi;
      if (!full) break; // partial window = caught up
    }
  } finally {
    if (result.cursor_after && result.cursor_after !== cursorBefore) {
      await env.CACHE.put(LOOKALIKE_NRD_CURSOR_KEY, JSON.stringify(result.cursor_after));
    }
  }

  return result;
}

async function claimHits(
  env: Env,
  hits: HitRow[],
  staleBefore: string,
  result: LookalikeNrdMatchResult,
): Promise<boolean> {
  const claims: D1PreparedStatement[] = [];
  const marks = new Set<string>();
  for (const h of hits) {
    marks.add(h.domain);
    const registeredAt = h.registered_at;
    if (!registeredAt || registeredAt < staleBefore) {
      result.stale += 1;
      continue;
    }
    claims.push(
      env.DB.prepare(NRD_LOOKALIKE_CLAIM_SQL).bind(
        registeredAt,
        NRD_MATCH_PRIORITY_DUE_AT,
        h.lookalike_id,
        registeredAt,
      ),
    );
  }
  const markStmts = [...marks].map((d) => env.DB.prepare(NRD_BRAND_MATCHED_SQL).bind(d));

  let ok = true;
  for (let i = 0; i < claims.length; i += CLAIM_BATCH) {
    try {
      const out = await env.DB.batch(claims.slice(i, i + CLAIM_BATCH));
      for (const r of out) {
        if ((r.meta?.changes ?? 0) > 0) result.claimed += 1;
      }
    } catch {
      result.claim_errors += Math.min(CLAIM_BATCH, claims.length - i);
      ok = false;
    }
  }
  for (let i = 0; i < markStmts.length; i += CLAIM_BATCH) {
    try {
      await env.DB.batch(markStmts.slice(i, i + CLAIM_BATCH));
    } catch {
      // brand_matched is a convenience flag; a failed mark costs nothing.
    }
  }
  return ok;
}
