// DNS Queue Reconciler — cursor-paginated incremental enqueue.
//
// Mirrors the "needs DNS resolution" subset of the threats table into
// the dedicated `trust-radar-dns-queue` D1 (binding DNS_QUEUE_DB).
// Runs every Navigator tick (5 min).
//
// ── Architecture (PR-BI, 2026-05-19) ────────────────────────────
//
// Previous design (PR-2 → PR-4): every tick scanned the FULL
// threats candidate set (~83K rows) AND the full dns_queue
// (~83K rows), JS set-diffed to find rows to add/remove. Cost:
// 15M reads/day on the main DB. Inherent to the scan, not
// reducible by indexes.
//
// New design: per-tick reconciler reads only THREATS ADDED SINCE
// LAST CURSOR (typically ~37 rows per 5-min tick at current
// inflow). Stale removal moves to a once-per-day "reaper" run.
//
// Reads/day after PR-BI:
//   - 288 reconciler ticks × ~37 rows = ~10,700 (was 15M)
//   - 1 daily reaper × ~83K rows      = ~83,000
//   - Total: ~94K reads/day (99.4% reduction)
//
// ── Mechanics ──
//
//   Cursor (keyset on (created_at, rowid) — 2026-10-12 fix):
//     KV key `reconciler:dns_queue:cursor`, JSON
//     `{"created_at":"YYYY-MM-DD HH:MM:SS","rowid":N}`. The legacy
//     value (a bare timestamp, written before this fix) still parses —
//     as `{created_at: <ts>, rowid: 0}`, i.e. "every row of that
//     second", exactly the old `>= cursor` semantics.
//
//     WHY: the old cursor read `created_at >= cursor ORDER BY
//     created_at LIMIT 500` and only advanced when MAX(created_at) of
//     the page was strictly greater than the cursor. Feeds insert via
//     db.batch() with `datetime('now')`, so a whole bulk chunk shares
//     ONE created_at second. Once ≥500 candidate rows shared the
//     cursor's second, every tick re-read the same 500 rows (all
//     already queued → enqueued≈0), MAX(created_at) == cursor, and the
//     cursor froze forever (2026-10-06 incident: lag grew 1:1 with
//     wall clock for 6 days while ~51K candidates piled up behind it).
//
//     Each tick now reads, in key order:
//       Q1  the rest of the cursor's own second:
//             created_at = c AND rowid > r ORDER BY rowid
//           → SEARCH idx_threats_status_created (status=? AND
//             created_at=? AND rowid>?) — an exact seek, no re-read.
//       Q2  (only if Q1 didn't fill the page) later seconds:
//             created_at > c ORDER BY created_at, rowid
//           → SEARCH idx_threats_status_created (status=? AND
//             created_at>?) + "TEMP B-TREE FOR LAST TERM OF ORDER BY"
//             (a per-second rowid sort; LIMIT still stops after the
//             second containing the 500th row).
//     The row-value form `(created_at, rowid) > (?, ?)` is NOT used:
//     SQLite only range-seeks its first column and then walks the
//     cursor's whole second again on every page. EXPLAIN pinned in
//     test/dns-queue-reconciler.test.ts. No new index needed —
//     rowid is the implicit trailing key of idx_threats_status_created.
//
//     The cursor advances to the (created_at, rowid) of the last row
//     processed. Every row returned is strictly past the cursor, so a
//     non-empty page ALWAYS makes progress. Rows inserted later in the
//     cursor's own second get a higher rowid and are picked up by Q1
//     (what the old `>=` was for). Concurrent runs (Navigator + the
//     internal step route) can at worst regress the cursor to an
//     earlier page end → a re-read absorbed by INSERT OR IGNORE, never
//     a skip.
//
//     Defensive self-heal: if a FULL page somehow makes no progress
//     (cannot happen with keyset unless D1 hands back rows out of
//     order / without rowid), the run logs it, flags `cursorStuck`
//     (→ agent_outputs `cursor_stuck`, read by Flight Control's
//     `platform_dns_queue_stalled` check) and skips the rest of that
//     second rather than pinning forever.
//
//     Bootstrap: missing cursor defaults to `now - 30 minutes`.
//     The KV TTL is 30 days (was 7): a pinned cursor's key expiring
//     would silently re-bootstrap to "now" and abandon the backlog.
//     `seedDnsQueueCursor` (POST /api/internal/dns-queue/reconcile
//     ?from=) re-seeds it explicitly.
//
//   Stale removal:
//     Out of scope for this module. See lib/dns-queue-reaper.ts.
//     The reaper runs once/day, scans the queue, drops rows
//     whose threats are no longer candidates (status flipped,
//     etc). Sub-daily lag for stale rows is acceptable —
//     dns-backfill's own DELETE-on-resolve handles the common
//     case in real time.
//
//   Caps:
//     READ_LIMIT 500 (typical tick has ~37 candidates; cap
//     accommodates feed-burst windows). Batch size 50 per
//     INSERT OR IGNORE chunk (D1 SQL-variable ceiling).
//
//   Never throws — drift is recoverable on the next tick. The
//   reconciler returning {skipped:true} for any failure path
//   keeps Navigator's primary mission (dns-backfill) unblocked.

