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

// IN (?, ?, ...) chunk for the threats existence check. SQLite's
// default SQLITE_MAX_VARIABLE_NUMBER is 999; D1's effective ceiling
// is lower (~100 in some configs). 200 fits comfortably under
// `?` × 200 = 200 variables. Verified empirically on D1 in the
// dns-backfill chunk size.
const EXISTENCE_CHUNK_SIZE = 200;

// DELETE … WHERE malicious_domain IN (?, ?, …) chunk size.
// Conservative — D1 has tripped on 100+ in past spawn paths
// (see PR-2a fix in reconciler). 50 mirrors the reconciler's
// CHUNK_SIZE for the same reason.
const DELETE_CHUNK_SIZE = 50;

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

    // ── 2. Existence check on threats, in chunks ──
    // For each chunk of queue domains, ask threats which ones still
    // match the candidate predicate. The set difference (queue MINUS
    // matched) is the stale set.
    //
    // Predicate must match lib/dns-queue-reconciler.ts EXACTLY —
    // otherwise we'd delete domains that the reconciler is about to
    // re-enqueue (oscillation). Source of truth: the WHERE clause in
    // reconcileDnsQueue's candidate SELECT.
    const matched = new Set<string>();
    let softCapHit = false;

    for (let i = 0; i < queueDomains.length; i += EXISTENCE_CHUNK_SIZE) {
      if (Date.now() - start > REAPER_SOFT_CAP_MS) {
        softCapHit = true;
        console.warn(`[dns-queue-reaper] soft-cap hit at chunk ${i / EXISTENCE_CHUNK_SIZE}; bailing out of existence loop`);
        break;
      }
      const chunk = queueDomains.slice(i, i + EXISTENCE_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      batchesAttempted++;
      try {
        // INDEXED BY idx_threats_malicious_domain forces the bounded
        // lookup. Without the hint the planner can fall back to
        // idx_threats_status_created on `status='active'` and then
        // re-filter on domain, which scans many more rows.
        const res = await env.DB.prepare(`
          SELECT DISTINCT malicious_domain
            FROM threats INDEXED BY idx_threats_malicious_domain
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

    // ── 2a. Mark exhausted threats (attempts >= 8) ──
    // These domains hit the resolution cap (confirmed-dead or 8 transient
    // failures). Stamp dns_exhausted_at on their still-active, unresolved
    // threats so they leave the DNS candidate set — the reconciler,
    // backfill, FC drift count, and diagnostics all filter
    // dns_exhausted_at IS NULL, so they stop inflating the drift metric
    // and never get re-enqueued. The queue rows are removed in step 3.
    // Idempotent: the dns_exhausted_at IS NULL guard makes already-marked
    // rows free, and once a queue row is deleted it never reappears here.
    let exhaustedMarked = 0;
    for (let i = 0; i < exhaustedDomains.length; i += DELETE_CHUNK_SIZE) {
      if (Date.now() - start > REAPER_SOFT_CAP_MS) {
        softCapHit = true;
        console.warn(`[dns-queue-reaper] soft-cap hit at mark chunk ${i / DELETE_CHUNK_SIZE}; bailing`);
        break;
      }
      const chunk = exhaustedDomains.slice(i, i + DELETE_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      batchesAttempted++;
      try {
        await env.DB.prepare(`
          UPDATE threats
             SET dns_exhausted_at = datetime('now')
           WHERE malicious_domain IN (${placeholders})
             AND status = 'active'
             AND ip_address IS NULL
             AND dns_exhausted_at IS NULL
        `).bind(...chunk).run();
        exhaustedMarked += chunk.length;
      } catch (err) {
        batchesFailed++;
        if (!lastError) {
          lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        console.error('[dns-queue-reaper] exhausted-mark batch failed:', err);
      }
    }

    // ── 3. DELETE stale + exhausted rows in chunks ──
    // stale = under-cap rows whose threat is no longer a candidate;
    // exhausted = capped rows marked above. Both leave the queue.
    const toDelete = [...queueDomains.filter((d) => !matched.has(d)), ...exhaustedDomains];
    let staleRemoved = 0;
    for (let i = 0; i < toDelete.length; i += DELETE_CHUNK_SIZE) {
      if (Date.now() - start > REAPER_SOFT_CAP_MS) {
        softCapHit = true;
        console.warn(`[dns-queue-reaper] soft-cap hit at delete chunk ${i / DELETE_CHUNK_SIZE}; bailing`);
        break;
      }
      const chunk = toDelete.slice(i, i + DELETE_CHUNK_SIZE);
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
