// Averrow — threats-side DNS candidate count (shared cache contract).
//
// `COUNT(DISTINCT malicious_domain)` over every active, unresolved,
// non-exhausted threat — the parity partner for dns_queue's row count.
// It is a full-table read on `threats`, so both readers (Flight Control's
// `platform_dns_queue_drift` / `_stalled` checks, and the diagnostics
// `dns_queue_parity` block) share ONE cachedCount key and ONE TTL, defined
// here so they cannot drift apart (a shorter TTL at one site would reject
// the other site's entry and force a recompute).
//
// TTL rationale: FC runs once per hour, so any TTL under 3600s made every
// FC read a miss; at 5400s FC recomputes every other tick. The drift alert
// compares this number to the dns_queue size against a 500-row threshold;
// Flight Control re-verifies with a fresh, uncached count before it emits
// either alert (see agents/flightControl.ts), so this count's staleness can
// delay detection (until the entry expires) but never cause a false alert.

import { seedCount } from "./cached-count";

/** Shared cachedCount key — FC and diagnostics MUST both use it. */
export const DNS_DRAINABLE_CACHE_KEY = "count.threats.dns_drainable";

/** Shared TTL (90 min) — exceeds FC's hourly cadence. */
export const DNS_DRAINABLE_TTL_S = 5400;

/**
 * Threats-side DNS candidate count. Keep the predicate in sync with
 * lib/dns-queue-reconciler.ts's candidate SELECT and lib/dns-queue-reaper.ts
 * (those wrap the same core conditions in non-identical, load-bearing SQL —
 * INDEXED BY hints, cursor predicates — so the fragment isn't shared).
 */
export async function countDnsCandidatesInThreats(db: D1Database): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(DISTINCT malicious_domain) AS n
    FROM threats
    WHERE ip_address IS NULL
      AND status = 'active'
      AND dns_exhausted_at IS NULL
      AND malicious_domain IS NOT NULL
      AND malicious_domain != ''
      AND malicious_domain NOT LIKE '*%'
      AND malicious_domain LIKE '%.%'
  `).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Drift between dns_queue's size and the threats-side candidate count,
 * re-verified against a fresh count whenever the (possibly stale) cached
 * value crosses `threshold`. Every alert keyed on this drift requires
 * `drift > threshold`, so verifying only in that case means cache staleness
 * can delay an alert but never fire one on its own.
 */
export async function resolveDnsDrift(opts: {
  queueSize: number;
  cachedDrainable: number;
  threshold: number;
  recount: () => Promise<number>;
  /** When given, a fresh recount is written back to the shared
   *  DNS_DRAINABLE_CACHE_KEY so diagnostics' dns_queue_parity stops showing
   *  the stale (phantom-drift) value and the next tick doesn't re-scan. */
  env?: { CACHE?: KVNamespace };
}): Promise<{ drainable: number; drift: number; verified: boolean }> {
  const cachedDrift = Math.abs(opts.queueSize - opts.cachedDrainable);
  if (cachedDrift <= opts.threshold) {
    return { drainable: opts.cachedDrainable, drift: cachedDrift, verified: false };
  }
  const drainable = await opts.recount();
  if (opts.env) await seedCount(opts.env, DNS_DRAINABLE_CACHE_KEY, drainable, DNS_DRAINABLE_TTL_S);
  return { drainable, drift: Math.abs(opts.queueSize - drainable), verified: true };
}
