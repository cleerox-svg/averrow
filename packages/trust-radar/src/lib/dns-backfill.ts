// DNS Backfill — resolve malicious domains to IP addresses.
//
// Uses Cloudflare DoH (1.1.1.1) via lib/domain-resolver.ts.
// Writes ip_address to the threats table; geo enrichment (lat/lng,
// country, ASN, hosting provider) is handled by Cartographer on its
// next hourly tick.
//
// Shared between:
//   1. POST /api/admin/backfill-domain-geo  (admin UI button)
//   2. The Navigator cron (every 5 min)      (automated background drain)
//
// Never throws — always returns a structured result.
//
// PR-3 (DNS-queue split, 2026-05-17):
//   The candidate SELECT reads from the dedicated `trust-radar-dns-queue`
//   D1 (binding DNS_QUEUE_DB) when present. Reads went from ~19.5K rows
//   on threats to 500 rows on dns_queue — a 39× per-call reduction, plus
//   the read shifts to dns_queue's own 25B-row/month budget instead of
//   competing with main `trust-radar-v2`.
//
//   State mutations (pre-stamp, attempts++, dead/resolved drain) are
//   DUAL-WRITTEN to both threats and dns_queue during this transition.
//   Reasons:
//   - Other readers (FC backlog, diagnostics, admin endpoint) still
//     query threats for cooldown/attempts state. Keeping threats in
//     sync avoids cascading their migration into this PR.
//   - If we revert this PR, threats remains authoritative — clean
//     rollback path.
//   - PR-4 cleanup drops the threats-side dual-writes once those
//     readers migrate to dns_queue and the threats-side dns indexes
//     are no longer needed.
//
//   When DNS_QUEUE_DB is unbound (dev environments), the legacy
//   threats-only path runs unchanged.

import type { Env } from '../types';
import { resolveDomain, extractHostname } from './domain-resolver';

export interface DnsBackfillResult {
  processed: number;
  resolved: number;
  enriched: number;
  /** Domains that all 3 resolvers agreed don't exist or have no A
   *  record. Graduated out of the queue immediately by stamping
   *  enrichment_attempts to the cap. Counts as drained. */
  graduatedDead: number;
  durationMs: number;
  softCapHit: boolean;
  /** PR-3: 'queue' when read came from dns_queue, 'threats' on the
   *  legacy fallback path. Surfaced in agent_outputs so an operator
   *  can confirm at a glance whether the split is in effect. */
  readSource: 'queue' | 'threats';
}

