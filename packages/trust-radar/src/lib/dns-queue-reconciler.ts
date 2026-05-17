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
//   - Set-equality semantics, not state-equality. The queue mirrors
//     the SET of candidate malicious_domains in threats; the per-row
//     state (enrichment_attempts, attempted_resolve_at) is owned by
//     dns-backfill.ts after PR-3 lands. Until then, PR-2 only
//     verifies parity of SET membership.
//
//   - Initial-fill bug post-mortem (PR-2a hotfix, 2026-05-17):
//     v1 used INSERT … ON CONFLICT DO UPDATE batched at 50 rows.
//     Feeds like malwarebazaar dump multiple threats rows per
//     malicious_domain (e.g. five rows of '0.0.0.0'), and SQLite
//     fails the entire batch when the same statement contains
//     duplicate PK values. The catch swallowed the error and only
//     the alphabetically-last batch (z* domains, no dupes by luck)
//     succeeded. Two fixes here: dedupe candidates in JS via Map,
//     and switch to INSERT OR IGNORE so state-drift correction is
//     deferred to PR-3 (where dns-backfill writes both tables).
//
//   - Bounded per tick. Initial backfill (queue empty, 18K
//     candidates) splits across ~4 ticks via MAX_INSERTS_PER_TICK.
//     Steady state writes only the small delta. Caps protect
//     Navigator's 30s CPU budget — v1 burned 99s wall-clock per
//     tick trying to flush all batches.
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
  /** rows_written on the queue side from INSERT OR IGNORE. */
  enqueued: number;
  /** rows_written on the queue side from DELETE. */
  dequeued: number;
  /** Unique candidate count in threats (post-dedupe). */
  candidatesInThreats: number;
  queueSize: number;
  /** queueSize - candidatesInThreats. Positive = queue has stale rows
   *  not yet dequeued. Negative = threats has candidates not yet
   *  enqueued. Should converge to 0 within a few ticks of empty start. */
  delta: number;
  durationMs: number;
}

// Chunk size for IN(?,?,?...) batches. SQLite has a max of ~999
// parameters per statement; 50 keeps us well below and matches the
// pattern used in dns-backfill.ts so the planner cost is comparable.
const CHUNK_SIZE = 50;

// Hard cap on the candidate read. Cheap (strict-index scan) — full
// table coverage in one read is fine.
const READ_LIMIT = 50_000;

// Per-tick write caps. v1 unbounded ran 367 batches × ~250ms =
// 92s wall-clock per tick. With these caps each tick handles a
// bounded slice and the queue converges over 3-4 ticks from empty.
// Steady-state writes are tiny (feed ingestion ~few-hundred/hour
// new candidates) so caps almost never bite after first fill.
const MAX_INSERTS_PER_TICK = 5_000;
const MAX_DELETES_PER_TICK = 500;

interface CandidateRow {
  malicious_domain: string;
  enrichment_attempts: number;
  attempted_resolve_at: string | null;
  source_feed: string | null;
}

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
    // Uses the strict partial index landed in migration 0195. Includes
    // duplicates because feeds can write multiple threats rows for the
    // same malicious_domain (e.g. malwarebazaar's repeated '0.0.0.0'
    // rows). Dedupe happens in step 2.
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
    `).bind(READ_LIMIT).all<CandidateRow>();

    // ── 2. Dedupe by malicious_domain ──
    // Keep first occurrence; per-row state is owned by dns-backfill
    // after PR-3 so the dedupe choice only matters for the INITIAL
    // fill. INSERT OR IGNORE ignores conflicts so the queue ends up
    // with the first-seen row for any duplicated domain.
    const uniqueByDomain = new Map<string, CandidateRow>();
    for (const c of candidatesRes.results) {
      if (!uniqueByDomain.has(c.malicious_domain)) {
        uniqueByDomain.set(c.malicious_domain, c);
      }
    }
    const candidateDomains = new Set(uniqueByDomain.keys());

    // ── 3. Snapshot current dns_queue ──
    const queueRes = await env.DNS_QUEUE_DB.prepare(
      `SELECT malicious_domain FROM dns_queue`
    ).all<{ malicious_domain: string }>();
    const queueDomains = queueRes.results.map((r) => r.malicious_domain);
    const queueSet = new Set(queueDomains);

    // ── 4. INSERT new candidates not yet in queue ──
    // Only insert the DIFF (candidates not in queue). Avoids re-running
    // a no-op INSERT OR IGNORE against the entire candidate set every
    // tick — saves ~5K subrequests/tick once the queue is full.
    // Capped at MAX_INSERTS_PER_TICK so an empty-queue first run
    // converges over a few ticks instead of burning the CPU budget
    // in one shot.
    const toInsert: CandidateRow[] = [];
    for (const [domain, row] of uniqueByDomain) {
      if (!queueSet.has(domain)) {
        toInsert.push(row);
        if (toInsert.length >= MAX_INSERTS_PER_TICK) break;
      }
    }

    let enqueued = 0;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      // No duplicate PKs in any chunk — toInsert was built from a Map.
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
        // INSERT OR IGNORE — silently no-op on PK conflict. Avoids
        // both the UPSERT cost AND the SQLite "duplicate keys in
        // single statement" failure mode that bricked v1. State drift
        // (attempts/cooldown stale relative to threats) is acceptable
        // here; PR-3 makes dns-backfill the authoritative writer.
        const r = await env.DNS_QUEUE_DB.prepare(`
          INSERT OR IGNORE INTO dns_queue
            (malicious_domain, enrichment_attempts, attempted_resolve_at, source_feed, enqueued_at)
          VALUES ${placeholders}
        `).bind(...params).run();
        enqueued += r.meta?.changes ?? 0;
      } catch (err) {
        // Best-effort — log and continue. Next tick will retry the
        // same domains via the diff. Never let a queue write break
        // the reconciler loop.
        console.error('[dns-queue-reconciler] enqueue batch failed:', err);
      }
    }

    // ── 5. DELETE stale rows ──
    // A queue row is stale iff its malicious_domain is NOT in the
    // current candidate snapshot. This means one of: (a) the
    // underlying threat got an ip_address (resolved), (b) status
    // changed off 'active', (c) attempts hit the cap, (d) the row
    // was deleted. All four are correct reasons to drop from queue.
    // Capped at MAX_DELETES_PER_TICK.
    const staleDomains: string[] = [];
    for (const d of queueDomains) {
      if (!candidateDomains.has(d)) {
        staleDomains.push(d);
        if (staleDomains.length >= MAX_DELETES_PER_TICK) break;
      }
    }

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
      candidatesInThreats: candidateDomains.size,
      queueSize: queueDomains.length,
      delta: queueDomains.length - candidateDomains.size,
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