import type { Env } from '../types';
import { cachedCount } from './cached-count';

const CURSOR_KEY = 'reconciler:dns_queue:cursor';
const CURSOR_TTL_S = 86_400 * 30;
const CHUNK_SIZE = 50;
export const RECONCILER_READ_LIMIT = 500;
const READ_LIMIT = RECONCILER_READ_LIMIT;

/** Upper bound on pages one internal step call may run (route cap). */
export const RECONCILER_MAX_STEP_PAGES = 20;

/** Candidate predicate shared by both keyset reads. Must match
 *  lib/dns-queue-reaper.ts and lib/dns-drainable.ts. Static SQL — no
 *  caller data is ever spliced in. */
const CANDIDATE_FILTER_SQL = `
        AND ip_address IS NULL
        AND dns_exhausted_at IS NULL
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'`;

/** Q1 — remainder of the cursor's own second. Binds: created_at, rowid, limit. */
export const RECONCILER_TIE_SQL = `
      SELECT rowid AS rid, malicious_domain, source_feed, created_at
      FROM threats INDEXED BY idx_threats_status_created
      WHERE status = 'active'
        AND created_at = ?
        AND rowid > ?${CANDIDATE_FILTER_SQL}
      ORDER BY rowid
      LIMIT ?`;

/** Q2 — every later second. Binds: created_at, limit. */
export const RECONCILER_AFTER_SQL = `
      SELECT rowid AS rid, malicious_domain, source_feed, created_at
      FROM threats INDEXED BY idx_threats_status_created
      WHERE status = 'active'
        AND created_at > ?${CANDIDATE_FILTER_SQL}
      ORDER BY created_at, rowid
      LIMIT ?`;

// ── Historical backfill (one-time drain of the pre-cursor tail) ──
// The forward reconciler only walks created_at >= cursor, so threats
// that were already old when the cursor architecture went live (PR-BI)
// — and any that slipped through during outages — never get enqueued.
// In the 2026-05-27 audit ~63K active, unresolved-DNS threats existed
// outside the queue (needs_dns ≈ 99K, queue ≈ 36K), keeping the
// dns_queue parity-drift alert permanently lit and starving those
// threats of DNS resolution.
//
// The backfill walks created_at DESCENDING from a fixed boundary (the
// forward cursor at init) down through history, a bounded page per
// tick, INSERT OR IGNORE (the queue PK absorbs any overlap). Because
// created_at only increases, once a page comes back short the tail is
// fully drained — we set a done flag and every later tick is a single
// KV read with zero D1 cost. Self-terminating and idempotent.
const BACKFILL_CURSOR_KEY = 'reconciler:dns_queue:backfill_cursor';
const BACKFILL_DONE_KEY = 'reconciler:dns_queue:backfill_done';
const BACKFILL_LIMIT = 500;

// Bootstrap default — when the cursor KV key is missing (first
// deploy, or KV got wiped), we start from this many minutes back.
// 30 min is plenty: previous reconciler runs (set-diff variant)
// kept the queue continuously populated, so older candidates are
// already in dns_queue.
const BOOTSTRAP_MINUTES_AGO = 30;

// ── Cursor encoding ─────────────────────────────────────────────

