// Averrow — Cartographer Health Handler
//
// Focused diagnostic for the Phase 0 enrichment pipeline. Designed for
// programmatic consumption (Claude Code, ops scripts) when platform-diagnostics
// is too coarse and a wrangler shell is too heavy. All queries are read-only.

import { json } from "../lib/cors";
import { PRIVATE_IP_SQL_FILTER } from "../lib/geoip";
import type { Env } from "../types";

/** GET /api/admin/cartographer-health    (JWT super-admin auth)
 *  GET /api/internal/cartographer-health  (AVERROW_INTERNAL_SECRET auth) */
export async function handleCartographerHealth(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    // ─── Migration sanity ─────────────────────────────────────────
    // If migration 0110 hasn't applied, every other query that references
    // enrichment_attempts will throw. Surface the gap as the first field
    // so the consumer can short-circuit before reading the rest.
    const columnP = env.DB.prepare(
      "SELECT name, type, [notnull] AS not_null, dflt_value FROM pragma_table_info('threats') WHERE name = 'enrichment_attempts'"
    ).first<{ name: string; type: string; not_null: number; dflt_value: string | null }>();

    const indexP = env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_threats_carto_phase0'"
    ).first<{ sql: string | null }>();

    // Migration 0112 status: how many hosting_providers rows still carry a
    // legacy (non-canonical) id. After the migration applies successfully,
    // this should be 0. The platform works correctly without it (cartographer's
    // pre-resolve handles legacy ids transparently — see PR #826), so this is
    // purely a "did the cleanup migration run?" signal.
    const legacyHpIdsP = env.DB.prepare(
      "SELECT COUNT(*) AS n FROM hosting_providers WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn"
    ).first<{ n: number }>();

    // Sample of legacy rows for diagnosis. Kept tight (10 rows) since the
    // expected steady-state count is 0 after cleanup. The id format gives
    // away which insert path created the row — UUID-shaped means the
    // cartographerBackfill workflow path; hp_<slug> means the legacy
    // upsertHostingProvider helper in lib/geoip.ts.
    const legacyHpSampleP = env.DB.prepare(
      `SELECT id, asn, name FROM hosting_providers
       WHERE asn IS NOT NULL AND asn != '' AND id != 'hp_' || asn
       ORDER BY id LIMIT 10`
    ).all<{ id: string; asn: string; name: string }>();

    // ─── Attempts distribution ────────────────────────────────────
    // Histogram across the full 0..5 range so the consumer can see the
    // shape of the queue: heavy at 0 = fresh ingest dominating, heavy at
    // higher buckets = ip-api yield is poor and most threats are spinning.
    const attemptsHistP = env.DB.prepare(`
      SELECT enrichment_attempts AS attempts, COUNT(*) AS n
      FROM threats
      WHERE enriched_at IS NULL
        AND ip_address IS NOT NULL AND ip_address != ''
      GROUP BY enrichment_attempts
      ORDER BY enrichment_attempts ASC
    `).all<{ attempts: number; n: number }>();

    // ─── Queue / exhausted split (matches platform-diagnostics) ───
    const queueP = env.DB.prepare(`
      SELECT
        SUM(CASE WHEN enrichment_attempts < 5 THEN 1 ELSE 0 END) AS queue_active,
        SUM(CASE WHEN enrichment_attempts >= 5 THEN 1 ELSE 0 END) AS exhausted
      FROM threats
      WHERE enriched_at IS NULL
        AND ip_address IS NOT NULL AND ip_address != ''
        ${PRIVATE_IP_SQL_FILTER}
    `).first<{ queue_active: number; exhausted: number }>();

    // ─── Stuck pile (pre-fix orphans) ─────────────────────────────
    // Threats with enriched_at stamped but no lat — partial-geo bug from
    // before migration 0110 / cartographer attempts logic. Distinct from
    // the cartographer queue (those have enriched_at NULL).
    const stuckP = env.DB.prepare(`
      SELECT COUNT(*) AS n FROM threats
      WHERE status = 'active'
        AND enriched_at IS NOT NULL
        AND lat IS NULL
        AND ip_address IS NOT NULL AND ip_address != ''
    `).first<{ n: number }>();

    // ─── Throughput: enriched-now vs queue ────────────────────────
    const throughputP = env.DB.prepare(`
      SELECT
        SUM(CASE WHEN lat IS NOT NULL AND enriched_at >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS enriched_last_hour,
        SUM(CASE WHEN lat IS NOT NULL AND enriched_at >= datetime('now', '-6 hours') THEN 1 ELSE 0 END) AS enriched_last_6h,
        SUM(CASE WHEN lat IS NOT NULL AND enriched_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS enriched_last_24h
      FROM threats
    `).first<{ enriched_last_hour: number; enriched_last_6h: number; enriched_last_24h: number }>();

    // ─── Recent runs ──────────────────────────────────────────────
    const recentRunsP = env.DB.prepare(`
      SELECT id, status, started_at, completed_at, duration_ms, records_processed,
             outputs_generated, tokens_used, error_message
      FROM agent_runs
      WHERE agent_id = 'cartographer'
      ORDER BY started_at DESC
      LIMIT 10
    `).all<{
      id: string;
      status: string;
      started_at: string;
      completed_at: string | null;
      duration_ms: number | null;
      records_processed: number | null;
      outputs_generated: number | null;
      tokens_used: number | null;
      error_message: string | null;
    }>();

    // ─── Recent Phase 0 batches ───────────────────────────────────
    // The diagnostic agent_outputs row pushed at the end of Phase 0 carries
    // batch_enriched (legacy alias for batch_geo_responded — counts any
    // ip-api status='success' response), batch_geo_located (lat populated;
    // post-PR-#824 only), batch_size, and max_batches.
    //
    // Yield is computed from batch_geo_located when present (the honest
    // metric — actual usable enrichments / theoretical max). Legacy rows
    // fall back to batch_enriched, which overstates yield because ip-api
    // returns status='success' with empty geo for ~93% of IPs.
    const batchOutputsP = env.DB.prepare(`
      SELECT created_at, summary,
             json_extract(details, '$.batch_enriched') AS batch_enriched,
             json_extract(details, '$.batch_geo_located') AS batch_geo_located,
             json_extract(details, '$.rdap_enriched') AS rdap_enriched,
             json_extract(details, '$.batch_size') AS batch_size,
             json_extract(details, '$.max_batches') AS max_batches,
             json_extract(details, '$.batch_flush_successes') AS batch_flush_successes,
             json_extract(details, '$.batch_flush_failures') AS batch_flush_failures,
             json_extract(details, '$.batch_flush_failure_pct') AS batch_flush_failure_pct,
             json_extract(details, '$.first_flush_error') AS first_flush_error,
             json_extract(details, '$.first_flush_error_chunk') AS first_flush_error_chunk
      FROM agent_outputs
      WHERE agent_id = 'cartographer' AND type = 'diagnostic'
      ORDER BY created_at DESC
      LIMIT 10
    `).all<{
      created_at: string;
      summary: string;
      batch_enriched: number | null;
      batch_geo_located: number | null;
      rdap_enriched: number | null;
      batch_size: number | null;
      max_batches: number | null;
      batch_flush_successes: number | null;
      batch_flush_failures: number | null;
      batch_flush_failure_pct: number | null;
      first_flush_error: string | null;
      first_flush_error_chunk: number | null;
    }>();

    const [
      column, indexRow, legacyHpIds, legacyHpSample, attemptsHist, queue, stuck, throughput, recentRuns, batchOutputs,
    ] = await Promise.all([
      columnP, indexP, legacyHpIdsP, legacyHpSampleP, attemptsHistP, queueP, stuckP, throughputP, recentRunsP, batchOutputsP,
    ]);

    // ─── Compute ip-api yields from recent batches ────────────────
    // Two yields surfaced separately:
    //   geo_located_yield = batch_geo_located / max_theoretical
    //     The honest metric — fraction of attempted threats that received
    //     coordinates and will actually advance the platform's geo data.
    //     This is the headline that drives the "do we need a fallback geo
    //     source?" decision.
    //   geo_responded_yield = batch_geo_responded (legacy batch_enriched)
    //     / max_theoretical. ip-api status='success' rate, including
    //     the empty / ASN-only responses. Always ≥ geo_located_yield;
    //     the gap shows how often ip-api responds but with no usable geo.
    //
    // Legacy rows (pre-PR-#824) lack batch_geo_located. They contribute
    // to geo_responded_yield only — geo_located_yield averages just the
    // post-fix rows so the metric stays clean.
    const calcAvg = (values: number[]): number | null =>
      values.length > 0
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 10
        : null;

    const respondedYields: number[] = [];
    const locatedYields: number[] = [];
    for (const r of batchOutputs.results) {
      const max = (r.batch_size ?? 0) * (r.max_batches ?? 0);
      if (max <= 0) continue;
      if (r.batch_enriched != null) respondedYields.push((r.batch_enriched ?? 0) / max);
      if (r.batch_geo_located != null) locatedYields.push((r.batch_geo_located ?? 0) / max);
    }

    const geoRespondedYieldPct = calcAvg(respondedYields);
    const geoLocatedYieldPct = calcAvg(locatedYields);
    // Headline yield prefers the honest metric; falls back to legacy if
    // no post-fix data exists yet.
    const avgYieldPct = geoLocatedYieldPct ?? geoRespondedYieldPct;

    // ─── Migration status flag ────────────────────────────────────
    const migration0110Applied = column != null;
    const indexHasAttemptsFilter = (indexRow?.sql ?? "").includes("enrichment_attempts < 5");

    // ─── D1 batch flush health ────────────────────────────────────
    // Aggregate flush failures across recent batches so the consumer can
    // see at a glance whether cartographer's threat UPDATEs are actually
    // persisting. Phase 0 inflated counters (batch_geo_located) report
    // what ip-api returned, NOT what got written — the gap with
    // throughput.enriched_last_hour is the symptom; this is the cause.
    const batchesWithFlushData = batchOutputs.results.filter(
      r => r.batch_flush_successes != null || r.batch_flush_failures != null,
    );
    const totalFlushSuccesses = batchesWithFlushData.reduce(
      (s, r) => s + (r.batch_flush_successes ?? 0), 0,
    );
    const totalFlushFailures = batchesWithFlushData.reduce(
      (s, r) => s + (r.batch_flush_failures ?? 0), 0,
    );
    const totalFlushChunks = totalFlushSuccesses + totalFlushFailures;
    const aggFlushFailurePct = totalFlushChunks > 0
      ? Math.round((totalFlushFailures / totalFlushChunks) * 1000) / 10
      : null;
    const mostRecentError = batchesWithFlushData
      .find(r => r.first_flush_error != null);

    return json({
      success: true,
      data: {
        _meta: {
          generated_at: new Date().toISOString(),
          endpoint_version: 3,
        },

        migration: {
          // If false, all other fields below are stale or partial. The
          // diagnostic queries reference enrichment_attempts; if the column
          // is missing some of them throw and the response is incomplete.
          column_applied: migration0110Applied,
          index_has_attempts_filter: indexHasAttemptsFilter,
          column_def: column,
          index_sql: indexRow?.sql ?? null,
          // Migration 0112 cleanup: count of hosting_providers rows still
          // carrying legacy non-canonical ids. 0 = migration applied;
          // >0 = migration still pending or failed (cartographer's
          // pre-resolve continues to handle these correctly).
          legacy_hosting_provider_ids: legacyHpIds?.n ?? 0,
          legacy_hosting_provider_sample: legacyHpSample.results,
        },

        queue: {
          active: queue?.queue_active ?? 0,
          exhausted: queue?.exhausted ?? 0,
          stuck_pile: stuck?.n ?? 0,
          attempts_histogram: attemptsHist.results,
        },

        throughput: {
          enriched_last_hour: throughput?.enriched_last_hour ?? 0,
          enriched_last_6h: throughput?.enriched_last_6h ?? 0,
          enriched_last_24h: throughput?.enriched_last_24h ?? 0,
        },

        ip_api_yield: {
          recent_batches: batchOutputs.results,
          // avg_yield_pct = the lat-populated rate (honest), or the
          // status='success' rate when no post-fix rows are available
          // (legacy fallback, overstates).
          avg_yield_pct: avgYieldPct,
          // Both fields surfaced separately so consumers can reason about
          // ip-api's response rate vs its actual coverage.
          //  geo_located_yield_pct  → coords actually returned (the metric
          //    that matters for the platform's geo data quality)
          //  geo_responded_yield_pct → status='success' rate (always
          //    >= located; the gap shows partial-success leakage)
          geo_located_yield_pct: geoLocatedYieldPct,
          geo_responded_yield_pct: geoRespondedYieldPct,
          // Threshold guidance applies to geo_located_yield_pct:
          //  >= 50%  → ip-api is healthy, no fallback needed
          //  20-50% → degraded but functional, monitor
          //  <  20% → fallback geo source likely needed (Cloudflare Radar, MaxMind)
        },

        // ip-api yield being high while throughput.enriched_last_hour stays
        // low means the writes aren't persisting. This block surfaces the
        // root cause directly — env.DB.batch() failures get caught and the
        // first error message is captured per Phase 0 run; this aggregates
        // across recent batches so the issue is visible in one place.
        d1_batch_health: {
          // Across all recent Phase 0 batches with flush data:
          total_chunks: totalFlushChunks,
          total_successes: totalFlushSuccesses,
          total_failures: totalFlushFailures,
          // Overall failure rate. >0 means threat UPDATEs are silently
          // rolling back due to D1 batch atomicity — atomic per-call,
          // any failed statement loses all 100 statements in the chunk.
          aggregate_failure_pct: aggFlushFailurePct,
          // Most recent captured error message + which chunk it failed on.
          // Chunks of 100 are mixed UPDATE threats / INSERT hosting_providers
          // / campaign escalation INSERTs, so the chunk index narrows the
          // statement type without needing wrangler tail.
          most_recent_error: mostRecentError?.first_flush_error ?? null,
          most_recent_error_chunk: mostRecentError?.first_flush_error_chunk ?? null,
          most_recent_error_at: mostRecentError?.created_at ?? null,
        },

        recent_runs: recentRuns.results,
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}
