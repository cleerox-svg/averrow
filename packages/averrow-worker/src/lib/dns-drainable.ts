// Averrow — threats-side DNS candidate count (shared cache contract).
//
// `COUNT(DISTINCT malicious_domain)` over every active, unresolved,
// non-exhausted threat — the parity partner for dns_queue's row count.
// It is a full-table read on `threats` (~1.5M rows; plan = temp B-tree
// for the DISTINCT + per-row table lookups, 1.5–2.7M rows read), so every
// reader shares ONE KV key and ONE TTL, defined here.
//
// ── Cadence (2026-11-07 orchestrator-kill fix) ───────────────────
// The scan used to run inside Flight Control on ~every other hourly tick
// (TTL 5400s, recompute on miss, plus a second "verification" recount on
// suspected drift). FC runs first in the `7 * * * *` orchestrator
// invocation, so on D1-overloaded ticks the scan got that invocation
// killed before runAllFeeds — hourly feed ingestion stalled.
//
// Now:
//   - The ONLY writer is `runDnsDrainableRecount`, called by Navigator
//     (`*/5`, its own invocation, via ctx.waitUntil) on the UTC hour
//     `DNS_DRAINABLE_RECOUNT_HOUR_UTC` (hour-only gate — no minute gate,
//     per the CLAUDE.md cron-audit rule). A KV claim keeps overlapping
//     5-min ticks from scanning concurrently; an entry < 1h old skips.
//   - Flight Control only PEEKS (`readDnsDrainableForTick`). It never
//     scans. A count is "fresh" when computed within
//     `DNS_DRAINABLE_FRESH_S` (90 min), so FC's 03:07 and 04:07 ticks see
//     a fresh value each day.
//   - `platform_dns_queue_drift` acts only on a fresh count — a stale
//     count vs a draining queue would read as phantom drift.
//   - `platform_dns_queue_stalled` stays hourly via the reconciler's own
//     diagnostic (cursor_stuck, or lag + a full page that enqueued work).
//   - diagnostics reads the shared key (TTL 26h) and reports its age.

import { peekCountEntry, seedCount } from "./cached-count";
import { RECONCILER_READ_LIMIT } from "./dns-queue-reconciler";

/** Shared KV key (cachedCount envelope) — every reader MUST use it. */
export const DNS_DRAINABLE_CACHE_KEY = "count.threats.dns_drainable";

/** Shared TTL (26h) — exceeds the once-per-day recount cadence with 2h of
 *  slack, so a slightly late recount never leaves the key expired. */
export const DNS_DRAINABLE_TTL_S = 93_600;

/** UTC hour on which Navigator recomputes the count. Hour 3 carries no
 *  hourly-orchestrator gate and no Navigator hour-0 maintenance. */
export const DNS_DRAINABLE_RECOUNT_HOUR_UTC = 3;

/** An entry younger than this is not recounted (a prior Navigator tick in
 *  the recount hour already did it, or diagnostics computed it). */
export const DNS_DRAINABLE_SKIP_IF_YOUNGER_S = 3_600;

/** A count this young is "fresh": count-based alerts may act on it. */
export const DNS_DRAINABLE_FRESH_S = 5_400;

/** KV lease taken before the scan so overlapping Navigator ticks don't both
 *  run it. Left in place after success or failure: a failure (D1
 *  overloaded) is retried at most every lease period, ≤3× in the hour. */
export const DNS_DRAINABLE_CLAIM_KEY = "dns_drainable:recount_claim";
export const DNS_DRAINABLE_CLAIM_TTL_S = 1_200;

/**
 * Threats-side DNS candidate count. Keep the predicate in sync with
 * lib/dns-queue-reconciler.ts's candidate SELECT and lib/dns-queue-reaper.ts
 * (those wrap the same core conditions in non-identical, load-bearing SQL —
 * INDEXED BY hints, cursor predicates — so the fragment isn't shared).
 *
 * EXPENSIVE (full threats scan). Call only via `runDnsDrainableRecount`
 * (daily, Navigator) or on demand from diagnostics when the key is absent.
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

/** True on the UTC hour Navigator is allowed to run the full count. */
export function isDnsDrainableRecountHour(nowMs: number): boolean {
  return new Date(nowMs).getUTCHours() === DNS_DRAINABLE_RECOUNT_HOUR_UTC;
}

export type DnsDrainableRecountResult =
  | { ran: true; drainable: number; durationMs: number }
  | { ran: false; reason: "not_recount_hour" | "over_budget" | "fresh" | "claimed" | "error"; error?: string };

/**
 * Navigator's daily recount. Hour-only gate, then: skip when the budget
 * says so, skip when the entry is < 1h old, skip when another tick holds
 * the claim; otherwise take the claim, scan once, seed the shared key.
 * Never throws (runs in a waitUntil tail).
 *
 * The claim is best-effort (KV is eventually consistent): two ticks 5 min
 * apart see each other's claim; truly simultaneous invocations don't
 * exist for a single `*\/5` cron.
 */
