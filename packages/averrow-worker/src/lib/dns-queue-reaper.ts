// DNS Queue Reaper — daily stale-row removal.
//
// Pairs with lib/dns-queue-reconciler.ts (cursor-paginated enqueue).
// The reconciler ONLY adds rows: it reads the slice of threats added
// since the last cursor and INSERT-OR-IGNOREs into dns_queue. That
// alone leaves the queue grow-only.
//
// Most rows leave dns_queue the moment dns-backfill resolves the
// domain (DELETE-on-resolve in lib/dns-backfill.ts). What dns-backfill
// can't catch: rows whose underlying threat flipped state
// (status='active' → 'inactive', or got merged/deleted) AFTER the
// reconciler enqueued them. Those domains never get resolved (because
// dns-backfill respects status) and never get deleted (because
// dns-backfill is a per-domain DELETE, not a sweep). They become
// "ghost" rows in dns_queue — pollute drainable counts, waste KV
// state, no functional impact otherwise.
//
// The reaper sweeps once per day:
//   1. Read every dns_queue.malicious_domain (~17K rows currently).
//   2. In chunks of 200, ask threats: of these domains, which are
//      STILL candidates (status='active', ip_address IS NULL,
//      malicious_domain not glob, etc — same predicate the
//      reconciler uses)?
//   3. Compute the set difference: rows in dns_queue whose domain
//      is NOT in the threats candidate set → stale.
//   4. DELETE them in chunks (SQL-variable ceiling at 100).
//
// Read-budget math:
//   - Reaper read = 1 × COUNT(*) on dns_queue + N/200 batched
//     existence checks on threats. At ~17K queue size, that's ~85
//     batched SELECTs against threats. The threats query uses
//     `WHERE malicious_domain IN (?,?,...)` which hits
//     idx_threats_malicious_domain — bounded read, not a scan.
//   - Total per reaper run: ~17K + 85 SELECTs ≈ 17,085 reads.
//   - Frequency: 1× per 24h.
//   - Daily: ~17K reads. (Combined with reconciler: ~94K/day total —
//     down from the 15M/day pre-cursor architecture.)
//
// Idempotent + recoverable. Never throws — surfaces failures via
// ReaperResult.lastError and skipped=true paths. KV writes for
// last-run + last-delta drive FC's stalled-reaper notification.

import type { Env } from '../types';

const REAPER_LAST_RUN_KEY = 'reconciler:dns_queue:reaper_last_run';
const REAPER_LAST_DELTA_KEY = 'reconciler:dns_queue:reaper_last_delta';

// IN (?, ?, ...) chunk for the threats existence check. D1's effective
// SQLITE_MAX_VARIABLE_NUMBER is 100 — a 200-placeholder IN(...) fails
// every batch with "too many SQL variables", which silently sent the
// existence check down its all-candidate fallback (no stale removal —
// observed as total_stale_removed=0 across runs). 90 leaves head-room
// under the 100 ceiling, matching dns-backfill's PRE_STAMP_CHUNK=99.
const EXISTENCE_CHUNK_SIZE = 90;

// DELETE / UPDATE … WHERE malicious_domain IN (?, ?, …) chunk size.
// Same 100-variable ceiling; 90 drains the exhausted backlog ~1.8×
// faster than the old 50 while staying safely under the limit.
const DELETE_CHUNK_SIZE = 90;

// Soft cap to avoid the reaper itself becoming a long-running
// risk. At 17K rows / 200 chunk size / ~50ms per SELECT, we
// expect ~5s of D1 time. Cap at 25s to leave headroom under
// Navigator's 30s sub-hour cron ceiling (the reaper is dispatched
// from Navigator's tick at hour===0, not its own cron).
const REAPER_SOFT_CAP_MS = 25_000;

export interface ReaperResult {
  skipped: boolean;
  reason?: string;
  /** Rows read from dns_queue at start of run. */
  scanned: number;
  /** Rows in threats matching the candidate predicate (subset of scanned). */
  candidatesInThreats: number;
  /** Rows DELETEd from dns_queue (stale + exhausted). */
  staleRemoved: number;
  /** Exhausted-cap threats stamped dns_exhausted_at this run. */
  exhaustedMarked: number;
  /** Negative if rows were removed; positive only in pathological cases. */
  delta: number;
  durationMs: number;
  batchesAttempted: number;
  batchesFailed: number;
  softCapHit: boolean;
  lastError?: string;
}