export interface DnsQueueCursor {
  /** threats.created_at of the last row processed (SQLite datetime text). */
  created_at: string;
  /** threats.rowid of the last row processed; 0 = "before every row of that second". */
  rowid: number;
}

/**
 * Parse the KV cursor. Accepts the current JSON shape and the legacy
 * bare-timestamp value (→ rowid 0, i.e. the old `>= cursor` semantics,
 * so a frozen legacy cursor re-reads its second once from the start and
 * then walks forward). Returns null for empty / malformed values.
 */
export function parseDnsQueueCursor(raw: string | null | undefined): DnsQueueCursor | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (s === '') return null;
  if (s.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (parsed !== null && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>;
        const createdAt = rec.created_at;
        const rowid = rec.rowid;
        if (
          typeof createdAt === 'string' && createdAt !== ''
          && typeof rowid === 'number' && Number.isSafeInteger(rowid) && rowid >= 0
        ) {
          return { created_at: createdAt, rowid };
        }
      }
    } catch {
      // fall through — malformed JSON
    }
    return null;
  }
  return { created_at: s, rowid: 0 };
}

export function serializeDnsQueueCursor(c: DnsQueueCursor): string {
  return JSON.stringify({ created_at: c.created_at, rowid: c.rowid });
}

/** Total order on cursor keys: created_at (text) then rowid. */
export function compareDnsQueueCursor(a: DnsQueueCursor, b: DnsQueueCursor): number {
  if (a.created_at < b.created_at) return -1;
  if (a.created_at > b.created_at) return 1;
  return a.rowid === b.rowid ? 0 : a.rowid < b.rowid ? -1 : 1;
}