export async function runDnsDrainableRecount(opts: {
  env: { CACHE?: KVNamespace };
  nowMs: number;
  recount: () => Promise<number>;
  /** True when the D1 read budget is over its soft-cap — skip the scan. */
  overBudget?: boolean;
}): Promise<DnsDrainableRecountResult> {
  if (!isDnsDrainableRecountHour(opts.nowMs)) return { ran: false, reason: "not_recount_hour" };
  if (opts.overBudget) return { ran: false, reason: "over_budget" };
  const { env } = opts;
  if (!env.CACHE) return { ran: false, reason: "error", error: "CACHE binding unset" };
  try {
    if (await peekCountEntry(env, DNS_DRAINABLE_CACHE_KEY, DNS_DRAINABLE_SKIP_IF_YOUNGER_S)) {
      return { ran: false, reason: "fresh" };
    }
    if (await env.CACHE.get(DNS_DRAINABLE_CLAIM_KEY)) return { ran: false, reason: "claimed" };
    await env.CACHE.put(DNS_DRAINABLE_CLAIM_KEY, new Date(opts.nowMs).toISOString(), {
      expirationTtl: DNS_DRAINABLE_CLAIM_TTL_S,
    });
    const start = Date.now();
    const n = await opts.recount();
    await seedCount(env, DNS_DRAINABLE_CACHE_KEY, n, DNS_DRAINABLE_TTL_S);
    return { ran: true, drainable: n, durationMs: Date.now() - start };
  } catch (err) {
    return { ran: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DnsDrainableTick {
  /** Threats-side candidate count from KV, or null when none is cached. */
  drainable: number | null;
  /** |queueSize − drainable|, or null alongside drainable. */
  drift: number | null;
  /** When the cached count was computed (ISO), or null. */
  computedAt: string | null;
  /** True when computed within DNS_DRAINABLE_FRESH_S — the only state any
   *  count-based alert may act on. */
  fresh: boolean;
}

/** Flight Control's per-tick view of the count: a KV peek, never a scan. */
export async function readDnsDrainableForTick(opts: {
  env: { CACHE?: KVNamespace };
  queueSize: number;
  nowMs?: number;
}): Promise<DnsDrainableTick> {
  const nowMs = opts.nowMs ?? Date.now();
  const e = await peekCountEntry(opts.env, DNS_DRAINABLE_CACHE_KEY, DNS_DRAINABLE_TTL_S);
  if (!e) return { drainable: null, drift: null, computedAt: null, fresh: false };
  return {
    drainable: e.v,
    drift: Math.abs(opts.queueSize - e.v),
    computedAt: new Date(e.t).toISOString(),
    fresh: nowMs - e.t <= DNS_DRAINABLE_FRESH_S * 1000,
  };
}

/** `platform_dns_queue_drift` fires only on a fresh count. */
export function shouldEmitDnsQueueDrift(tick: DnsDrainableTick, threshold: number): boolean {
  return tick.fresh && tick.drift !== null && tick.drift > threshold;
}

/** Fields read from the latest Navigator `dns-queue-reconcile` diagnostic. */
export interface ReconcilerDiagnostic {
  skipped?: boolean;
  cursor_stuck?: boolean;
  cursor_lag_minutes?: number;
  scanned?: number;
  enqueued?: number;
}

export type DnsQueueStallKind = "cursor_stuck" | "falling_behind";

/**
 * `platform_dns_queue_stalled` decision (hourly, no threats scan). Returns
 * the stall kind, or null.
 *
 *   - `cursor_stuck`: the reconciler reported a full page that made no
 *     keyset progress.
 *   - `falling_behind`: the cursor lags by more than `stallThresholdMin`
 *     AND there is evidence of NEW work behind it — the reconciler's last
 *     page was full AND enqueued something (a full page of reposts of
 *     already-queued domains enqueues 0 and is not evidence), or the fresh
 *     daily count exceeds the queue by > driftThreshold. A quiet platform
 *     legitimately grows lag, so lag alone is not a stall.
 */
export function classifyDnsQueueStall(opts: {
  reconciler: ReconcilerDiagnostic;
  tick: DnsDrainableTick;
  queueSize: number;
  driftThreshold: number;
  stallThresholdMin: number;
}): DnsQueueStallKind | null {
  const r = opts.reconciler;
  if (r.skipped) return null;
  if (r.cursor_stuck === true) return "cursor_stuck";
  const lag = r.cursor_lag_minutes ?? 0;
  if (lag <= opts.stallThresholdMin) return null;
  const fullPageOfNewWork = (r.scanned ?? 0) >= RECONCILER_READ_LIMIT && (r.enqueued ?? 0) > 0;
  const freshBacklog = opts.tick.fresh
    && opts.tick.drainable !== null
    && opts.tick.drainable > opts.queueSize + opts.driftThreshold;
  return fullPageOfNewWork || freshBacklog ? "falling_behind" : null;
}
