/**
 * Cube Healer Agent — Phase 4.2 retroactive drift remediation.
 *
 * Runs 6-hourly via the "12 *\/6 * * *" cron. Performs a full 30-day
 * bulk rebuild of threat_cube_geo, threat_cube_provider, and
 * threat_cube_brand via INSERT OR REPLACE ... SELECT ... GROUP BY,
 * bounding drift from cartographer's retroactive enrichment to ≤6 hours
 * of back-fill.
 *
 * Why this exists:
 *   Cartographer's candidate query has no time filter — it enriches threats
 *   retroactively from any point in the N-day window. Phase 3's Navigator cube
 *   refresh only rebuilds the current + previous hour, so any hour older than
 *   H-1 freezes in the cube while raw threats continues to grow, producing
 *   permanent drift that Phase 4.1's parity_checker first detected (3.64% on
 *   the 30-day geo cube, 2.88% on provider).
 *
 * Scope — EXCLUDES the current partial hour (Phase 3's territory). The "prev
 * hour" overlap with Navigator is intentional and safe because INSERT OR
 * REPLACE is idempotent. The bulk SQL is verbatim from the manual test that
 * proved exact parity against the raw threats table.
 *
 * Lifecycle (Phase 2.3 of agent audit):
 *   The agent_runs row is now managed by executeAgent() per
 *   AGENT_STANDARD §4 (six-stage lifecycle). This module's execute()
 *   does the cube-heal SQL and returns AgentResult — it no longer
 *   inserts/updates agent_runs directly. Per-cube failures land in
 *   agentOutputs as severity='high' diagnostics; only a catastrophic
 *   geo-cube failure throws upstream (→ status='failed').
 *
 *   The "partial" status that the legacy runCubeHealer() set manually
 *   on per-cube failures is downgraded to 'success' in agent_runs but
 *   surfaced as a diagnostic agent_output row (severity='high'). When
 *   AgentResult gains a `partial: boolean` field in Phase 4, we'll
 *   restore the strict partial semantic.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from '../lib/agentRunner';

// ─── Heal SQL ────────────────────────────────────────────────────
// Literals only (no bind params). These exact queries were verified in
// production to produce exact parity against the raw threats table.

const GEO_HEAL_SQL = `
  INSERT OR REPLACE INTO threat_cube_geo
    (hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity,
     source_feed, threat_count, updated_at)
  SELECT
    strftime('%Y-%m-%d %H:00:00', created_at),
    ROUND(lat * 100) / 100.0,
    ROUND(lng * 100) / 100.0,
    COALESCE(country_code, 'XX'),
    COALESCE(threat_type, 'unknown'),
    COALESCE(severity, 'unknown'),
    COALESCE(source_feed, 'unknown'),
    COUNT(*),
    datetime('now')
  FROM threats
  WHERE created_at >= datetime('now', '-30 days')
    AND created_at < strftime('%Y-%m-%d %H:00:00', datetime('now'))
    AND status = 'active'
    AND lat IS NOT NULL
    AND lng IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5, 6, 7
`;

const PROVIDER_HEAL_SQL = `
  INSERT OR REPLACE INTO threat_cube_provider
    (hour_bucket, hosting_provider_id, threat_type, severity, source_feed,
     threat_count, updated_at)
  SELECT
    strftime('%Y-%m-%d %H:00:00', created_at),
    hosting_provider_id,
    COALESCE(threat_type, 'unknown'),
    COALESCE(severity, 'unknown'),
    COALESCE(source_feed, 'unknown'),
    COUNT(*),
    datetime('now')
  FROM threats
  WHERE created_at >= datetime('now', '-30 days')
    AND created_at < strftime('%Y-%m-%d %H:00:00', datetime('now'))
    AND status = 'active'
    AND hosting_provider_id IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5
`;

const BRAND_HEAL_SQL = `
  INSERT OR REPLACE INTO threat_cube_brand
    (hour_bucket, target_brand_id, threat_type, severity, source_feed,
     threat_count, updated_at)
  SELECT
    strftime('%Y-%m-%d %H:00:00', created_at),
    target_brand_id,
    COALESCE(threat_type, 'unknown'),
    COALESCE(severity, 'unknown'),
    COALESCE(source_feed, 'unknown'),
    COUNT(*),
    datetime('now')
  FROM threats
  WHERE created_at >= datetime('now', '-30 days')
    AND created_at < strftime('%Y-%m-%d %H:00:00', datetime('now'))
    AND status = 'active'
    AND target_brand_id IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5
`;

// Status cube heal — captures every threat (no status filter, no
// dimension NOT NULL filter). The 6-hourly cadence here is the lag
// window for status transitions (active → down → remediated): an
// hour bucket carries stale numbers for at most 6 hours before this
// SQL replays it from the source of truth.
const STATUS_HEAL_SQL = `
  INSERT OR REPLACE INTO threat_cube_status
    (hour_bucket, threat_type, severity, source_feed, status,
     threat_count, updated_at)
  SELECT
    strftime('%Y-%m-%d %H:00:00', created_at),
    COALESCE(threat_type, 'unknown'),
    COALESCE(severity, 'unknown'),
    COALESCE(source_feed, 'unknown'),
    COALESCE(status, 'unknown'),
    COUNT(*),
    datetime('now')
  FROM threats
  WHERE created_at >= datetime('now', '-30 days')
    AND created_at < strftime('%Y-%m-%d %H:00:00', datetime('now'))
  GROUP BY 1, 2, 3, 4, 5
`;

// Arcs cube heal — PR-Z. Same 30-day window as the other cubes.
// Source filter mirrors buildArcsCubeForHour: status='active',
// target_brand_id NOT NULL, lat/lng NOT NULL. Aggregates source_lat/
// source_lng as the centroid of attacking IPs in each (country, brand,
// type, severity, source_feed) bucket.
const ARCS_HEAL_SQL = `
  INSERT OR REPLACE INTO threat_cube_arcs
    (hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed,
     threat_count, source_lat, source_lng, first_seen, last_seen, updated_at)
  SELECT
    strftime('%Y-%m-%d %H:00:00', created_at),
    COALESCE(country_code, 'XX'),
    target_brand_id,
    COALESCE(threat_type, 'unknown'),
    COALESCE(severity, 'unknown'),
    COALESCE(source_feed, 'unknown'),
    COUNT(*),
    ROUND(AVG(lat), 1),
    ROUND(AVG(lng), 1),
    MIN(created_at),
    MAX(created_at),
    datetime('now')
  FROM threats
  WHERE created_at >= datetime('now', '-30 days')
    AND created_at < strftime('%Y-%m-%d %H:00:00', datetime('now'))
    AND status = 'active'
    AND lat IS NOT NULL
    AND lng IS NOT NULL
    AND target_brand_id IS NOT NULL
  GROUP BY 1, 2, 3, 4, 5, 6
`;

// ─── Agent module ────────────────────────────────────────────────

export const cubeHealerAgent: AgentModule = {
  name: 'cube_healer',
  displayName: 'Cube Healer',
  description: 'OLAP cube maintenance — periodic 30-day rebuild + brand summaries',
  color: '#0EA5E9',
  trigger: 'scheduled',
  requiresApproval: false,
  stallThresholdMinutes: 420,
  parallelMax: 1,
  costGuard: 'exempt',
  // No AI calls — pure D1 / cube SQL. Cap=0 surfaces regressions.
  budget: { monthlyTokenCap: 0 },
  reads: [
    { kind: 'kv', namespace: 'CACHE' },
    { kind: 'd1_table', name: 'threats' },
  ],
  writes: [
    { kind: 'd1_table', name: 'threat_cube_brand' },
    { kind: 'd1_table', name: 'threat_cube_geo' },
    { kind: 'd1_table', name: 'threat_cube_provider' },
    { kind: 'd1_table', name: 'threat_cube_status' },
    { kind: 'd1_table', name: 'threat_cube_arcs' },
  ],
  outputs: [],
  status: 'active',
  category: 'ops',
  pipelinePosition: 13,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    let rowsWritten = 0;
    const partialFailures: AgentOutputEntry[] = [];

    // ── Geo heal ────────────────────────────────────────────────
    // If geo throws here we let it propagate up to executeAgent(),
    // which marks status='failed' — matching the legacy "first query
    // throws → status: 'failed'" contract.
    const geoResult = await env.DB.prepare(GEO_HEAL_SQL).run();
    rowsWritten += geoResult.meta?.changes ?? 0;

    // ── Provider heal ───────────────────────────────────────────
    // If provider throws after geo succeeded, capture as partial-failure
    // diagnostic. Don't propagate — the rest of the chain still has work
    // to do and the geo cube is already healed. (executeAgent will mark
    // status='success' but the diagnostic agent_output row carries the
    // error for forensic visibility.)
    try {
      const providerResult = await env.DB.prepare(PROVIDER_HEAL_SQL).run();
      rowsWritten += providerResult.meta?.changes ?? 0;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      partialFailures.push({
        type: 'diagnostic',
        summary: `cube_healer provider heal failed (geo succeeded, ${rowsWritten} rows landed)`,
        severity: 'high',
        details: { error: errMsg, stage: 'provider', rowsLanded: rowsWritten },
      });
    }

    // ── Brand heal ──────────────────────────────────────────────
    try {
      const brandResult = await env.DB.prepare(BRAND_HEAL_SQL).run();
      rowsWritten += brandResult.meta?.changes ?? 0;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      partialFailures.push({
        type: 'diagnostic',
        summary: `cube_healer brand heal failed (${rowsWritten} rows so far)`,
        severity: 'high',
        details: { error: errMsg, stage: 'brand', rowsLanded: rowsWritten },
      });
    }

    // ── Status heal ─────────────────────────────────────────────
    // Status cube has no dimension filter and no status filter, so
    // this is the only path that reconciles status mutations
    // (active → down → remediated) for older hour buckets.
    try {
      const statusResult = await env.DB.prepare(STATUS_HEAL_SQL).run();
      rowsWritten += statusResult.meta?.changes ?? 0;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      partialFailures.push({
        type: 'diagnostic',
        summary: `cube_healer status heal failed (${rowsWritten} rows so far)`,
        severity: 'high',
        details: { error: errMsg, stage: 'status', rowsLanded: rowsWritten },
      });
    }

    // ── Arcs heal (PR-Z) ────────────────────────────────────────
    // Country × brand × type × severity slice for the Observatory
    // globe arcs. Same partial-failure handling as the others —
    // arcs failure doesn't kill the whole heal cycle.
    try {
      const arcsResult = await env.DB.prepare(ARCS_HEAL_SQL).run();
      rowsWritten += arcsResult.meta?.changes ?? 0;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      partialFailures.push({
        type: 'diagnostic',
        summary: `cube_healer arcs heal failed (${rowsWritten} rows so far)`,
        severity: 'high',
        details: { error: errMsg, stage: 'arcs', rowsLanded: rowsWritten },
      });
    }

    // ── Dark web + app store brand summaries ───────────────────
    // Brand-keyed (not hour-bucketed) summary tables — one row per brand
    // counting "all active mentions / listings". Rebuilt from scratch
    // each tick; same atomic INSERT OR REPLACE shape as the cubes above.
    try {
      const { buildDarkWebBrandSummary, buildAppStoreBrandSummary } = await import('../lib/cube-builder');
      const dwResult = await buildDarkWebBrandSummary(env);
      rowsWritten += dwResult.rowsWritten;
      if (dwResult.error) {
        partialFailures.push({
          type: 'diagnostic',
          summary: `cube_healer dark_web summary failed`,
          severity: 'high',
          details: { error: dwResult.error, stage: 'dark_web_summary', rowsLanded: rowsWritten },
        });
      }
      const asResult = await buildAppStoreBrandSummary(env);
      rowsWritten += asResult.rowsWritten;
      if (asResult.error) {
        partialFailures.push({
          type: 'diagnostic',
          summary: `cube_healer app_store summary failed`,
          severity: 'high',
          details: { error: asResult.error, stage: 'app_store_summary', rowsLanded: rowsWritten },
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      partialFailures.push({
        type: 'diagnostic',
        summary: 'cube_healer brand summary dispatch failed',
        severity: 'high',
        details: { error: errMsg, stage: 'brand_summary_dispatch', rowsLanded: rowsWritten },
      });
    }

    // ── Weekly ANALYZE ──────────────────────────────────────────
    // D1 doesn't auto-run ANALYZE, so sqlite_stat1 only updates when
    // we explicitly ask. Without fresh stats the query planner falls
    // back to heuristics that can silently pick a worse index as the
    // data shape drifts — we saw exactly this in PR #776 where
    // partial indexes were only picked up after a manual ANALYZE.
    //
    // Gated once per 7 days via KV so it runs ~once/week regardless
    // of which 6-hour tick happens to cross the boundary. Full-table
    // scan during ANALYZE is cheap (a few hundred ms) but we don't
    // need it more often than that — distribution changes are slow.
    //
    // Non-fatal: ANALYZE failure becomes a low-severity diagnostic.
    try {
      const ANALYZE_LOCK_KEY = 'cube_healer:last_analyze_at';
      const ANALYZE_INTERVAL_S = 7 * 24 * 60 * 60; // 7 days
      const lastRun = await env.CACHE.get(ANALYZE_LOCK_KEY);
      const lastRunMs = lastRun ? Number(lastRun) : 0;
      const shouldAnalyze = !lastRunMs || (Date.now() - lastRunMs) > ANALYZE_INTERVAL_S * 1000;
      if (shouldAnalyze) {
        await env.DB.prepare('ANALYZE threats').run();
        await env.DB.prepare('ANALYZE brands').run();
        await env.CACHE.put(ANALYZE_LOCK_KEY, String(Date.now()), {
          expirationTtl: ANALYZE_INTERVAL_S * 2,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      partialFailures.push({
        type: 'diagnostic',
        summary: 'cube_healer ANALYZE failed (non-fatal — cube heal still committed)',
        severity: 'medium',
        details: { error: errMsg, stage: 'analyze' },
      });
    }

    return {
      itemsProcessed: rowsWritten,
      itemsCreated: rowsWritten,
      itemsUpdated: 0,
      output: { rowsWritten, partialFailureCount: partialFailures.length },
      agentOutputs: partialFailures,
    };
  },
};