function toSqliteDatetime(d: Date): string {
  // SQLite datetime() format: 'YYYY-MM-DD HH:MM:SS' (no T, no ms, no TZ).
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Read + parse the forward cursor; null when missing, malformed or KV fails. */
async function readCursor(env: Env): Promise<DnsQueueCursor | null> {
  try {
    return parseDnsQueueCursor(await env.CACHE.get(CURSOR_KEY));
  } catch {
    return null;
  }
}

/**
 * Re-seed the forward cursor to the start of `createdAt` (rowid 0).
 * Used by the internal catch-up route when the KV cursor was lost or
 * must be rewound. Caller validates the timestamp shape.
 */
export async function seedDnsQueueCursor(env: Env, createdAt: string): Promise<DnsQueueCursor> {
  const cursor: DnsQueueCursor = { created_at: createdAt, rowid: 0 };
  await env.CACHE.put(CURSOR_KEY, serializeDnsQueueCursor(cursor), { expirationTtl: CURSOR_TTL_S });
  return cursor;
}

interface CandidateRow {
  rid: number;
  malicious_domain: string;
  source_feed: string | null;
  created_at: string;
}

export interface ReconcileResult {
  skipped: boolean;
  reason?: string;
  /** rows_written on the queue side from INSERT OR IGNORE. */
  enqueued: number;
  /** Number of new candidates pulled from threats since cursor. */
  scanned: number;
  /** Cursor position read at start of tick (serialized KV value). */
  cursorBefore: string | null;
  /** Cursor position after advance (serialized KV value). */
  cursorAfter: string | null;
  /** Minutes between cursor and now-at-tick-start. Surfaced for
   *  staleness monitoring — if this grows, threats are being
   *  ingested faster than the reconciler is enqueuing. */
  cursorLagMinutes: number;
  /** True when a FULL page made no cursor progress and the defensive
   *  self-heal had to skip ahead. Surfaced as `cursor_stuck` in the
   *  Navigator diagnostic; Flight Control's stalled check reads it. */
  cursorStuck: boolean;
  /** Current dns_queue size — read once per tick for observability. */
  queueSize: number;
  durationMs: number;
  batchesAttempted: number;
  batchesFailed: number;
  lastError?: string;
}

export async function reconcileDnsQueue(env: Env): Promise<ReconcileResult> {
  const start = Date.now();
  let batchesAttempted = 0;
  let batchesFailed = 0;
  let lastError: string | undefined;
  const base: ReconcileResult = {
    skipped: false,
    enqueued: 0,
    scanned: 0,
    cursorBefore: null,
    cursorAfter: null,
    cursorLagMinutes: 0,
    cursorStuck: false,
    queueSize: 0,
    durationMs: 0,
    batchesAttempted: 0,
    batchesFailed: 0,
  };

  if (!env.DNS_QUEUE_DB) {
    return { ...base, skipped: true, reason: 'binding_unset', durationMs: Date.now() - start };
  }

  try {
    // ── 1. Read cursor from KV ──
    // Default to "30 min ago" if not yet set (first deploy of the
    // cursor-based reconciler, or KV wiped).
    const before: DnsQueueCursor = (await readCursor(env)) ?? {
      created_at: toSqliteDatetime(new Date(Date.now() - BOOTSTRAP_MINUTES_AGO * 60_000)),
      rowid: 0,
    };
    const cursorBefore = serializeDnsQueueCursor(before);
    const cursorAgeMs = Date.now() - Date.parse(before.created_at.replace(' ', 'T') + 'Z');
    const cursorLagMinutes = Number.isFinite(cursorAgeMs)
      ? Math.max(0, Math.floor(cursorAgeMs / 60_000))
      : 0;

    // ── 2. Read the next keyset page ──
    // Q1: rest of the cursor's own second (exact seek on rowid).
    const tieRes = await env.DB.prepare(RECONCILER_TIE_SQL)
      .bind(before.created_at, before.rowid, READ_LIMIT)
      .all<CandidateRow>();
    const candidates: CandidateRow[] = [...tieRes.results];
    // Q2: later seconds, only for the room Q1 left on the page.
    const remaining = READ_LIMIT - candidates.length;
    if (remaining > 0) {
      const afterRes = await env.DB.prepare(RECONCILER_AFTER_SQL)
        .bind(before.created_at, remaining)
        .all<CandidateRow>();
      candidates.push(...afterRes.results);
    }
    const scanned = candidates.length;

    // ── 3. Dedupe by malicious_domain + find the page's last key ──
    // Within one tick, the SELECT may return multiple rows with the
    // same malicious_domain (e.g., feed reposts). Batching via
    // db.batch() with duplicate PKs in one batch is risky on D1 (the
    // 2026-05-17 bug). Dedupe up-front.
    const uniqueByDomain = new Map<string, { malicious_domain: string; source_feed: string | null }>();
    let next: DnsQueueCursor = before;
    for (const c of candidates) {
      if (!uniqueByDomain.has(c.malicious_domain)) {
        uniqueByDomain.set(c.malicious_domain, c);
      }
      if (typeof c.rid === 'number' && Number.isSafeInteger(c.rid)) {
        const key: DnsQueueCursor = { created_at: c.created_at, rowid: c.rid };
        if (compareDnsQueueCursor(key, next) > 0) next = key;
      }
    }
    const toInsert = [...uniqueByDomain.values()];

    // Defensive self-heal: a full page that doesn't move the cursor
    // would pin it forever (the 2026-10-06 failure mode). Keyset makes
    // this unreachable unless D1 returns rows without/out of key order;
    // if it ever happens, skip the rest of the cursor's second
    // (rowid → MAX_SAFE_INTEGER, so the next Q1 is empty and Q2 moves
    // on) and flag it for Flight Control.
    let cursorStuck = false;
    if (scanned >= READ_LIMIT && compareDnsQueueCursor(next, before) <= 0) {
      cursorStuck = true;
      next = { created_at: before.created_at, rowid: Number.MAX_SAFE_INTEGER };
      const msg = `cursor_stuck: full page (${scanned}) made no progress at ${cursorBefore}; skipping rest of second`;
      console.error(`[dns-queue-reconciler] ${msg}`);
      if (!lastError) lastError = msg;
    }

    // ── 4. Read current queue size — cheap, observability only ──
    // Cached on the shared `count.dns_queue.size` key (also read by
    // Flight Control) so this 5-min tick stops full-scanning the whole
    // ~35K-row dns_queue every run. PR-BI's read-budget math accounted
    // for the cursor-paginated candidate read but missed this COUNT(*),
    // which alone was ~288 ticks × ~35K rows ≈ 10M reads/day on
    // DNS_QUEUE_DB. queueSize is only logged for drift telemetry here, so
    // staleness is harmless. The old 600s TTL only cleared alternate 5-min
    // ticks (~50% hit ceiling); 1800s lets ~5 of every 6 ticks hit (~83%)
    // while bounding staleness to ≤30min — well inside FC's 500-row drift
    // tolerance (the queue moves only tens of rows over 30min). MUST stay
    // in sync with the FC reader's TTL so the shared key is coherent.
    let queueSize = 0;
    try {
      queueSize = await cachedCount(env, 'count.dns_queue.size', 1800, async () => {
        const r = await env.DNS_QUEUE_DB!.prepare(
          'SELECT COUNT(*) AS n FROM dns_queue'
        ).first<{ n: number }>();
        return r?.n ?? 0;
      });
    } catch {
      // Non-fatal — leave at 0, surface via lastError if other
      // queries fail too.
    }

    // ── 5. INSERT OR IGNORE the dedupe'd new candidates ──
    // Per-row INSERTs batched via db.batch() (proven PR-2b pattern;
    // avoids the multi-row VALUES bug + gives per-statement
    // changes count).
    let enqueued = 0;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const stmts = chunk.map((c) =>
        env.DNS_QUEUE_DB!.prepare(`
          INSERT OR IGNORE INTO dns_queue
            (malicious_domain, enrichment_attempts, attempted_resolve_at, source_feed, enqueued_at)
          VALUES (?, 0, NULL, ?, datetime('now'))
        `).bind(c.malicious_domain, c.source_feed)
      );
      batchesAttempted++;
      try {
        const results = await env.DNS_QUEUE_DB.batch(stmts);
        for (const r of results) enqueued += r.meta?.changes ?? 0;
      } catch (err) {
        batchesFailed++;
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        console.error('[dns-queue-reconciler] enqueue batch failed:', err);
      }
    }

    // ── 6. Advance cursor ──
    // Only persist on progress. An empty window (no new threats in the
    // last 5 min — common at night) keeps the cursor; next tick reads
    // from the same point.
    //
    // CRITICAL: persist even if some INSERT batches failed. The
    // failed rows would be retried next tick via INSERT OR IGNORE,
    // but only if the cursor advances; not advancing pins the
    // cursor on a permanent-failure row and blocks all subsequent
    // candidates. The dedup gives us idempotency.
    let cursorAfter: string | null = cursorBefore;
    if (compareDnsQueueCursor(next, before) > 0) {
      const serialized = serializeDnsQueueCursor(next);
      try {
        await env.CACHE.put(CURSOR_KEY, serialized, { expirationTtl: CURSOR_TTL_S });
        cursorAfter = serialized;
      } catch (err) {
        // KV write failure — log + continue. Next tick reads stale
        // cursor and re-processes. Idempotent via INSERT OR IGNORE.
        console.error('[dns-queue-reconciler] cursor write failed:', err);
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
      }
    }

    return {
      skipped: false,
      enqueued,
      scanned,
      cursorBefore,
      cursorAfter,
      cursorLagMinutes,
      cursorStuck,
      queueSize,
      durationMs: Date.now() - start,
      batchesAttempted,
      batchesFailed,
      lastError,
    };
  } catch (err) {
    console.error('[dns-queue-reconciler] fatal:', err);
    return {
      ...base,
      skipped: true,
      reason: err instanceof Error ? err.message : 'fatal_error',
      durationMs: Date.now() - start,
      batchesAttempted,
      batchesFailed,
      lastError: lastError ?? (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
    };
  }
}

export interface ReconcileStepResult {
  /** Pages actually run (≤ requested). */
  pages: number;
  scanned: number;
  enqueued: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  /** Cursor lag (minutes) reported by the last page run. */
  cursorLagMinutes: number;
  /** True once a page came back short — the cursor reached the head. */
  caughtUp: boolean;
  cursorStuck: boolean;
  batchesFailed: number;
  skipped: boolean;
  reason?: string;
  lastError?: string;
}

/**
 * Run up to `pages` reconciler pages back-to-back (internal catch-up
 * route). Stops early once a page is short (caught up) or a page is
 * skipped. Same per-page code path as the Navigator tick, so the same
 * keyset/idempotency guarantees hold; each page is ≤500 threats rows +
 * ≤500 queue INSERT OR IGNOREs.
 */
export async function stepDnsQueueReconciler(env: Env, pages: number): Promise<ReconcileStepResult> {
  const n = Math.max(1, Math.min(RECONCILER_MAX_STEP_PAGES, Math.floor(pages)));
  const out: ReconcileStepResult = {
    pages: 0, scanned: 0, enqueued: 0, cursorBefore: null, cursorAfter: null,
    cursorLagMinutes: 0, caughtUp: false, cursorStuck: false, batchesFailed: 0, skipped: false,
  };
  for (let i = 0; i < n; i++) {
    const r = await reconcileDnsQueue(env);
    if (r.skipped) {
      out.skipped = out.pages === 0;
      out.reason = r.reason;
      out.lastError = r.lastError;
      break;
    }
    out.pages++;
    if (out.cursorBefore === null) out.cursorBefore = r.cursorBefore;
    out.cursorAfter = r.cursorAfter;
    out.cursorLagMinutes = r.cursorLagMinutes;
    out.scanned += r.scanned;
    out.enqueued += r.enqueued;
    out.batchesFailed += r.batchesFailed;
    out.cursorStuck = out.cursorStuck || r.cursorStuck;
    if (r.lastError && !out.lastError) out.lastError = r.lastError;
    if (r.scanned < READ_LIMIT) {
      out.caughtUp = true;
      break;
    }
  }
  return out;
}

export interface BackfillResult {
  skipped: boolean;
  reason?: string;
  /** rows_written on the queue side from INSERT OR IGNORE this tick. */
  enqueued: number;
  /** Candidate rows pulled from threats this tick (pre-dedupe). */
  scanned: number;
  /** Boundary the descending walk advanced to (ISO timestamp), or null. */
  cursorAfter: string | null;
  /** True once the historical tail is fully drained. */
  done: boolean;
  durationMs: number;
}

/**
 * One bounded page of the historical DNS-queue backfill. Walks
 * threats.created_at DESCENDING from a fixed boundary (the forward
 * reconciler cursor at init) into history, enqueuing the pre-cursor
 * tail the forward reconciler can never reach. Self-terminating
 * (sets a KV done flag) and idempotent (INSERT OR IGNORE). Never
 * throws — like the reconciler, drift is recoverable next tick.
 *
 * Invoked from the Navigator tick right after reconcileDnsQueue.
 */
export async function backfillDnsQueueHistory(env: Env): Promise<BackfillResult> {
  const start = Date.now();
  const base: BackfillResult = {
    skipped: false, enqueued: 0, scanned: 0, cursorAfter: null, done: false,
    durationMs: 0,
  };

  if (!env.DNS_QUEUE_DB) {
    return { ...base, skipped: true, reason: 'binding_unset', durationMs: Date.now() - start };
  }

  try {
    // Done already? One KV read, zero D1 cost — the steady state after
    // the tail drains.
    let done: string | null = null;
    try { done = await env.CACHE.get(BACKFILL_DONE_KEY); } catch { /* treat as not-done */ }
    if (done) {
      return { ...base, skipped: true, reason: 'already_done', done: true, durationMs: Date.now() - start };
    }

    // Boundary cursor: initialize from the forward cursor (so the two
    // walks meet without a gap), else from "now" (covers all history).
    let boundary: string | null = null;
    try { boundary = await env.CACHE.get(BACKFILL_CURSOR_KEY); } catch { /* init below */ }
    if (!boundary) {
      // The forward cursor is JSON (keyset) or a legacy bare timestamp;
      // the backfill only needs its created_at.
      const forward = await readCursor(env);
      boundary = forward?.created_at ?? toSqliteDatetime(new Date());
    }

    // Same candidate predicate as the forward reconciler, walking DOWN.
    const res = await env.DB.prepare(`
      SELECT malicious_domain, source_feed, created_at
      FROM threats INDEXED BY idx_threats_status_created
      WHERE status = 'active'
        AND created_at < ?
        AND ip_address IS NULL
        AND dns_exhausted_at IS NULL
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(boundary, BACKFILL_LIMIT).all<{
      malicious_domain: string;
      source_feed: string | null;
      created_at: string;
    }>();

    const rows = res.results;
    const scanned = rows.length;

    // A short page means we've reached the oldest candidate — the tail
    // is drained. Mark done so later ticks short-circuit on the KV read.
    if (scanned === 0) {
      try { await env.CACHE.put(BACKFILL_DONE_KEY, '1', { expirationTtl: 86_400 * 30 }); } catch { /* non-fatal */ }
      return { ...base, scanned: 0, done: true, durationMs: Date.now() - start };
    }

    // Dedupe by domain (same DB-batch safety rationale as the reconciler)
    // and track the minimum created_at to advance the descending cursor.
    const uniqueByDomain = new Map<string, { malicious_domain: string; source_feed: string | null }>();
    let minCreatedAt = boundary;
    for (const r of rows) {
      if (!uniqueByDomain.has(r.malicious_domain)) uniqueByDomain.set(r.malicious_domain, r);
      if (r.created_at < minCreatedAt) minCreatedAt = r.created_at;
    }
    const toInsert = [...uniqueByDomain.values()];

    let enqueued = 0;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const stmts = chunk.map((c) =>
        env.DNS_QUEUE_DB!.prepare(`
          INSERT OR IGNORE INTO dns_queue
            (malicious_domain, enrichment_attempts, attempted_resolve_at, source_feed, enqueued_at)
          VALUES (?, 0, NULL, ?, datetime('now'))
        `).bind(c.malicious_domain, c.source_feed)
      );
      try {
        const results = await env.DNS_QUEUE_DB.batch(stmts);
        for (const r of results) enqueued += r.meta?.changes ?? 0;
      } catch (err) {
        console.error('[dns-queue-backfill] enqueue batch failed:', err);
      }
    }

    // Advance the boundary down past this page. A short page (fewer than
    // a full read limit) also means the tail is drained → mark done.
    const reachedEnd = scanned < BACKFILL_LIMIT;
    try {
      await env.CACHE.put(BACKFILL_CURSOR_KEY, minCreatedAt, { expirationTtl: 86_400 * 7 });
      if (reachedEnd) await env.CACHE.put(BACKFILL_DONE_KEY, '1', { expirationTtl: 86_400 * 30 });
    } catch (err) {
      console.error('[dns-queue-backfill] cursor write failed:', err);
    }

    return {
      skipped: false,
      enqueued,
      scanned,
      cursorAfter: minCreatedAt,
      done: reachedEnd,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    console.error('[dns-queue-backfill] fatal:', err);
    return { ...base, skipped: true, reason: err instanceof Error ? err.message : 'fatal_error', durationMs: Date.now() - start };
  }
}

const SEED_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export type ReconcileStepParams =
  | { ok: true; pages: number; from: string | null }
  | { ok: false; error: string };

/**
 * Validate the internal catch-up route's query string:
 *   pages  1..RECONCILER_MAX_STEP_PAGES (default 1)
 *   from   optional 'YYYY-MM-DD HH:MM:SS' (UTC) — re-seeds the cursor to
 *          the start of that second before stepping.
 */
export function parseReconcileStepParams(params: URLSearchParams): ReconcileStepParams {
  const pagesRaw = params.get('pages');
  let pages = 1;
  if (pagesRaw !== null) {
    if (!/^\d+$/.test(pagesRaw)) return { ok: false, error: 'pages must be an integer' };
    pages = Number(pagesRaw);
    if (pages < 1 || pages > RECONCILER_MAX_STEP_PAGES) {
      return { ok: false, error: `pages must be 1..${RECONCILER_MAX_STEP_PAGES}` };
    }
  }
  const fromRaw = params.get('from');
  let from: string | null = null;
  if (fromRaw !== null) {
    if (!SEED_TS_RE.test(fromRaw) || !Number.isFinite(Date.parse(fromRaw.replace(' ', 'T') + 'Z'))) {
      return { ok: false, error: "from must be 'YYYY-MM-DD HH:MM:SS' (UTC)" };
    }
    if (Date.parse(fromRaw.replace(' ', 'T') + 'Z') > Date.now()) {
      return { ok: false, error: 'from must not be in the future' };
    }
    from = fromRaw;
  }
  return { ok: true, pages, from };
}
