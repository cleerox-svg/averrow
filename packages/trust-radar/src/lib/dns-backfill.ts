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

  const empty: DnsBackfillResult = {
    processed: 0, resolved: 0, enriched: 0, graduatedDead: 0, durationMs: 0, softCapHit: false,
  };

  try {
    // ── Fetch next batch of unique unresolved domains ──
    //
    // Cooldown: 6h flat. Malicious domains usually live <48h, so
    // a 7-day cooldown (the previous setting) meant we missed the
    // window entirely. 6h × 8 attempts = 48h max lifecycle per
    // domain, capped by enrichment_attempts < 8 to stop churning
    // permanently-dead domains.
    //
    // The platform priority (per operator) is "as fast as possible"
    // — every malicious domain should get tried within hours of
    // ingestion, not days.
    const batch = await env.DB.prepare(`
      SELECT DISTINCT malicious_domain
      FROM threats
      WHERE (ip_address IS NULL OR ip_address = '')
        AND malicious_domain IS NOT NULL
        AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%'
        AND malicious_domain LIKE '%.%'
        AND COALESCE(enrichment_attempts, 0) < 8
        AND (attempted_resolve_at IS NULL
             OR attempted_resolve_at < datetime('now', '-6 hours'))
      LIMIT ?
    `).bind(batchSize).all<{ malicious_domain: string }>();

    const domains = batch.results.map((r) => r.malicious_domain);
    if (domains.length === 0) {
      return { ...empty, durationMs: Date.now() - start };
    }

    // ── Step 0: pre-stamp claim ──
    //
    // Atomically claim every selected domain by stamping
    // `attempted_resolve_at = now` BEFORE running DoH resolution.
    // Without this, a soft-cap during resolution leaves the stamp
    // path unreached — the same 200 domains keep re-selecting on
    // every subsequent tick because their cooldown gate never
    // moves. Diagnostic evidence (2026-05-04): 90%+ of navigator
    // ticks recorded `records_processed = 0` and only ~490 rows
    // had `attempted_resolve_at` advanced in the prior 24h vs. a
    // theoretical capacity of ~92K stamp events/day.
    //
    // Pre-stamp does NOT bump `enrichment_attempts` — the attempts
    // counter only advances when an outcome (resolved / dead /
    // transient) is recorded later. This separates "I tried to do
    // work" (attempted_resolve_at, advances cooldown) from "this
    // domain is exhausting its retry budget" (enrichment_attempts,
    // graduates to cap=8). Step 3b skips domains whose attempts
    // are already at cap so we never double-bump past the cap.
    //
    // Chunked at 50 placeholders to stay well below D1's max-SQL-
    // variables ceiling (200 placeholders trigger `too many SQL
    // variables` per a 2026-05-04 production probe). Matches the
    // chunking pattern used by Step 3a/3b below.
    //
    // Each chunk dispatches TWO statements (ip_address IS NULL and
    // ip_address = '') in a single db.batch() rather than one
    // statement with `(ip_address IS NULL OR ip_address = '')`. The
    // OR variant defeated SQLite's partial-index planner — observed
    // 60K rows read per execution (47M / 24h, 788 calls) where the
    // theoretical lower bound is ~300 rows. Splitting lets each
    // branch match `idx_threats_dns_backfill_select`'s partial WHERE
    // unambiguously so the planner uses it for both branches.
    // Phase 4 of the D1 spend-reduction track.
    //
    // D1 spend reduction (2026-05-16): both UPDATEs gained
    // `status='active' AND COALESCE(enrichment_attempts, 0) < 8` so the
    // new `idx_threats_dns_pending_strict` partial index (migration
    // 0195) can be used. Without the matching filter the query is a
    // superset of the strict index and SQLite falls back to the wider
    // `idx_threats_dns_backfill` (~120K rows). With the filter the
    // query is a subset and the planner narrows to ~60K rows. Skipping
    // attempted_resolve_at updates on inactive/exhausted threats is
    // correct — they aren't candidates for resolution anyway, so
    // leaving their attempted_resolve_at stale has no observable effect.
    const PRE_STAMP_CHUNK = 50;
    try {
      for (let i = 0; i < domains.length; i += PRE_STAMP_CHUNK) {
        const chunk = domains.slice(i, i + PRE_STAMP_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        await env.DB.batch([
          env.DB.prepare(`
            UPDATE threats
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
      // If the pre-stamp fails (D1 transient), bail out cleanly.
      // Re-running the whole batch on the next tick is safe and
      // preferable to running resolution against an unclaimed
      // batch (which would re-select the same domains forever).
      console.error('[dns-backfill] pre-stamp claim failed:', err);
      return { ...empty, durationMs: Date.now() - start };
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
    // Cartographer picks up these rows (enriched_at IS NULL, ip_address IS NOT NULL)
    // on its next hourly tick for geo/ASN/provider enrichment.
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
      }
    }

    if (isOverCap()) softCapHit = true;

    // ── Step 3a: graduate confirmed-dead domains ──
    // All 3 resolvers said NXDOMAIN or no A record — authoritative
    // enough to stop trying. Push enrichment_attempts to the cap (8)
    // so the SELECT filter excludes them on every future tick.
    // attempted_resolve_at was already advanced in Step 0; we only
    // need to advance the attempts counter here.
    let graduatedDead = 0;
    if (confirmedDead.size > 0) {
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
          console.error('[dns-backfill] dead-domain graduation failed:', err);
        }
      }
    }

    // ── Step 3b: bump enrichment_attempts for transient failures ──
    // For domains that hit a transient failure (timeout, SERVFAIL,
    // resolver disagreement). Increments enrichment_attempts by 1
    // so the cap-at-8 filter in the SELECT eventually exits them.
    // attempted_resolve_at was advanced in Step 0; we don't re-stamp.
    //
    // Skip resolved domains (Step 2 wrote ip_address) and dead ones
    // (Step 3a stamped attempts=8) — both are now ineligible. We also
    // gate on enrichment_attempts < 8 so a domain can't be bumped to
    // 9; that would skew per-feed retry-cap diagnostics.
    const transient: string[] = [];
    for (const d of attempted) {
      if (!domainToIp.has(d) && !confirmedDead.has(d)) transient.push(d);
    }
    if (transient.length > 0) {
      const STAMP_CHUNK = 50;
      for (let i = 0; i < transient.length; i += STAMP_CHUNK) {
        if (isOverCap()) { softCapHit = true; break; }
        const chunk = transient.slice(i, i + STAMP_CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        try {
          // D1 spend reduction (2026-05-16): split the OR into two
          // batched UPDATEs (same Phase 4 reasoning as the pre-stamp
          // block above) and add `status='active'` so the
          // `idx_threats_dns_pending_strict` partial index (migration
          // 0195) gets used. Pre-fix was 111K rows/call × 593 calls
          // = 66M/24h; post-fix should be ~15K rows/call.
          await env.DB.batch([
            env.DB.prepare(`
              UPDATE threats
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
          console.error('[dns-backfill] attempts bump failed:', err);
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
    };
  } catch (err) {
    console.error('[dns-backfill] Fatal error:', err);
    return { ...empty, durationMs: Date.now() - start };
  }
}
