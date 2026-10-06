/**
 * Which look-alike domains count as live exposure for a brand (G25).
 *
 * `lookalike_domains.status` takes exactly four values — `monitoring`,
 * `confirmed_threat`, `benign`, `taken_down` (migration 0031; the staff
 * PATCH allowlist in `handlers/lookalikeDomains.ts`). It is never
 * `'active'`, so the old `status = 'active'` filter counted zero rows and
 * the exposure score's `domain_risk` input was always 0.
 *
 * A look-alike is exposure when it is REGISTERED (`registered = 1`; the
 * seeder stores every unregistered permutation too, which is the bulk of
 * the table) and still LIVE in the analyst lifecycle:
 *   - `monitoring`        — registered, not yet triaged
 *   - `confirmed_threat`  — an analyst confirmed it
 * and not:
 *   - `benign`            — official / trusted (alert triage or staff)
 *   - `taken_down`        — removed; `registered` can stay 1 after a
 *                           takedown, so the status is what retires it
 *
 * Index: `idx_lookalike_brand_exposure` (migration 0286) — a partial
 * `(brand_id, status) WHERE registered = 1` index. Without it the planner
 * picks the partial `idx_lookalike_registered` and walks every registered
 * row in the table per brand; with it the count is a covering seek.
 * `test/lookalike-exposure.test.ts` pins that plan.
 */

export const EXPOSURE_LOOKALIKE_STATUSES = ["monitoring", "confirmed_threat"] as const;

export const EXPOSURE_LOOKALIKE_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM lookalike_domains " +
  "WHERE brand_id = ? AND registered = 1 AND status IN ('monitoring', 'confirmed_threat')";

/** Minimal prepared-statement surface (D1Database or a read session). */
interface CountDb {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null> };
  };
}

/** Registered, live (monitoring / confirmed_threat) look-alikes for a brand. */
export async function countExposureLookalikes(db: CountDb, brandId: string): Promise<number> {
  const row = await db.prepare(EXPOSURE_LOOKALIKE_COUNT_SQL).bind(brandId).first<{ n: number }>();
  return row?.n ?? 0;
}