export async function reapDnsQueue(env: Env): Promise<ReaperResult> {
  const start = Date.now();
  let batchesAttempted = 0;
  let batchesFailed = 0;
  let lastError: string | undefined;
  const base: ReaperResult = {
    skipped: false,
    scanned: 0,
    candidatesInThreats: 0,
    staleRemoved: 0,
    exhaustedMarked: 0,
    delta: 0,
    durationMs: 0,
    batchesAttempted: 0,
    batchesFailed: 0,
    softCapHit: false,
  };

  if (!env.DNS_QUEUE_DB) {
    return { ...base, skipped: true, reason: 'binding_unset', durationMs: Date.now() - start };
  }

  try {
    // ── 1. Read full dns_queue snapshot ──
    // One full scan per day; the queue is small so this is bounded.
    // We read enrichment_attempts too: rows at the 8-attempt cap are
    // "exhausted" (confirmed-dead or transiently abandoned). dns-backfill
    // marks + drains them in real time on the tick they cross the cap,
    // but it can never re-select an already-capped row (its SELECT filters
    // attempts < 8), so any pre-existing backlog can only be cleared here.
    // Exhausted rows get their threat marked dns_exhausted_at (step 2a) and
    // the queue row removed (step 3). Rows under the cap go through the
    // normal still-a-candidate existence check.
    const queueRes = await env.DNS_QUEUE_DB.prepare(
      'SELECT malicious_domain, enrichment_attempts FROM dns_queue ORDER BY malicious_domain',
    ).all<{ malicious_domain: string; enrichment_attempts: number }>();
    const allRows = queueRes.results;
    const scanned = allRows.length;
    const exhaustedDomains = allRows
      .filter((r) => (r.enrichment_attempts ?? 0) >= 8)
      .map((r) => r.malicious_domain);
    const queueDomains = allRows
      .filter((r) => (r.enrichment_attempts ?? 0) < 8)
      .map((r) => r.malicious_domain);

    if (scanned === 0) {
      return {
        ...base,
        scanned: 0,
        candidatesInThreats: 0,
        staleRemoved: 0,
        delta: 0,
        durationMs: Date.now() - start,
      };
    }

    let softCapHit = false;
    let staleRemoved = 0;

    // ── 2. Exhausted backlog first: mark threat + delete queue row ──
    // Rows at the 8-attempt cap (confirmed-dead or transiently abandoned).
    // These are unconditionally removed — no existence check needed — so
    // we process them BEFORE the (slower) existence check to guarantee the
    // high-value cleanup fits the soft-cap budget. Mark and delete are
    // paired per chunk: a soft-cap mid-loop leaves a consistent state
    // (each processed chunk is both marked AND removed), and because the
    // deleted rows don't reappear in the next run's snapshot, every run
    // makes forward progress until the backlog drains.
    let exhaustedMarked = 0;
    for (let i = 0; i < exhaustedDomains.length; i += DELETE_CHUNK_SIZE) {
      if (Date.now() - start > REAPER_SOFT_CAP_MS) {
        softCapHit = true;
        console.warn(`[dns-queue-reaper] soft-cap hit at exhausted chunk ${i / DELETE_CHUNK_SIZE}; bailing`);
        break;
      }
      const chunk = exhaustedDomains.slice(i, i + DELETE_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      batchesAttempted++;
      try {
        const m = await env.DB.prepare(`
          UPDATE threats
             SET dns_exhausted_at = datetime('now')
           WHERE malicious_domain IN (${placeholders})
             AND status = 'active'
             AND ip_address IS NULL
             AND dns_exhausted_at IS NULL
        `).bind(...chunk).run();
        exhaustedMarked += m.meta?.changes ?? 0;
        const d = await env.DNS_QUEUE_DB.prepare(
          `DELETE FROM dns_queue WHERE malicious_domain IN (${placeholders})`,
        ).bind(...chunk).run();
        staleRemoved += d.meta?.changes ?? 0;
      } catch (err) {
        batchesFailed++;
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        console.error('[dns-queue-reaper] exhausted cleanup batch failed:', err);
      }
    }

    // ── 3. Existence check on under-cap rows, in chunks ──
    // For each chunk, ask threats which domains still match the candidate
    // predicate. The set difference (queue MINUS matched) is the stale set.
    //
    // Predicate must match lib/dns-queue-reconciler.ts EXACTLY — otherwise
    // we'd delete domains the reconciler is about to re-enqueue
    // (oscillation). Source of truth: reconcileDnsQueue's candidate SELECT.
    const matched = new Set<string>();
    for (let i = 0; i < queueDomains.length; i += EXISTENCE_CHUNK_SIZE) {
      if (Date.now() - start > REAPER_SOFT_CAP_MS) {
        softCapHit = true;
        console.warn(`[dns-queue-reaper] soft-cap hit at existence chunk ${i / EXISTENCE_CHUNK_SIZE}; bailing`);
        break;
      }
      const chunk = queueDomains.slice(i, i + EXISTENCE_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      batchesAttempted++;
      try {
        // INDEXED BY idx_threats_unresolved_domain forces the bounded
        // lookup. It's the partial index on malicious_domain WHERE
        // ip_address IS NULL — exactly this query's subset. (The old hint
        // named idx_threats_malicious_domain, which does not exist, so
        // every batch failed with "no such index" and the check fell back
        // to all-candidate — no stale removal ever happened.)
        const res = await env.DB.prepare(`
          SELECT DISTINCT malicious_domain
            FROM threats INDEXED BY idx_threats_unresolved_domain
           WHERE malicious_domain IN (${placeholders})
             AND status = 'active'
             AND ip_address IS NULL
             AND dns_exhausted_at IS NULL
             AND malicious_domain IS NOT NULL
             AND malicious_domain != ''
             AND malicious_domain NOT LIKE '*%'
             AND malicious_domain LIKE '%.%'
        `).bind(...chunk).all<{ malicious_domain: string }>();
        for (const r of res.results) matched.add(r.malicious_domain);
      } catch (err) {
        batchesFailed++;
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        console.error('[dns-queue-reaper] existence-check batch failed:', err);
        // On batch failure, conservatively assume every domain in this
        // chunk is still a candidate. Prevents accidental over-deletion
        // if the existence query is broken.
        for (const d of chunk) matched.add(d);
      }
    }

    const candidatesInThreats = matched.size;

    // ── 4. DELETE stale under-cap rows (threat no longer a candidate) ──
    const stale = queueDomains.filter((d) => !matched.has(d));
    for (let i = 0; i < stale.length; i += DELETE_CHUNK_SIZE) {
      if (Date.now() - start > REAPER_SOFT_CAP_MS) {
        softCapHit = true;
        console.warn(`[dns-queue-reaper] soft-cap hit at delete chunk ${i / DELETE_CHUNK_SIZE}; bailing`);
        break;
      }
      const chunk = stale.slice(i, i + DELETE_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      batchesAttempted++;
      try {
        const res = await env.DNS_QUEUE_DB.prepare(
          `DELETE FROM dns_queue WHERE malicious_domain IN (${placeholders})`,
        ).bind(...chunk).run();
        staleRemoved += res.meta?.changes ?? 0;
      } catch (err) {
        batchesFailed++;
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        console.error('[dns-queue-reaper] delete batch failed:', err);
      }
    }

    // ── 4. Persist run metadata ──
    // KV writes are best-effort — FC's stalled-reaper check reads
    // these keys to flag missed runs. A write failure is logged but
    // doesn't fail the reaper.
    try {
      const nowIso = new Date().toISOString();
      await env.CACHE.put(REAPER_LAST_RUN_KEY, nowIso, {
        expirationTtl: 86_400 * 14, // 14 days — FC alerts after 36h gap
      });
      await env.CACHE.put(REAPER_LAST_DELTA_KEY, String(staleRemoved), {
        expirationTtl: 86_400 * 14,
      });
    } catch (err) {
      console.error('[dns-queue-reaper] KV metadata write failed:', err);
      if (!lastError) {
        lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
    }

    return {
      skipped: false,
      scanned,
      candidatesInThreats,
      staleRemoved,
      exhaustedMarked,
      delta: -staleRemoved,
      durationMs: Date.now() - start,
      batchesAttempted,
      batchesFailed,
      softCapHit,
      lastError,
    };
  } catch (err) {
    console.error('[dns-queue-reaper] fatal:', err);
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
