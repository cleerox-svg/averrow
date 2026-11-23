/**
 * velocity-diag.ts — the platform-diagnostics `velocity` block, computed
 * OFF the request path (2026-11-23).
 *
 * The block is a (weaponization_flag, has_reg) GROUP BY over EVERY threats
 * row. As one statement it read ~3.3M rows (sampled top queries) and, run
 * inside a diagnostics request, spent D1's 10-second overload window by
 * itself: the sections read right after it failed "D1 DB is overloaded",
 * their caches never filled, and the next call repeated the cascade.
 *
 * Now:
 *   - Navigator runs `runVelocityDiagRecount` as a waitUntil tail on UTC
 *     hours VELOCITY_DIAG_HOURS_UTC (hour-only gate, cron-audit rule): a KV
 *     claim so overlapping 5-min ticks don't both walk, skipped while the
 *     stored entry is younger than VELOCITY_DIAG_SKIP_IF_YOUNGER_S or the
 *     D1 read budget is over its soft-cap. It walks threats in
 *     VELOCITY_DIAG_CHUNK_ROWS rowid ranges (`rowid > ? AND rowid <= ?`, a
 *     PK range seek) with a pause between chunks — the daily briefing's
 *     enrichment-SUM pattern — and merges the per-chunk groups, so the
 *     result is exactly the single statement's (each row is in one chunk).
 *   - diagnostics only READS the stored entry (`readVelocityDiag`).
 *
 * Lag: the block is at most ~12h old (26h — VELOCITY_DIAG_TTL_S — if a
 * recompute was skipped). It is metadata only; it never gates triage.
 */

import type { Env } from "../types";
import { peekValue, seedValue } from "./cached-value";
import { sleep } from "./run-sequential";
import { store } from "./db-registry";

/** KV key (cachedValue envelope) of the stored block. Same key as the old
 *  in-request cachedValue: the shape is unchanged. */
export const VELOCITY_DIAG_CACHE_KEY = "diag.weaponization.distribution.v3";
/** How long a stored block stays servable (26h: one skipped recompute). */
export const VELOCITY_DIAG_TTL_S = 93_600;
/** UTC hours Navigator recomputes on (hour-only gate). */
export const VELOCITY_DIAG_HOURS_UTC: readonly number[] = [5, 17];
/** A stored block younger than this is not recomputed (claims per day = 2). */
export const VELOCITY_DIAG_SKIP_IF_YOUNGER_S = 6 * 3600;
export const VELOCITY_DIAG_CLAIM_KEY = "velocity_diag:recount_claim";
export const VELOCITY_DIAG_CLAIM_TTL_S = 1_200;
/** Rowid span per chunk (~threats rows per statement). */
export const VELOCITY_DIAG_CHUNK_ROWS = 200_000;
/** Pause between chunks, ms. */
export const VELOCITY_DIAG_CHUNK_PAUSE_MS = 500;
/** `velocity_error` when no stored block exists yet. */
export const VELOCITY_DIAG_PENDING_ERROR =
  "velocity: not computed yet (Navigator recomputes it at 05:00 and 17:00 UTC)";

/** One chunk of the grouped distribution. Binds: lo (exclusive), hi (inclusive). */
export const VELOCITY_CHUNK_SQL = `
      SELECT weaponization_flag AS flag,
             CASE WHEN domain_created_at IS NULL THEN 0 ELSE 1 END AS has_reg,
             COUNT(*) AS n
      FROM threats
      WHERE rowid > ? AND rowid <= ?
      GROUP BY weaponization_flag, has_reg`;

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

