// Averrow — hosting_providers count-sync (change-guarded, single source of truth)
//
// `hosting_providers.active_threat_count` / `total_threat_count` are the
// pre-computed columns the providers list, "worst/improving providers",
// and the dashboard read instead of re-deriving counts from the threats
// table (see CLAUDE.md §8 "Pre-computed columns").
//
// Why this helper exists: the identical correlated-subquery UPDATE was
// copy-pasted in three call sites (enrichment Stage 5, admin backfill-geo,
// daily snapshots), each rewriting EVERY provider row on every run with no
// change-detection. D1 bills `meta.changes`, so an UPDATE that sets a
// column to the value it already held still counts as a written row. At
// ~20K providers × 6 enrichment runs/day that was ~3.6M writes/month of
// pure no-op churn — the single largest contributor to the write-quota
// overage flagged by `platform_d1_writes_phase2_review`.
//
// The fix is the same WHERE-guard the threat cubes already use
// (`... IS NOT excluded.x`): only rows whose count actually changed are
// written. The correlated subqueries are evaluated twice (once to compute
// the new value, once in the WHERE to compare), which adds read volume —
// but reads sit at ~45% of budget with ample headroom, while writes are
// the binding constraint. Trading cheap reads for eliminated writes is the
// correct call here.
//
// Correctness note: a provider whose threats all flip inactive still
// appears in the subqueries (active subquery → 0, total subquery → N), so
// it is updated correctly. A provider whose threat rows are hard-deleted
// (subqueries → 0) is also handled: the guard writes 0 only if the stored
// value was non-zero. No row is silently left stale.

import type { Env } from "../types";

/**
 * Sync `active_threat_count` + `total_threat_count` on hosting_providers,
 * writing ONLY rows whose counts actually changed. Returns the number of
 * rows written (0 on a fully-stable run — the common case).
 *
 * Idempotent and safe to call from any dispatch path. Never throws on the
 * happy path; callers that need failure isolation should still wrap it.
 */
export async function syncHostingProviderCounts(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE hosting_providers SET
       active_threat_count = (
         SELECT COUNT(*) FROM threats
         WHERE threats.hosting_provider_id = hosting_providers.id
           AND threats.status = 'active'
       ),
       total_threat_count = (
         SELECT COUNT(*) FROM threats
         WHERE threats.hosting_provider_id = hosting_providers.id
       )
     WHERE
       active_threat_count IS NOT (
         SELECT COUNT(*) FROM threats
         WHERE threats.hosting_provider_id = hosting_providers.id
           AND threats.status = 'active'
       )
       OR total_threat_count IS NOT (
         SELECT COUNT(*) FROM threats
         WHERE threats.hosting_provider_id = hosting_providers.id
       )`,
  ).run();
  return res.meta.changes ?? 0;
}
