// Averrow — shared email-security posture rollup over `brands`.
//
// D1 read-spend (2026-11): three surfaces computed the same catalog-wide
// email-posture aggregates, each with its own full scans of `brands`
// (~132K rows in prod, not the ~9.6K older comments assumed):
//
//   - GET /api/email-security/stats   (handlers/emailSecurity.ts) — grade
//     distribution, DMARC distribution, scanned/unscanned COUNTs, AVG score:
//     five scans per cache miss, ~99M reads/day at 108–124 misses/day.
//   - GET /api/brands/aggregate/email-security (lib/brand-aggregates.ts) —
//     grade distribution, graded/ungraded totals, DMARC distribution.
//   - Observer's daily briefing (agents/observer.ts) — grade distribution.
//
// All of them derive from ONE small GROUP BY: (grade, dmarc policy,
// scored?) with a row count and a score sum. That is at most a few dozen
// rows, so every distribution, total and the average fall out in memory.
// One full scan per TTL window replaces ~8 scans spread over three caches.
//
// Population rules (unchanged from the per-surface queries):
//   - "scored" = `email_security_score IS NOT NULL` (every scan writer sets
//     score + grade + dmarc_policy + scanned_at in one UPDATE).
//   - grade distributions count every row with a non-NULL grade.
//   - DMARC distributions count scored rows only.

import type { Env } from '../types';
import { cachedValue } from './cached-value';

export const EMAIL_POSTURE_ROLLUP_KEY = 'email_posture.rollup';
/** 1h. Inputs move on the weekly email-security rescan cadence. */
export const EMAIL_POSTURE_ROLLUP_TTL_S = 3600;

export interface EmailPostureRollupRow {
  grade: string | null;
  dmarc_policy: string | null;
  /** 1 when `email_security_score IS NOT NULL`, else 0. */
  scored: number;
  n: number;
  /** TOTAL(email_security_score) over the group (0 for unscored groups). */
  score_sum: number;
}

export const EMAIL_POSTURE_ROLLUP_SQL = `
  SELECT email_security_grade AS grade,
         email_security_dmarc_policy AS dmarc_policy,
         CASE WHEN email_security_score IS NULL THEN 0 ELSE 1 END AS scored,
         COUNT(*) AS n,
         TOTAL(email_security_score) AS score_sum
  FROM brands
  GROUP BY email_security_grade, email_security_dmarc_policy, scored
`;

/** One full scan of `brands`, shared by every email-posture surface. */
export async function emailPostureRollup(env: Env): Promise<EmailPostureRollupRow[]> {
  return cachedValue<EmailPostureRollupRow[]>(
    env, EMAIL_POSTURE_ROLLUP_KEY, EMAIL_POSTURE_ROLLUP_TTL_S,
    async () => {
      const r = await env.DB.prepare(EMAIL_POSTURE_ROLLUP_SQL).all<EmailPostureRollupRow>();
      return r.results;
    },
  );
}

// ─── Pure derivations ─────────────────────────────────────────────

/** Grade → count over rows with a non-NULL grade, unordered. */
function gradeCounts(rows: EmailPostureRollupRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.grade === null) continue;
    m.set(r.grade, (m.get(r.grade) ?? 0) + r.n);
  }
  return m;
}

/**
 * Grade distribution sorted by `rank(grade)` ascending, ties by grade
 * string so the output is deterministic.
 */
export function gradeDistribution(
  rows: EmailPostureRollupRow[],
  rank: (grade: string) => number,
): Array<{ grade: string; count: number }> {
  return [...gradeCounts(rows)]
    .map(([grade, count]) => ({ grade, count }))
    .sort((a, b) => rank(a.grade) - rank(b.grade) || (a.grade < b.grade ? -1 : a.grade > b.grade ? 1 : 0));
}

/** Grade distribution ordered by count DESC (ties by grade string). */
export function gradeDistributionByCount(rows: EmailPostureRollupRow[]): Array<{ grade: string; count: number }> {
  return gradeDistribution(rows, () => 0)
    .sort((a, b) => b.count - a.count);
}

/**
 * DMARC policy → count over SCORED rows. NULL policy stays its own bucket
 * (key `null`). Ordered NULL first, then policy ascending — SQLite's
 * GROUP BY output order for the old per-surface query.
 */
export function dmarcDistribution(rows: EmailPostureRollupRow[]): Array<{ dmarc_policy: string | null; count: number }> {
  const m = new Map<string | null, number>();
  for (const r of rows) {
    if (r.scored !== 1) continue;
    m.set(r.dmarc_policy, (m.get(r.dmarc_policy) ?? 0) + r.n);
  }
  return [...m]
    .map(([dmarc_policy, count]) => ({ dmarc_policy, count }))
    .sort((a, b) => {
      if (a.dmarc_policy === b.dmarc_policy) return 0;
      if (a.dmarc_policy === null) return -1;
      if (b.dmarc_policy === null) return 1;
      return a.dmarc_policy < b.dmarc_policy ? -1 : 1;
    });
}

export interface EmailPostureTotals {
  scored: number;
  unscored: number;
  graded: number;
  ungraded: number;
  /** AVG(email_security_score) over scored rows; null when none are scored. */
  average_score: number | null;
}

export function emailPostureTotals(rows: EmailPostureRollupRow[]): EmailPostureTotals {
  let scored = 0, unscored = 0, graded = 0, ungraded = 0, scoreSum = 0;
  for (const r of rows) {
    if (r.scored === 1) { scored += r.n; scoreSum += r.score_sum; } else { unscored += r.n; }
    if (r.grade === null) ungraded += r.n; else graded += r.n;
  }
  return { scored, unscored, graded, ungraded, average_score: scored > 0 ? scoreSum / scored : null };
}
