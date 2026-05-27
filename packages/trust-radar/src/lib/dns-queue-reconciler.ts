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
//   Cursor:
//     KV key `reconciler:dns_queue:cursor` (ISO timestamp).
//     Each tick reads `threats WHERE status='active' AND
//     created_at >= cursor AND ip_address IS NULL ORDER BY
//     created_at LIMIT 500` and advances cursor to MAX(created_at)
//     observed. Uses idx_threats_status_created — EXPLAIN
//     verified: `SEARCH USING INDEX (status=? AND created_at>?)`,
//     no TEMP B-TREE for ORDER BY.
//
//     `>= cursor` (not `>`) ensures rows with identical
//     created_at values aren't skipped between ticks. INSERT OR
//     IGNORE absorbs the overlap-dedup cost.
//
//     Bootstrap: missing cursor defaults to `now - 30 minutes`.
//     We trust earlier reconciler runs filled the queue with
//     pre-existing candidates — no re-scan of history needed.
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
const CHUNK_SIZE = 50;
const READ_LIMIT = 500;

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

export interface ReconcileResult {
  skipped: boolean;
  reason?: string;
  /** rows_written on the queue side from INSERT OR IGNORE. */
  enqueued: number;
  /** Number of new candidates pulled from threats since cursor. */
  scanned: number;
  /** Cursor position read at start of tick (ISO timestamp). */
  cursorBefore: string | null;
  /** Cursor position after advance (ISO timestamp). */
  cursorAfter: string | null;
  /** Minutes between cursor and now-at-tick-start. Surfaced for
   *  staleness monitoring — if this grows, threats are being
   *  ingested faster than the reconciler is enqueuing. */
  cursorLagMinutes: number;
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
    // cursor-based reconciler). The set-diff reconciler kept the
    // queue continuously up-to-date, so we don't need a full re-
    // scan of history at bootstrap.
    let cursor: string | null = null;
    try {
      cursor = await env.CACHE.get(CURSOR_KEY);
    } catch {
      // KV transient — treat as bootstrap. Cursor defaults below.
    }
    if (!cursor) {
      const bootstrapAt = new Date(Date.now() - BOOTSTRAP_MINUTES_AGO * 60_000);
      // SQLite datetime() format: 'YYYY-MM-DD HH:MM:SS' (no T, no
      // ms, no TZ). Match the schema we use in feed_pull_history,
      // agent_runs, etc.
      cursor = bootstrapAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }
    const cursorBefore = cursor;
    const cursorAgeMs = Date.now() - Date.parse(cursor.replace(' ', 'T') + 'Z');
    const cursorLagMinutes = Math.max(0, Math.floor(cursorAgeMs / 60_000));

    // ── 2. Read new candidates since cursor ──
    // INDEXED BY pins the right plan even if the planner gets
    // confused by stats refresh. EXPLAIN verified on prod
    // (2026-05-19): SEARCH threats USING INDEX
    // idx_threats_status_created (status=? AND created_at>?).
    //
    // `>= cursor` (not `>`) — rows with identical created_at don't
    // get skipped between ticks. INSERT OR IGNORE handles the dedup.
    const candidatesRes = await env.DB.prepare(`
      SELECT malicious_domain, source_feed, created_at
      FROM threats INDEXED BY idx_threats_status_created
      WHERE status = 'active'
        AND created_at >= ?
        AND ip_address IS NULL
        AND dns_exhausted_at IS NULL
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
      ORDER BY created_at
      LIMIT ?
    `).bind(cursor, READ_LIMIT).all<{
      malicious_domain: string;
      source_feed: string | null;
      created_at: string;
    }>();

    const candidates = candidatesRes.results;
    const scanned = candidates.length;

    // ── 3. Dedupe by malicious_domain ──
    // Within one tick, the SELECT may return multiple rows with the
    // same malicious_domain (e.g., feed reposts). INSERT OR IGNORE
    // would handle it row-by-row, but batching via db.batch() with
    // duplicate PKs in one batch is risky on D1 (the 2026-05-17
    // bug). Dedupe up-front.
    const uniqueByDomain = new Map<string, { malicious_domain: string; source_feed: string | null }>();
    let maxCreatedAt = cursor;
    for (const c of candidates) {
      if (!uniqueByDomain.has(c.malicious_domain)) {
        uniqueByDomain.set(c.malicious_domain, c);
      }
      if (c.created_at > maxCreatedAt) maxCreatedAt = c.created_at;
    }
    const toInsert = [...uniqueByDomain.values()];

    // ── 4. Read current queue size — cheap, observability only ──
    // Cached on the shared `count.dns_queue.size` key (also read by
    // Flight Control) so this 5-min tick stops full-scanning the whole
    // ~35K-row dns_queue every run. PR-BI's read-budget math accounted
    // for the cursor-paginated candidate read but missed this COUNT(*),
    // which alone was ~288 ticks × ~35K rows ≈ 10M reads/day on
    // DNS_QUEUE_DB. queueSize is only logged for drift telemetry, so a
    // 600s TTL (>tick interval, so alternate ticks hit) is harmless.
    let queueSize = 0;
    try {
      queueSize = await cachedCount(env, 'count.dns_queue.size', 600, async () => {
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
    // Only persist if we observed at least one candidate. If the
    // window was empty (no new threats in last 5 min — common at
    // night), keep the cursor — next tick reads from same point.
    //
    // CRITICAL: persist even if some INSERT batches failed. The
    // failed rows would be retried next tick via INSERT OR IGNORE,
    // but only if the cursor advances; not advancing pins the
    // cursor on a permanent-failure row and blocks all subsequent
    // candidates. The dedup gives us idempotency.
    let cursorAfter: string | null = cursorBefore;
    if (maxCreatedAt > cursor) {
      try {
        await env.CACHE.put(CURSOR_KEY, maxCreatedAt, {
          expirationTtl: 86_400 * 7, // 7 days — refreshed every tick that finds candidates
        });
        cursorAfter = maxCreatedAt;
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
      let forward: string | null = null;
      try { forward = await env.CACHE.get(CURSOR_KEY); } catch { /* fall through */ }
      boundary = forward ?? new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
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
