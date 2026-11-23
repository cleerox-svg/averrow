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
// written. (The guard was first written as correlated subqueries evaluated
// twice; since 2026-11-23 the counts come from one grouped pass — see
// syncHostingProviderCounts.)
//
// Correctness note: a provider whose threats all flip inactive still
// appears in the grouped pass (active → 0, total → N), so it is updated
// correctly. A provider whose threat rows are all hard-deleted is absent
// from the pass and zeroed by the NOT EXISTS sweep, which writes only when
// a stored value is non-zero (or NULL). No row is silently left stale.

import type { Env } from "../types";

/**
 * Sync `active_threat_count` + `total_threat_count` on hosting_providers,
 * writing ONLY rows whose counts actually changed. Returns the number of
 * rows written (0 on a fully-stable run — the common case).
 *
 * Idempotent and safe to call from any dispatch path. Never throws on the
 * happy path; callers that need failure isolation should still wrap it.
 */
/**
 * The per-provider counts from ONE ordered pass over idx_threats_provider_created
 * (hosting_provider_id leading, so the GROUP BY needs no sort). Exported for
 * the parity test.
 */
export const PROVIDER_COUNTS_UPSERT_SQL = `
    UPDATE hosting_providers SET
      active_threat_count = c.active,
      total_threat_count = c.total
    FROM (
      SELECT hosting_provider_id AS pid,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
             COUNT(*) AS total
      FROM threats
      WHERE hosting_provider_id IS NOT NULL
      GROUP BY hosting_provider_id
    ) AS c
    WHERE c.pid = hosting_providers.id
      AND (hosting_providers.active_threat_count IS NOT c.active
        OR hosting_providers.total_threat_count IS NOT c.total)`;

/** Providers with no threats at all: zero both counters (a guarded write). */
export const PROVIDER_COUNTS_ZERO_SQL = `
    UPDATE hosting_providers SET
      active_threat_count = 0,
      total_threat_count = 0
    WHERE (active_threat_count IS NOT 0 OR total_threat_count IS NOT 0)
      AND NOT EXISTS (
        SELECT 1 FROM threats WHERE threats.hosting_provider_id = hosting_providers.id
      )`;

export async function syncHostingProviderCounts(env: Env): Promise<number> {
  // Read cost (2026-11-23): the previous form evaluated up to four correlated
  // COUNT subqueries per provider — the active ones on
  // idx_threats_provider_created with a row lookup each for `status`, then
  // the WHERE guard's two, then SET's two on changed rows — so every run
  // read the ~1.2M provider-linked threats 3-5 times (the bulk of the
  // orchestrator's hour % 4 === 0 tick: 5-8M rows read). Now: one grouped
  // pass computes both counts for every provider that has threats, and the
  // NOT EXISTS sweep zeroes the rest (one covering seek per provider). Same
  // values and the same change guard; both statements run in one batch
  // (one transaction), so a reader never sees half the providers updated.
  const db = env.DB;
  const results = await db.batch([
    db.prepare(PROVIDER_COUNTS_UPSERT_SQL),
    db.prepare(PROVIDER_COUNTS_ZERO_SQL),
  ]);
  return results.reduce((n, r) => n + (r?.meta?.changes ?? 0), 0);
}