export interface DnsBackfillOpts {
  /** Number of distinct domains to resolve per batch. Default 200. */
  batchSize?: number;
  /** Soft time cap in ms — stop starting new phases once exceeded. Default 8000. */
  timeoutMs?: number;
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 8000;
const CONCURRENCY = 50;

/**
 * Resolve one batch of unresolved malicious_domain values and write the
 * resulting IP addresses back to the threats table via db.batch().
 *
 * Geo enrichment is NOT performed here — Cartographer picks up the
 * newly-IP'd rows on its next scheduled run.
 *
 * Safe to call from cron — never throws.
 */
export async function runDomainGeoBackfillBatch(
  env: Env,
  opts?: DnsBackfillOpts,
): Promise<DnsBackfillResult> {
  const start = Date.now();
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const isOverCap = () => Date.now() - start > timeoutMs;

  // Narrow the optional binding into a stable local so TS treats every
  // call site as definite once we've branched on it.
  const queueDb = env.DNS_QUEUE_DB;
  const useQueueDb = !!queueDb;

  const empty: DnsBackfillResult = {
    processed: 0, resolved: 0, enriched: 0, graduatedDead: 0, durationMs: 0, softCapHit: false,
    readSource: useQueueDb ? 'queue' : 'threats',
  };

  try {
    // ── Fetch next batch of unique unresolved domains ──
    //
    // PR-3 read path: when DNS_QUEUE_DB is bound, read from the
    // dns_queue side table. EXPLAIN QUERY PLAN confirmed on prod:
    //
    //   SCAN dns_queue USING INDEX idx_dns_queue_drainable
    //
    // Index-only scan, LIMIT walks the index — 500 rows read per call
    // (vs 19,553 on the legacy threats-side strict index). The read
    // also moves to dns_queue's own 25B/month budget.
    //
    // Note on bare `enrichment_attempts < 8` (no COALESCE): the
    // dns_queue.enrichment_attempts column is NOT NULL DEFAULT 0, so
    // COALESCE is unnecessary AND defeats the partial-index predicate
    // matcher in SQLite. Verified via EXPLAIN: COALESCE → SCAN
    // dns_queue (full); bare comparison → SCAN ... USING INDEX. The
    // reconciler in lib/dns-queue-reconciler.ts honors the same shape.
    //
    // Legacy threats path: unchanged. Runs when DNS_QUEUE_DB is
    // unbound (dev) or temporarily reverted for rollback.
    let candidates: { malicious_domain: string }[];
    if (useQueueDb && queueDb) {
      const r = await queueDb.prepare(`
        SELECT malicious_domain
        FROM dns_queue INDEXED BY idx_dns_queue_drainable
        WHERE enrichment_attempts < 8
          AND (attempted_resolve_at IS NULL
               OR attempted_resolve_at < datetime('now', '-6 hours'))
        LIMIT ?
      `).bind(batchSize).all<{ malicious_domain: string }>();
      candidates = r.results;
    } else {
      const r = await env.DB.prepare(`
        SELECT DISTINCT malicious_domain
        FROM threats INDEXED BY idx_threats_dns_pending_strict
        WHERE ip_address IS NULL
          AND status = 'active'
          AND COALESCE(enrichment_attempts, 0) < 8
          AND malicious_domain IS NOT NULL
          AND malicious_domain != ''
          AND malicious_domain NOT LIKE '*%'
          AND malicious_domain LIKE '%.%'
          AND (attempted_resolve_at IS NULL
               OR attempted_resolve_at < datetime('now', '-6 hours'))
        LIMIT ?
      `).bind(batchSize).all<{ malicious_domain: string }>();
      candidates = r.results;
    }

    const domains = candidates.map((r) => r.malicious_domain);
    if (domains.length === 0) {
      return { ...empty, durationMs: Date.now() - start };
    }

    // ── Step 0: pre-stamp claim ──
    //
    // Atomically claim every selected domain by stamping
    // attempted_resolve_at = now in dns_queue BEFORE running DoH
    // resolution. The claim has to be visible to the NEXT tick's
    // SELECT before the resolution work completes — otherwise a
    // soft-cap during DoH leaves the same domains re-selectable on
    // the next tick.
    //
    // PR-4 cleanup: removed the threats-side UPDATE that was part
    // of PR-3's dual-write transition. dns_queue is now the sole
    // source of cooldown/attempts state. The threats table just
    // holds the `ip_address` deliverable once resolution succeeds.
    // Frees ~5.5M reads/day on the main DB.
    //
    // Pre-stamp does NOT bump enrichment_attempts — the counter
    // only advances when an outcome (resolved / dead / transient)
    // is recorded later.
    //
    // Chunked at 50 placeholders for D1's max-SQL-variables ceiling.
    const PRE_STAMP_CHUNK = 50;
    if (useQueueDb && queueDb) {
      try {
        for (let i = 0; i < domains.length; i += PRE_STAMP_CHUNK) {
          const chunk = domains.slice(i, i + PRE_STAMP_CHUNK);
          const placeholders = chunk.map(() => '?').join(',');
          await queueDb.prepare(`
            UPDATE dns_queue SET attempted_resolve_at = datetime('now')
            WHERE malicious_domain IN (${placeholders})
          `).bind(...chunk).run();
        }
      } catch (err) {
        // If the pre-stamp fails (D1 transient), bail out cleanly.
        // Re-running the whole batch on the next tick is safe and
        // preferable to running resolution against an unclaimed
        // batch (which would re-select the same domains forever).
        console.error('[dns-backfill] pre-stamp claim failed:', err);
        return { ...empty, durationMs: Date.now() - start };
      }
    } else {
      // Legacy threats-only path — only runs in dev environments
      // without the DNS_QUEUE_DB binding.
      try {
        for (let i = 0; i < domains.length; i += PRE_STAMP_CHUNK) {
          const chunk = domains.slice(i, i + PRE_STAMP_CHUNK);
          const placeholders = chunk.map(() => '?').join(',');
          await env.DB.batch([
            env.DB.prepare(`
              UPDATE threats INDEXED BY idx_threats_dns_pending_strict
              SET attempted_resolve_at = datetime('now')
              WHERE malicious_domain IN (${placeholders})
                AND ip_address IS NULL
                AND status = 'active'
                AND COALESCE(enrichment_attempts, 0) < 8
            `).bind(...chunk),
            env.DB.prepare(`
              UPDATE threats
              SET attempted_resolve_at = datetime('now')
              WHERE malicious_domain IN (${placeholders})
                AND ip_address = ''
                AND status = 'active'
                AND COALESCE(enrichment_attempts, 0) < 8
            `).bind(...chunk),
          ]);
        }
      } catch (err) {
        console.error('[dns-backfill] pre-stamp claim failed:', err);
        return { ...empty, durationMs: Date.now() - start };
      }
    }

    // ── Step 1: parallel DoH resolution, capped at CONCURRENCY ──
    // Three buckets:
    //   - domainToIp: resolver returned an A record → write ip_address
    //   - confirmedDead: all 3 resolvers agree NXDOMAIN or no A
    //     record → graduate immediately (attempts stamped to cap)
    //   - attempted ∖ (domainToIp ∪ confirmedDead): transient
    //     failure → normal retry path (attempts++ on stamp step)
    const domainToIp = new Map<string, string>();
    const confirmedDead = new Set<string>();
    const attempted = new Set<string>();
    let cursor = 0;
    let softCapHit = false;

    async function worker(): Promise<void> {
      while (cursor < domains.length) {
        if (isOverCap()) { softCapHit = true; return; }
        const i = cursor++;
        const domain = domains[i];
        if (!domain) continue;
        attempted.add(domain);
        const hostname = extractHostname(domain);
        if (!hostname) continue;
        const outcome = await resolveDomain(hostname);
        if (outcome.kind === 'ok') {
          domainToIp.set(domain, outcome.ip);
        } else if (outcome.kind === 'nxdomain' || outcome.kind === 'no_a_record') {
          confirmedDead.add(domain);
        }
        // 'transient' → no special handling; fall through to the
        // normal stamp step which bumps attempts by 1.
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, domains.length) }, () => worker()),
    );

