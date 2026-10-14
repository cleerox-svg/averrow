/**
 * `infrastructure_clusters.status` values that mean "this row is NOT an
 * operation" — retained for audit/reversibility, but excluded from every
 * reader that lists, counts, attributes or groups operations.
 *
 *   superseded   — a legacy duplicate. Before 2026-09-11 the NEXUS workflow
 *                  ASN lane minted `crypto.randomUUID()` ids on every run,
 *                  leaving ~76K copies (ids not starting `cluster_`) with
 *                  frozen counts. Migration 0303 flips them here; the stable
 *                  `cluster_asn_<asn>_<type>` row is the live one. NEXUS also
 *                  supersedes `cluster_asn_*` rows keyed on a malformed ASN
 *                  string ("AS13335 Cloudflare, Inc.") now that the lane
 *                  normalises ASNs (lib/nexus-threat-lanes.ts).
 *   shared_infra — ASN / per-IP / subnet rows that are not operator
 *                  evidence: on shared infrastructure (lib/shared-infra-
 *                  asns.ts — either list for ASN and /24 rows, multi-tenant
 *                  only for per-IP rows), over the 150-brand hub fan-out, a
 *                  bogon / private IP or /24, or an ASN cluster of
 *                  IP-reputation sightings (scanning / malicious_ip). Never
 *                  stamped, never attributed. NEXUS re-activates the row if
 *                  it qualifies again (e.g. the shared list changes).
 *
 * Neither value is in LIVE_CLUSTER_STATUSES (= `OPERATION_STATUSES`,
 * handlers/operations.ts), so an explicit `?status=` filter can never select
 * them; the helpers below cover the unfiltered ("all") reads. There is no CHECK constraint on the column
 * (migrations/0136), so no schema change was needed to introduce them.
 *
 * Do NOT delete superseded rows or clear their actor_id: keeping them makes
 * the retirement reversible (flip status back) and preserves the audit
 * trail of the spurious attributions some of them carry.
 */

export const SUPERSEDED_CLUSTER_STATUS = "superseded";
export const SHARED_INFRA_CLUSTER_STATUS = "shared_infra";

export const RETIRED_CLUSTER_STATUSES: readonly string[] = [
  SUPERSEDED_CLUSTER_STATUS,
  SHARED_INFRA_CLUSTER_STATUS,
];

export function isRetiredClusterStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && RETIRED_CLUSTER_STATUSES.includes(status);
}

/**
 * Static SQL predicate "this cluster row is not retired", optionally
 * table-qualified (`notRetiredClusterSql('ic')` → `ic.status NOT IN (...)`).
 * The status list is a compile-time constant — no caller input reaches the
 * SQL text — so interpolating it is safe (same pattern as
 * MONITORED_BRAND_PREDICATE_SQL / VELOCITY_SOURCE_FILTER).
 */
export function notRetiredClusterSql(alias?: string, opts?: { unindexed?: boolean }): string {
  // `unindexed` prefixes the column with unary `+` so the planner cannot pick
  // a status index for this predicate — for reads whose plan is pinned to a
  // different access path (operations-geo's PK range, test/
  // observatory-lens-plans.test.ts).
  const col = `${opts?.unindexed ? "+" : ""}${alias ? `${alias}.status` : "status"}`;
  return `${col} NOT IN (${RETIRED_CLUSTER_STATUSES.map((s) => `'${s}'`).join(", ")})`;
}

/**
 * Every status an OPERATION can carry. Writers (audited 2026-10-14):
 * lib/nexus-threat-lanes.ts writes 'active' / 'dormant' (ASN-lane pivot)
 * plus the two retired values; agents/nexus.ts's correlation lanes write
 * 'active'; nothing else writes infrastructure_clusters.status (NOT NULL,
 * DEFAULT 'active', migration 0136). 'accelerating' / 'pivot' are accepted
 * by the Operations / Observatory status filters, so they stay live here. A
 * new status value MUST be added here or to RETIRED_CLUSTER_STATUSES.
 */
export const LIVE_CLUSTER_STATUSES: readonly string[] = ["active", "dormant", "accelerating", "pivot"];

/**
 * Positive-list twin of notRetiredClusterSql: `status IN ('active', …)`.
 * Use it for top-N reads ordered by threat_count: with `ORDER BY
 * +threat_count DESC` the planner seeks idx_clusters_status_threat_count
 * once per live status and sorts the few hundred live rows, instead of
 * walking idx_clusters_threat_count through ~76K superseded legacy rows
 * (which a NOT IN predicate cannot skip). Pinned by
 * test/cluster-list-plans.test.ts.
 */
export function liveClusterStatusSql(alias?: string): string {
  const col = alias ? `${alias}.status` : "status";
  return `${col} IN (${LIVE_CLUSTER_STATUSES.map((s) => `'${s}'`).join(", ")})`;
}
