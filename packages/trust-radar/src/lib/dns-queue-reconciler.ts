// DNS Queue Reconciler — PR-2 of the DNS-queue split.
//
// Mirrors the "needs DNS resolution" subset of the threats table into
// the dedicated `trust-radar-dns-queue` D1 (binding DNS_QUEUE_DB).
// Runs every Navigator tick (5 min) so dns_queue stays within ~5 min
// of threats. PR-3 will flip dns-backfill.ts reads from threats to
// dns_queue; PR-4 will retire the threats-side indexes.
//
// Design notes:
//
//   - The 14+ feed INSERT sites for threats are too distributed to
//     hook individually without risk of missing one. A single
//     reconciler is a clean choke point — and idempotent, so it's
//     safe to re-run if Navigator restarts mid-tick.
//
//   - Full diff per tick (not delta-based). With ~17K rows on each
//     side, reading both is ~34K rows/tick × 288 ticks = ~10M
//     reads/day per side. The dns_queue side has its own 25B/month
//     budget; the threats side is already paying this cost via the
//     existing dns-backfill SELECT (which uses the same strict index
//     and will be retired in PR-4).
//
//   - Writes are bounded: only rows that actually changed flip the
//     queue (INSERT OR IGNORE on existing, DELETE only confirmed
//     stale). SQLite charges `rows_written` only on real mutations.
//
//   - Never throws — drift is recoverable on the next tick. The
//     reconciler returning {skipped:true} for any failure path keeps
//     Navigator's primary mission (dns-backfill) unblocked.
//
//   - Skipped cleanly when DNS_QUEUE_DB is unbound. PR-1 added the
//     binding to wrangler.toml as active, so this only fires in dev
//     environments that haven't enabled it.

import type { Env } from '../types';

export interface ReconcileResult {
  skipped: boolean;
  reason?: string;
  enqueued: number;
  dequeued: number;
  candidatesInThreats: number;
  queueSize: number;
  /** queueSize - candidatesInThreats. Positive = queue has stale rows
   *  not yet dequeued. Negative = threats has candidates not yet
   *  enqueued. Should converge to 0 within one tick of steady state. */
  delta: number;
  durationMs: number;
}

// Chunk size for IN(?,?,?...) batches. SQLite has a max of ~999
// parameters per statement; 50 keeps us well below and matches the
// pattern used in dns-backfill.ts so the planner cost is comparable.
const CHUNK_SIZE = 50;

// Hard cap on the candidate read. Backlog over this size still
// converges across multiple ticks (each one drains the rest), but we
// keep the per-tick wall-clock under Navigator's 30s CF ceiling.
// Production audit 2026-05-17: current candidate count is 17,079 —
// well under this cap. The reconciler will still finish in one tick.
const READ_LIMIT = 50_000;