// ── Weaponization velocity distribution (Wave 3, rec 5) ─────────────
// Distribution over the STORED threats.weaponization_flag column
// (migration 0259) — the whole-hours registration→first-live band,
// bucketed very_fast (≤24h) | fast (≤72h) | normal (>72h) | NULL. NULL
// is compute-time not-computable (missing/unparseable WHOIS created
// date, negative delta, pre-1985 sentinel), kept DISTINCT from `normal`.
// This reads the pre-computed column only — never a live per-row
// julianday(first_seen - domain_created_at) scan. Migration 0259
// explicitly sanctions this cached diagnostics GROUP BY (at most once
// per TTL) as the reason no index is warranted on the low-cardinality
// column.
export interface VelocityDiag {
  /** Counts per flag band, ordered very_fast → fast → normal → not_computable. */
  by_flag: Array<{ flag: string; n: number }>;
  /** Sum across all bands (= total threats rows). */
  total: number;
  /**
   * Writer-coverage split (VELOCITY_DARK_2026-09). `by_flag`'s
   * `not_computable` bucket is NULL-derived and therefore CONFLATES two
   * states that need different responses:
   *
   *   * "inherently not computable" — the row carries no WHOIS
   *     registration date at all (`domain_created_at IS NULL`), so
   *     `decideWeaponizationVelocity` could never produce a band. Nothing
   *     to run; this is the permanent floor.
   *   * "never computed" — the row DOES carry a registration date but
   *     `runVelocityBackfill` has not swept it yet (`lib/velocity-writer.ts`
   *     is admin-endpoint-dispatched; there is no cron, so a fresh
   *     deployment sits at 100% unstamped and looks identical to the case
   *     above in `by_flag`).
   *
   * That conflation is exactly what let the feature ship 100% dark and go
   * unnoticed. `unstamped_candidates` is the actionable number: while it is
   * large, `POST /api/admin/velocity/backfill?dry_run=0` has real work to do.
   * It never reaches 0 — rows whose registration date fails a decide-fn
   * guard (negative delta, pre-1985 sentinel, unparseable) are deliberately
   * left NULL — so after a completed sweep the residual IS the guard-rejected
   * set, not a backlog.
   *
   * Free: derived from the SAME single GROUP BY scan as `by_flag` (one extra
   * low-cardinality grouping key, ≤8 groups), not additional COUNT(*) passes.
   */
  coverage: {
    /** Rows in the writer's candidate set (`domain_created_at IS NOT NULL`).
     *  Mirrors `computeVelocityDryRun`'s `candidates_total` predicate exactly. */
    candidates_total: number;
    /** Rows carrying a non-NULL `weaponization_flag` AND in the candidate
     *  set. Gating on `has_reg` is required: counting flagged non-candidates
     *  here lets `stamped_pct_of_candidates` exceed 100 and clamps
     *  `unstamped_candidates` to 0, reporting a completed sweep over a real
     *  backlog. Those rows go to `stamped_orphans` instead. */
    stamped: number;
    /** candidates_total − stamped: never-computed backlog + guard-rejected residual. */
    unstamped_candidates: number;
    /** Rows with a non-NULL `weaponization_flag` but NULL `domain_created_at`
     *  — flagged yet outside the candidate set. Counted in neither `stamped`
     *  nor `candidates_total`. Expected 0; non-zero means the writer's
     *  CANDIDATE_SELECT and this block's predicate have diverged. */
    stamped_orphans: number;
    /** total − candidates_total: no registration date, inherently not computable. */
    no_registration_date: number;
    /** candidates_total as a % of total — the feature's ceiling on this corpus. */
    candidate_pct: number;
    /** stamped as a % of candidates_total — sweep progress. 0 = never run. */
    stamped_pct_of_candidates: number;
  };
}

/** Pure fold of the `(weaponization_flag, has_reg)` group rows into the
 *  `velocity` diagnostics block. Shared by the chunked recompute below, so
 *  the coverage arithmetic is unit-testable without a D1 —
 *  test/geo-exhaustion-and-diag-folds.test.ts. */
export function foldVelocityDistribution(
  rows: Array<{ flag: string | null; has_reg: number; n: number }>,
): VelocityDiag {
  const flagTotals = new Map<string, number>();
  let total = 0;
  let candidatesTotal = 0;
  let stamped = 0;
  let stampedOrphans = 0;
  for (const r of rows) {
    const label = r.flag ?? 'not_computable';
    flagTotals.set(label, (flagTotals.get(label) ?? 0) + r.n);
    total += r.n;
    if (r.has_reg === 1) {
      candidatesTotal += r.n;
      // `stamped` MUST be gated on has_reg too, or it counts rows that
      // never entered `candidatesTotal`. Ungated, a row with a flag but
      // no domain_created_at subtracted from `unstamped_candidates`
      // without adding to the denominator: enough of them and
      // `stamped_pct_of_candidates` exceeds 100 while
      // `unstamped_candidates` clamps to 0 — the block reports "sweep
      // complete" over a real backlog, defeating its own purpose.
      if (r.flag !== null) stamped += r.n;
    } else if (r.flag !== null) {
      // Flagged but not a candidate. Surfaced as its own field rather
      // than silently dropped: a non-zero value means the writer's
      // CANDIDATE_SELECT and this block's predicate have diverged, or
      // domain_created_at was cleared after stamping.
      stampedOrphans += r.n;
    }
  }

  const order = ['very_fast', 'fast', 'normal', 'not_computable'];
  const byFlag = [...flagTotals.entries()]
    .map(([flag, n]) => ({ flag, n }))
    .sort((a, b) => order.indexOf(a.flag) - order.indexOf(b.flag));

  return {
    by_flag: byFlag,
    total,
    coverage: {
      candidates_total: candidatesTotal,
      // Candidates only — see the has_reg gate above.
      stamped,
      unstamped_candidates: Math.max(0, candidatesTotal - stamped),
      // Flagged rows with no domain_created_at. Not in `stamped`, not
      // in `candidates_total`. Expected 0; non-zero = writer/reader
      // predicate divergence.
      stamped_orphans: stampedOrphans,
      no_registration_date: Math.max(0, total - candidatesTotal),
      candidate_pct: pct(candidatesTotal, total),
      stamped_pct_of_candidates: pct(stamped, candidatesTotal),
    },
  };
}