    if (isOverCap()) softCapHit = true;
    const resolved = domainToIp.size;

    // ── Step 2: batch-write ip_address to threats via db.batch() ──
    // One round-trip per chunk instead of N individual UPDATEs.
    // Cartographer picks up these rows (enriched_at IS NULL,
    // ip_address IS NOT NULL) on its next hourly tick for
    // geo/ASN/provider enrichment.
    //
    // PR-3 dual-write: after threats UPDATE, DELETE the resolved
    // domains from dns_queue. The queue's existence semantics are
    // "still needs DNS" — resolved means it leaves.
    let enriched = 0;
    if (resolved > 0 && !softCapHit) {
      const BATCH_CHUNK = 100;
      const entries = [...domainToIp.entries()];

      for (let i = 0; i < entries.length; i += BATCH_CHUNK) {
        if (isOverCap()) { softCapHit = true; break; }
        const chunk = entries.slice(i, i + BATCH_CHUNK);
        const stmts = chunk.map(([domain, ip]) =>
          env.DB.prepare(`
            UPDATE threats
            SET ip_address = ?, enriched_at = NULL
            WHERE malicious_domain = ?
              AND (ip_address IS NULL OR ip_address = '')
              AND status = 'active'
          `).bind(ip, domain),
        );
        try {
          const results = await env.DB.batch(stmts);
          for (const r of results) {
            enriched += r.meta?.changes ?? 0;
          }
        } catch (err) {
          console.error('[dns-backfill] batch ip_address write failed:', err);
        }

        // Drain from dns_queue. Bounded to the same chunk we just
        // wrote — keeps DELETE batched and idempotent (no-op when
        // already removed).
        if (useQueueDb && queueDb) {
          const dropDomains = chunk.map(([d]) => d);
          const ph = dropDomains.map(() => '?').join(',');
          try {
            await queueDb.prepare(
              `DELETE FROM dns_queue WHERE malicious_domain IN (${ph})`
            ).bind(...dropDomains).run();
          } catch (err) {
            console.error('[dns-backfill] dns_queue drain (resolved) failed:', err);
          }
        }
      }
    }

    if (isOverCap()) softCapHit = true;