export async function reconcileDnsQueue(env: Env): Promise<ReconcileResult> {
  const start = Date.now();
  const base: ReconcileResult = {
    skipped: false,
    enqueued: 0,
    dequeued: 0,
    candidatesInThreats: 0,
    queueSize: 0,
    delta: 0,
    durationMs: 0,
  };

  if (!env.DNS_QUEUE_DB) {
    return { ...base, skipped: true, reason: 'binding_unset', durationMs: Date.now() - start };
  }

  try {
    // ── 1. Snapshot drainable candidates in threats ──
    // Uses the strict partial index landed in migration 0195. EXPLAIN
    // confirmed on prod: SEARCH ... USING INDEX
    // idx_threats_dns_pending_strict (malicious_domain>?). ~19.5K
    // index rows scanned worst case.
    const candidatesRes = await env.DB.prepare(`
      SELECT
        malicious_domain,
        COALESCE(enrichment_attempts, 0) AS enrichment_attempts,
        attempted_resolve_at,
        source_feed
      FROM threats INDEXED BY idx_threats_dns_pending_strict
      WHERE ip_address IS NULL
        AND status = 'active'
        AND COALESCE(enrichment_attempts, 0) < 8
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
      LIMIT ?
    `).bind(READ_LIMIT).all<{
      malicious_domain: string;
      enrichment_attempts: number;
      attempted_resolve_at: string | null;
      source_feed: string | null;
    }>();

    const candidates = candidatesRes.results;
    const candidateDomains = new Set(candidates.map((c) => c.malicious_domain));

    // ── 2. Snapshot current dns_queue ──
    const queueRes = await env.DNS_QUEUE_DB.prepare(
      `SELECT malicious_domain FROM dns_queue`
    ).all<{ malicious_domain: string }>();
    const queueDomains = queueRes.results.map((r) => r.malicious_domain);
    const queueSet = new Set(queueDomains);

    // ── 3. Diff: rows in threats not yet in queue → INSERT.
    //    Rows in queue not in threats → DELETE.
    //    The intersection gets an UPSERT to keep attempts/cooldown
    //    aligned (cheap — SQLite's INSERT OR UPDATE on the existing
    //    PK with identical values is effectively a no-op on
    //    rows_written when the values match).
    //
    // We INSERT-OR-UPSERT all candidates (not just the diff) so any
    // drift in enrichment_attempts or attempted_resolve_at gets
    // healed. The conflict path makes this safe.
    let enqueued = 0;
    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk
        .map(() => "(?, ?, ?, ?, datetime('now'))")
        .join(',');
      const params: (string | number | null)[] = [];
      for (const c of chunk) {
        params.push(
          c.malicious_domain,
          c.enrichment_attempts,
          c.attempted_resolve_at,
          c.source_feed,
        );
      }
      try {
        const r = await env.DNS_QUEUE_DB.prepare(`
          INSERT INTO dns_queue
            (malicious_domain, enrichment_attempts, attempted_resolve_at, source_feed, enqueued_at)
          VALUES ${placeholders}
          ON CONFLICT(malicious_domain) DO UPDATE SET
            enrichment_attempts = excluded.enrichment_attempts,
            attempted_resolve_at = excluded.attempted_resolve_at,
            source_feed = COALESCE(dns_queue.source_feed, excluded.source_feed)
        `).bind(...params).run();
        enqueued += r.meta?.changes ?? 0;
      } catch (err) {
        // Best-effort — log and continue. The same row will retry next
        // tick. Never let a queue write break the reconciler loop.
        console.error('[dns-queue-reconciler] enqueue batch failed:', err);
      }
    }

    // ── 4. Stale removal ──
    // A queue row is stale iff its malicious_domain is NOT in the
    // current candidate snapshot. This means one of: (a) the
    // underlying threat got an ip_address (resolved), (b) status
    // changed off 'active', (c) attempts hit the cap, (d) the row
    // was deleted. All four are correct reasons to drop from queue.
    const staleDomains = queueDomains.filter((d) => !candidateDomains.has(d));

    let dequeued = 0;
    for (let i = 0; i < staleDomains.length; i += CHUNK_SIZE) {
      const chunk = staleDomains.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      try {
        const r = await env.DNS_QUEUE_DB.prepare(
          `DELETE FROM dns_queue WHERE malicious_domain IN (${placeholders})`
        ).bind(...chunk).run();
        dequeued += r.meta?.changes ?? 0;
      } catch (err) {
        console.error('[dns-queue-reconciler] dequeue batch failed:', err);
      }
    }

    return {
      skipped: false,
      enqueued,
      dequeued,
      candidatesInThreats: candidates.length,
      queueSize: queueDomains.length,
      delta: queueDomains.length - candidates.length,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    console.error('[dns-queue-reconciler] fatal:', err);
    return {
      ...base,
      skipped: true,
      reason: err instanceof Error ? err.message : 'fatal_error',
      durationMs: Date.now() - start,
    };
  }
}
