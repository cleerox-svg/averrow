/**
 * Cluster retirement — `infrastructure_clusters.retired_reason` (migration
 * 0303). NULL = a live operation. Non-NULL = "this row is NOT an operation":
 * retained for audit/reversibility, but excluded from every reader that
 * lists, counts, attributes or groups operations.
 *
 *   superseded   — a legacy duplicate. Before 2026-09-11 the NEXUS workflow
 *                  ASN lane minted `crypto.randomUUID()` ids on every run,
 *                  leaving ~76K copies (ids not starting `cluster_`) with
 *                  frozen counts. Migration 0303 marks them; the stable
 *                  `cluster_asn_<asn>_<type>` row is the live one. NEXUS also
 *                  supersedes `cluster_asn_*` rows keyed on a malformed ASN
 *                  string ("AS13335 Cloudflare, Inc.") now that the lane
 *                  normalises ASNs (lib/nexus-threat-lanes.ts). Nothing ever
 *                  clears it.
 *   shared_infra — ASN / per-IP / subnet rows that are not operator
 *                  evidence: on shared infrastructure (lib/shared-infra-
 *                  asns.ts — either list for ASN and /24 rows, multi-tenant
 *                  only for per-IP rows), over the 150-brand hub fan-out, a
 *                  bogon / private IP or /24, or an ASN cluster of
 *                  IP-reputation sightings (scanning / malicious_ip). Never
 *                  stamped, never attributed. NEXUS clears it if the row
 *                  qualifies again (e.g. the shared list changes).
 *
 * Retirement NEVER touches `status`. Prod's table carries
 *   CHECK (status IN ('active','dormant','disrupted'))
 * (created outside the repo's migrations; reproduced in 0136 for fresh DBs
 * and tests), so a retired row keeps whatever status it had. Every reader
 * must therefore add the retired_reason predicate itself — a bare
 * `status = 'active'` filter INCLUDES the ~70K retired legacy rows. Do not
 * add a status value (the CHECK rejects it, which is how the first 0303
 * failed the deploy); add a retired_reason value instead.
 *
 * Do NOT delete superseded rows or clear their actor_id: keeping them makes
 * the retirement reversible (SET retired_reason = NULL) and preserves the
 * audit trail of the spurious attributions some of them carry.
 */

export const SUPERSEDED_RETIRED_REASON = "superseded";
export const SHARED_INFRA_RETIRED_REASON = "shared_infra";

export type ClusterRetiredReason = typeof SUPERSEDED_RETIRED_REASON | typeof SHARED_INFRA_RETIRED_REASON;

export const CLUSTER_RETIRED_REASONS: readonly ClusterRetiredReason[] = [
  SUPERSEDED_RETIRED_REASON,
  SHARED_INFRA_RETIRED_REASON,
];

/** A row is retired iff retired_reason is set (any non-NULL value). */
export function isRetiredCluster(retiredReason: string | null | undefined): boolean {
  return retiredReason !== null && retiredReason !== undefined;
}

/**
 * Static SQL predicate "this cluster row is not retired", optionally
 * table-qualified (`notRetiredClusterSql('ic')` → `ic.retired_reason IS
 * NULL`). Constant text — no caller input reaches the SQL — so
 * interpolating it is safe (same pattern as MONITORED_BRAND_PREDICATE_SQL /
 * VELOCITY_SOURCE_FILTER).
 *
 * The bare form is also the WHERE of the partial index
 * idx_clusters_live_status_threat_count (migration 0306), so it lets the
 * planner use that index; SQLite matches partial-index terms textually, so
 * keep the exact `retired_reason IS NULL` shape.
 */
export function notRetiredClusterSql(alias?: string, opts?: { unindexed?: boolean }): string {
  // `unindexed` prefixes the column with unary `+` so the planner cannot
  // treat this term as indexable (nor satisfy a partial index with it) —
  // for reads whose plan is pinned to a different access path
  // (operations-geo's PK range, test/observatory-lens-plans.test.ts).
  const col = `${opts?.unindexed ? "+" : ""}${alias ? `${alias}.retired_reason` : "retired_reason"}`;
  return `${col} IS NULL`;
}

/** Negation of notRetiredClusterSql: the row IS retired. */
export function retiredClusterSql(alias?: string): string {
  return `${alias ? `${alias}.retired_reason` : "retired_reason"} IS NOT NULL`;
}

/**
 * Every status an OPERATION can carry. Writers (audited 2026-10-14):
 * lib/nexus-threat-lanes.ts writes 'active' / 'dormant' (ASN-lane pivot);
 * agents/nexus.ts's correlation lanes write 'active'; nothing else writes
 * infrastructure_clusters.status. 'accelerating' / 'pivot' are accepted by
 * the Operations / Observatory status filters but the prod CHECK means they
 * can never be stored; they stay listed so those filters keep validating.
 */
export const LIVE_CLUSTER_STATUSES: readonly string[] = ["active", "dormant", "accelerating", "pivot"];

/**
 * Positive-list twin of notRetiredClusterSql:
 * `status IN ('active', …) AND retired_reason IS NULL`. Use it for top-N
 * reads ordered by threat_count: with `ORDER BY +threat_count DESC` the
 * planner seeks the partial index idx_clusters_live_status_threat_count
 * (migration 0306, live rows only) once per status and sorts the few
 * hundred live rows, instead of walking ~76K retired legacy rows. Pinned by
 * test/cluster-list-plans.test.ts.
 */
export function liveClusterStatusSql(alias?: string): string {
  const col = alias ? `${alias}.status` : "status";
  return `${col} IN (${LIVE_CLUSTER_STATUSES.map((s) => `'${s}'`).join(", ")}) AND ${notRetiredClusterSql(alias)}`;
}
