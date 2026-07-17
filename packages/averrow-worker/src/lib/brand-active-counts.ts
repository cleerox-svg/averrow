// Averrow — brands.active_threat_count sync (change-guarded)
//
// `brands.active_threat_count` is the pre-computed active-only counter the
// tenant dashboard (handlers/tenantData.ts) and the email-security stats
// worst-brands list (handlers/emailSecurity.ts) read instead of scanning
// the threats table per request (see CLAUDE.md §8 "Pre-computed columns").
//
// This is the exact same change-guarded whole-table pattern as
// syncHostingProviderCounts in provider-counts.ts: recompute the count for
// every brand from the threats table, but only WRITE the rows whose count
// actually moved. D1 bills `meta.changes`, so an UPDATE that sets a column
// to the value it already held still counts as a written row — the WHERE
// guard keeps a fully-stable run at ~0 writes.
//
// Why a whole-table sync instead of incremental +1/-1 bumps at each writer:
// the sibling `brands.threat_count` is maintained by ~8 incremental writers
// and drifted permanently because several brand-link paths skip the counter
// (see lib/brand-count-reconciler.ts header — 45% of linked brands were
// wrong). active_threat_count is harder still because it also has to react
// to active→resolved/remediated status transitions, which the insert-time
// bumpers never see. A change-guarded recompute reads absolute truth from
// threats regardless of which writer moved a row, so it can't drift between
// reconciler runs the way an incremental counter does.
//
// Correctness: the subqueries are index-driven via idx_threats_brand_status.
// A brand whose threats all flip inactive gets written back to 0 (guard
// fires because stored value was non-zero). The correlated subquery is
// evaluated twice (SET + WHERE compare), trading cheap reads for eliminated
// writes — the same call provider-counts.ts documents and accepts.

import type { Env } from "../types";

/**
 * Sync `active_threat_count` on brands, writing ONLY rows whose count
 * actually changed. Returns the number of rows written (0 on a fully-stable
 * run — the common case). Idempotent and safe to call from any dispatch
 * path; never throws on the happy path.
 */
export async function syncBrandActiveThreatCounts(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE brands SET
       active_threat_count = (
         SELECT COUNT(*) FROM threats
         WHERE threats.target_brand_id = brands.id
           AND threats.status = 'active'
       )
     WHERE
       active_threat_count IS NOT (
         SELECT COUNT(*) FROM threats
         WHERE threats.target_brand_id = brands.id
           AND threats.status = 'active'
       )`,
  ).run();
  return res.meta.changes ?? 0;
}
