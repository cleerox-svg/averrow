/**
 * Work-queue predicates over `threats` that are served by the partial
 * indexes in migration 0322 (`0322_d1_rescan_partial_indexes.sql`).
 *
 * SQLite only uses a partial index when the query's WHERE contains every
 * term of the index's WHERE, so each predicate below is defined ONCE and
 * interpolated into every query that should seek its index. The migration
 * repeats the same text; test/d1-rescan-partial-indexes.test.ts asserts the
 * two agree and pins every plan. Change a predicate here only together with
 * a new migration that recreates its index.
 *
 * Every query also names its index with `INDEXED BY` (the planner has
 * preferred a broad index over a small partial one in prod before — see
 * flightControl.ts `backlog.cartographer.drainable`), and every call site
 * runs through `withIndexHintFallback`, so a missing index degrades to the
 * old (correct, expensive) plan instead of an error.
 */

/** Active threats with no coordinates. Index: idx_threats_active_no_geo. */
export const ACTIVE_NO_GEO_SQL = "(lat IS NULL OR lng IS NULL) AND status = 'active'";

/** Threats with an IP but no hosting provider. Index: idx_threats_ip_no_provider. */
export const IP_NO_PROVIDER_SQL = "hosting_provider_id IS NULL AND ip_address IS NOT NULL";

/** Domains SURBL has not checked yet. Index: idx_threats_surbl_pending (created_at). */
export const SURBL_PENDING_SQL = "surbl_checked = 0 AND malicious_domain IS NOT NULL";

/**
 * The SURBL work set: the feed's SELECT (feeds/surbl.ts) and Flight
 * Control's `backlog.surbl.pending` count share this WHERE, so the backlog
 * FC reports is exactly the set the feed drains.
 */
export const SURBL_WORK_WHERE_SQL = `${SURBL_PENDING_SQL}
        AND malicious_domain != ''
        AND created_at > datetime('now', '-7 days')`;

/**
 * Flight Control's geo-backlog gate is `> 5000` (scaleAgents). A bounded
 * probe capped one past that answers the gate exactly while reading at most
 * this many index entries; a value equal to the cap means "more than 5000".
 */
export const NO_GEO_GATE = 5000;
export const NO_GEO_PROBE_CAP = NO_GEO_GATE + 1;

/** Log text for a probe value: the exact count, or `>5000` at the cap. */
export function noGeoProbeLabel(value: number): string {
  return value >= NO_GEO_PROBE_CAP ? `>${NO_GEO_GATE}` : String(value);
}

export const TOTAL_NO_GEO_PROBE_SQL = `
      SELECT COUNT(*) as count FROM (
        SELECT 1 FROM threats INDEXED BY idx_threats_active_no_geo
        WHERE ${ACTIVE_NO_GEO_SQL}
        LIMIT ${NO_GEO_PROBE_CAP}
      )
    `;

export const SURBL_BACKLOG_COUNT_SQL = `
      SELECT COUNT(*) as count FROM threats INDEXED BY idx_threats_surbl_pending
      WHERE ${SURBL_WORK_WHERE_SQL}
    `;

export const SURBL_WORK_SELECT_SQL = `
      SELECT DISTINCT malicious_domain FROM threats INDEXED BY idx_threats_surbl_pending
      WHERE ${SURBL_WORK_WHERE_SQL}
      LIMIT 200
    `;

export const THREATS_WITHOUT_PROVIDER_COUNT_SQL =
  `SELECT COUNT(*) as n FROM threats INDEXED BY idx_threats_ip_no_provider WHERE ${IP_NO_PROVIDER_SQL}`;
