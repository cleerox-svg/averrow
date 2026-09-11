/**
 * Geo-enrichment exhaustion — ONE definition, shared by every surface.
 *
 * Three surfaces report "cartographer gave up on this threat":
 *   handlers/admin/metrics.ts     → /api/admin/metrics/geo-coverage
 *                                    (drives the GeoCoverage admin panel)
 *   handlers/diagnostics.ts       → cartographer_exhausted (headline)
 *                                    + cartographer_exhausted_by_feed
 *   handlers/cartographer-health.ts → queue.{active,awaiting_mmdb,exhausted}
 *
 * They used to disagree on both the threshold and the population
 * (`>= 5` vs `>= 8`, with/without `status='active'`, with/without an
 * `ip_address` predicate), so the headline could never equal the sum of
 * its own breakdown. This module is the single source of truth; every
 * consumer interpolates these constants rather than re-typing the SQL.
 *
 * ─── Why terminality is NOT a threshold on enrichment_attempts ───
 *
 * `threats.enrichment_attempts` has never been a clean geo counter, and
 * as of 0ee677e it is not a geo counter at all past 5:
 *
 *   agents/cartographer.ts:460  Phase 0 (ip-api) increments it, bounded
 *                               by its own `< 5` selector at :300.
 *                               **5 is the maximum reachable value.**
 *   lib/dns-backfill.ts:399     writes the hard-coded sentinel `= 8` for
 *                               DNS-confirmed-dead domains — rows that by
 *                               construction have NO ip_address and that
 *                               the geo pipeline never touched.
 *   lib/dns-backfill.ts:436+    DNS-pipeline transient-failure increments
 *                               (dns_queue-side in prod; threats-side only
 *                               on the legacy no-DNS_QUEUE_DB path, and
 *                               only for rows with a NULL/empty ip_address).
 *
 * Phase 0.5 (GeoLite2 MMDB) used to select `enrichment_attempts < 8`,
 * which is where the old `>= 8` terminal threshold came from. Commit
 * 0ee677e deleted that selector: Phase 0.5 now keys on
 * `geo_mmdb_checked_at IS NULL` (migration 0263) and never writes
 * `enrichment_attempts`. So nothing in the geo pipeline can move a row
 * to 6, 7 or 8 anymore — a `>= 8` predicate is frozen at the historical
 * pile forever, and reads as "no threats exhausted, cartographer is
 * keeping up" even during a total ip-api outage.
 *
 * Terminality is therefore the conjunction of both phases giving up:
 *
 *   enrichment_attempts >= 5      Phase 0 (ip-api) is out of budget
 *   geo_mmdb_checked_at IS NOT NULL   Phase 0.5 (MMDB) has been consulted
 *                                     — once is all that is informative:
 *                                     geo_ip_ranges refreshes weekly and
 *                                     lib/geoip-mmdb.ts KV-caches the
 *                                     negative answer.
 *
 * Caveat, deliberately not encoded here: Phase 1 (ipinfo,
 * lib/geoip.ts:enrichThreatsGeo) selects on a bare `lat IS NULL` with no
 * attempts/marker gate, so in the strictest sense an exhausted row is
 * still *selectable*. It is not a retry path in any practical sense —
 * Phase 1 is capped at 5-50 rows per cycle and orders `created_at DESC`,
 * so an aged exhausted row is never reached. Gating terminality on it
 * would make the metric permanently zero, which is the exact bug this
 * module exists to fix.
 */

import { PRIVATE_IP_SQL_FILTER } from "./geoip";

/**
 * The population all three surfaces measure: active threats that still
 * have no usable geo, that the geo pipeline can actually act on.
 *
 * `ip_address IS NOT NULL AND ip_address != ''` is load-bearing, not
 * cosmetic. Without it the count sweeps in the DNS-dead pile
 * (`dns-backfill.ts:399`'s `enrichment_attempts = 8` sentinel), which is
 * written only for rows with NO ip_address. A resolver outage that
 * graduates 10K domains as dead would otherwise spike the "geo
 * exhausted" panel and get blamed on whichever feed supplied them,
 * while geo enrichment is perfectly healthy.
 *
 * A separate `dns_exhausted_at IS NULL` clause is intentionally NOT
 * added: the ip_address predicate already excludes that population by
 * construction, and a row that was DNS-exhausted historically but later
 * acquired an IP is a legitimate geo candidate.
 *
 * Emits leading `AND`-free SQL — callers prefix their own `WHERE`.
 */
export const GEO_UNMAPPED_POPULATION_SQL = `
  status = 'active'
  AND enriched_at IS NULL
  AND ip_address IS NOT NULL AND ip_address != ''
  ${PRIVATE_IP_SQL_FILTER}
`;

/** Terminal: Phase 0 is out of ip-api budget AND Phase 0.5 has been
 *  consulted. No cartographer phase will meaningfully retry this row. */
export const GEO_TERMINAL_SQL =
  `(enrichment_attempts >= 5 AND geo_mmdb_checked_at IS NOT NULL)`;

/** In flight: Phase 0 has given up but Phase 0.5 hasn't looked yet.
 *  Replaces the old `retrying_mmdb` (5..7) band, which nothing could
 *  populate once Phase 0.5 stopped touching `enrichment_attempts` —
 *  every row is now pinned at exactly 5 on the way through. A large and
 *  persistently growing value here means the MMDB phase is starved
 *  (GEOIP_DB unbound, budget hit every run, or cartographer not firing),
 *  NOT that geo coverage is terminal. */
export const GEO_AWAITING_MMDB_SQL =
  `(enrichment_attempts >= 5 AND geo_mmdb_checked_at IS NULL)`;

/** Phase 0 (ip-api) still eligible — mirrors the `< 5` selector at
 *  agents/cartographer.ts:300 and the `idx_threats_carto_phase0`
 *  partial index. */
export const GEO_PHASE0_ELIGIBLE_SQL = `(enrichment_attempts < 5)`;