    // ── Step 3a: graduate confirmed-dead domains ──
    // All 3 resolvers said NXDOMAIN or no A record — authoritative
    // enough to stop trying. Stamp enrichment_attempts to the cap
    // (8) and last_outcome='dead' in dns_queue.
    //
    // PR-4 cleanup: switched from DELETE to UPDATE on dns_queue
    // because the reconciler reads candidates from threats by
    // existence (ip_address IS NULL). If we DELETE from the queue,
    // the reconciler re-adds on its next tick — there's no threats-
    // side state left to flag the row as graduated. Keeping the
    // dead row with attempts=8 makes the reconciler's queueSet
    // check return true → no re-add, while the dns-backfill SELECT
    // filter (enrichment_attempts < 8) still excludes it from
    // future draining. Cleanup of dead rows is a follow-up reaper.
    //
    // We no longer write threats.enrichment_attempts — dns_queue is
    // the source of truth for state, and threats only holds the
    // ip_address deliverable.
    let graduatedDead = 0;
    if (confirmedDead.size > 0 && useQueueDb && queueDb) {
      const DEAD_CHUNK = 50;
      const deadArr = [...confirmedDead];
      for (let i = 0; i < deadArr.length; i += DEAD_CHUNK) {
        if (isOverCap()) { softCapHit = true; break; }
        const chunk = deadArr.slice(i, i + DEAD_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        try {
          const r = await queueDb.prepare(`
            UPDATE dns_queue
            SET enrichment_attempts = 8,
                last_outcome = 'dead'
            WHERE malicious_domain IN (${placeholders})
          `).bind(...chunk).run();
          graduatedDead += r.meta?.changes ?? 0;
        } catch (err) {
          console.error('[dns-backfill] dead-domain graduation failed:', err);
        }
      }
    } else if (confirmedDead.size > 0) {
      // Legacy threats-only path. Threats.enrichment_attempts=8 is
      // the historical exhausted marker for environments without
      // DNS_QUEUE_DB bound.
      const DEAD_CHUNK = 50;
      const deadArr = [...confirmedDead];
      for (let i = 0; i < deadArr.length; i += DEAD_CHUNK) {
        if (isOverCap()) { softCapHit = true; break; }
        const chunk = deadArr.slice(i, i + DEAD_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        try {
          const r = await env.DB.prepare(`
            UPDATE threats
            SET enrichment_attempts = 8
            WHERE malicious_domain IN (${placeholders})
              AND (ip_address IS NULL OR ip_address = '')
          `).bind(...chunk).run();
          graduatedDead += r.meta?.changes ?? 0;
        } catch (err) {
          console.error('[dns-backfill] dead-domain graduation (legacy) failed:', err);
        }
      }
    }

    // ── Step 3b: bump enrichment_attempts for transient failures ──
    // For domains that hit a transient failure (timeout, SERVFAIL,
    // resolver disagreement). Increments enrichment_attempts by 1
    // in dns_queue so the cap-at-8 filter eventually exits them.
    //
    // attempted_resolve_at was advanced in Step 0; we don't re-stamp.
    // Skip resolved domains (Step 2 wrote ip_address) and dead ones
    // (Step 3a deleted from queue) — both are now ineligible.
    //
    // PR-4 cleanup: removed the threats-side UPDATE that was part
    // of PR-3's dual-write transition. dns_queue is the source of
    // truth for attempts state.
    const transient: string[] = [];
    for (const d of attempted) {
      if (!domainToIp.has(d) && !confirmedDead.has(d)) transient.push(d);
    }
    if (transient.length > 0 && useQueueDb && queueDb) {
      const STAMP_CHUNK = 50;
      for (let i = 0; i < transient.length; i += STAMP_CHUNK) {
        if (isOverCap()) { softCapHit = true; break; }
        const chunk = transient.slice(i, i + STAMP_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        try {
          await queueDb.prepare(`
            UPDATE dns_queue
            SET enrichment_attempts = enrichment_attempts + 1
            WHERE malicious_domain IN (${placeholders})
              AND enrichment_attempts < 8
          `).bind(...chunk).run();
        } catch (err) {
          console.error('[dns-backfill] transient bump failed:', err);
        }
      }
    } else if (transient.length > 0) {
      // Legacy threats-only path — dev environments without
      // DNS_QUEUE_DB. Keeps the original Phase-4 split for cost-safe
      // partial-index usage.
      const STAMP_CHUNK = 50;
      for (let i = 0; i < transient.length; i += STAMP_CHUNK) {
        if (isOverCap()) { softCapHit = true; break; }
        const chunk = transient.slice(i, i + STAMP_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        try {
          await env.DB.batch([
            env.DB.prepare(`
              UPDATE threats INDEXED BY idx_threats_dns_pending_strict
              SET enrichment_attempts = COALESCE(enrichment_attempts, 0) + 1
              WHERE malicious_domain IN (${placeholders})
                AND ip_address IS NULL
                AND status = 'active'
                AND COALESCE(enrichment_attempts, 0) < 8
            `).bind(...chunk),
            env.DB.prepare(`
              UPDATE threats
              SET enrichment_attempts = COALESCE(enrichment_attempts, 0) + 1
              WHERE malicious_domain IN (${placeholders})
                AND ip_address = ''
                AND status = 'active'
                AND COALESCE(enrichment_attempts, 0) < 8
            `).bind(...chunk),
          ]);
        } catch (err) {
          console.error('[dns-backfill] transient bump (legacy) failed:', err);
        }
      }
    }

    return {
      processed: attempted.size,
      resolved,
      enriched,
      graduatedDead,
      durationMs: Date.now() - start,
      softCapHit,
      readSource: useQueueDb ? 'queue' : 'threats',
    };
  } catch (err) {
    console.error('[dns-backfill] Fatal error:', err);
    return { ...empty, durationMs: Date.now() - start };
  }
}