type VelocityGroupRow = { flag: string | null; has_reg: number; n: number };

/** Merge per-chunk group rows into one row per (flag, has_reg). Pure. */
export function mergeVelocityGroups(rows: readonly VelocityGroupRow[]): VelocityGroupRow[] {
  const acc = new Map<string, VelocityGroupRow>();
  for (const r of rows) {
    const k = `${r.flag === null ? "\u0000" : r.flag}|${r.has_reg}`;
    const cur = acc.get(k);
    if (cur) cur.n += Number(r.n) || 0;
    else acc.set(k, { flag: r.flag, has_reg: r.has_reg, n: Number(r.n) || 0 });
  }
  return [...acc.values()];
}

/**
 * Walk threats in rowid chunks and return the merged group rows — exactly
 * what the single GROUP BY returned. Throws on a D1 error (the caller
 * stores nothing, so a partial walk is never served).
 */
export async function computeVelocityGroupsChunked(
  db: Pick<D1Database, "prepare">,
  opts: { chunkRows?: number; pauseMs?: number } = {},
): Promise<VelocityGroupRow[]> {
  const step = Math.max(1, opts.chunkRows ?? VELOCITY_DIAG_CHUNK_ROWS);
  const pauseMs = opts.pauseMs ?? VELOCITY_DIAG_CHUNK_PAUSE_MS;
  const top = await db.prepare("SELECT MAX(rowid) AS hi FROM threats").first<{ hi: number | null }>();
  const hi = Number(top?.hi) || 0;
  const all: VelocityGroupRow[] = [];
  for (let lo = 0; lo < hi; lo += step) {
    if (lo > 0 && pauseMs > 0) await sleep(pauseMs);
    const r = await db.prepare(VELOCITY_CHUNK_SQL).bind(lo, lo + step).all<VelocityGroupRow>();
    all.push(...(r.results ?? []));
  }
  return mergeVelocityGroups(all);
}

/** True on a UTC hour Navigator may recompute the block. */
export function isVelocityDiagHour(nowMs: number): boolean {
  return VELOCITY_DIAG_HOURS_UTC.includes(new Date(nowMs).getUTCHours());
}

export type VelocityDiagRecountResult =
  | { ran: true; total: number; durationMs: number }
  | { ran: false; reason: "not_recount_hour" | "over_budget" | "fresh" | "claimed" | "error"; error?: string };

/**
 * Navigator's twice-daily recompute (waitUntil tail). Hour-only gate, then:
 * skip over the D1 soft-cap, skip when the stored block is fresh, skip when
 * another tick holds the claim; otherwise claim, walk, store. Never throws.
 */
export async function runVelocityDiagRecount(opts: {
  env: Env;
  nowMs: number;
  overBudget?: boolean;
  chunkRows?: number;
  pauseMs?: number;
}): Promise<VelocityDiagRecountResult> {
  if (!isVelocityDiagHour(opts.nowMs)) return { ran: false, reason: "not_recount_hour" };
  if (opts.overBudget) return { ran: false, reason: "over_budget" };
  const { env } = opts;
  if (!env.CACHE) return { ran: false, reason: "error", error: "CACHE binding unset" };
  try {
    if (await peekValue<VelocityDiag>(env, VELOCITY_DIAG_CACHE_KEY, VELOCITY_DIAG_SKIP_IF_YOUNGER_S)) {
      return { ran: false, reason: "fresh" };
    }
    if (await env.CACHE.get(VELOCITY_DIAG_CLAIM_KEY)) return { ran: false, reason: "claimed" };
    await env.CACHE.put(VELOCITY_DIAG_CLAIM_KEY, new Date(opts.nowMs).toISOString(), {
      expirationTtl: VELOCITY_DIAG_CLAIM_TTL_S,
    });
    const start = Date.now();
    const rows = await computeVelocityGroupsChunked(store(env, "core"), { chunkRows: opts.chunkRows, pauseMs: opts.pauseMs });
    const block = foldVelocityDistribution(rows);
    await seedValue(env, VELOCITY_DIAG_CACHE_KEY, block, VELOCITY_DIAG_TTL_S);
    return { ran: true, total: block.total, durationMs: Date.now() - start };
  } catch (err) {
    return { ran: false, reason: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** The stored block and when it was computed, or null. KV only. */
export async function readVelocityDiag(
  env: { CACHE?: KVNamespace },
): Promise<{ value: VelocityDiag; computedAt: number } | null> {
  const e = await peekValue<VelocityDiag>(env, VELOCITY_DIAG_CACHE_KEY, VELOCITY_DIAG_TTL_S);
  return e ? { value: e.v, computedAt: e.t } : null;
}
