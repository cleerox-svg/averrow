/**
 * Cube Healer Agent — Phase 4.2 retroactive drift remediation.
 *
 * Runs 6-hourly via the "12 *\/6 * * *" cron. Performs a bulk rebuild of
 * threat_cube_geo, threat_cube_provider, threat_cube_brand,
 * threat_cube_status, and threat_cube_arcs over an hour-snapped window.
 * Per cube, one atomic db.batch() of [stale-row sweep, guarded upsert]:
 * the sweep (cubeStaleSweepSQL, lib/cube-builder.ts) deletes window rows
 * whose key vanished from the source (threats went inactive or moved
 * group); the upsert rewrites only the groups whose aggregate changed.
 * Together they make every healed hour exactly equal to the source,
 * bounding drift from cartographer's retroactive enrichment AND from
 * status changes within that window.
 *
 * Two-window strategy (PR-BM, 2026-05-21):
 *   - **Hot heal** (default, 3 of 4 daily ticks): 2-day window.
 *     Catches the bulk of cartographer's retroactive enrichment, which
 *     is concentrated in the most recent 24-48h.
 *   - **Cold heal** (once per UTC day, at hour===0): full 14-day
 *     window. Catches any longer-tail backfill the hot heals missed.
 *
 * Expected write reduction: 4 × 14d = 56d-equivalent rebuilds per day
 * pre-PR-BM → 3 × 2d + 1 × 14d = 20d-equivalent (~64% fewer writes).
 *
 * Window history:
 *   - Originally 30 days. Reduced to 14d in PR-BL after diagnostics
 *     showed cube_healer was the #1 D1 writer (~1.6M/day, projecting
 *     205% of the 50M write quota).
 *   - Split into hot/cold in PR-BM after 14d still projected 192% of
 *     quota. Diagnostics confirmed cartographer's retroactive
 *     enrichment lives in the first 24-48h; older hour-buckets almost
 *     never receive updated lat/lng or hosting_provider_id, so
 *     rebuilding them 4×/day was wasted I/O.
 *
 * Why this exists:
 *   Cartographer's candidate query has no time filter — it enriches threats
 *   retroactively from any point in the N-day window. Phase 3's Navigator cube
 *   refresh only rebuilds the current + previous hour, so any hour older than
 *   H-1 freezes in the cube while raw threats continues to grow, producing
 *   permanent drift that Phase 4.1's parity_checker first detected (3.64% on
 *   the 30-day geo cube, 2.88% on provider).
 *
 * Scope — [window start, top of the current hour): EXCLUDES the current
 * partial hour (Phase 3's territory). The window start is snapped to the top
 * of an hour too — an unsnapped `datetime('now','-N days')` rebuilt the
 * oldest hour from a PARTIAL slice of its threats and overwrote that hour's
 * full count with the smaller number. The "prev hour" overlap with Navigator
 * is intentional and safe because both writers are idempotent.
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
import { cubeStaleSweepSQL, type CubeName } from '../lib/cube-builder';

// ─── Heal window selection ───────────────────────────────────────
// Hot vs cold scope (PR-BM): hot covers the most recent 2 days,
// cold covers the full 14-day safety net. Tick at UTC hour===0
// (the 00:12 cron) picks cold; all other ticks pick hot.

export const HOT_HEAL_WINDOW_DAYS = 2;
export const COLD_HEAL_WINDOW_DAYS = 14;

/**
 * Decide whether the current tick should run a cold (full 14d) or hot (2d) heal.
 * Exported for unit testing — the cron-time → scope mapping is the core of the
 * write-budget reduction strategy.
 */
export function pickHealScope(scheduledTime: Date): 'hot' | 'cold' {
  // Cold heal runs once per UTC day at the 00:12 cron tick. All other
  // ticks (06:12, 12:12, 18:12) run hot. UTC alignment matches the
  // platform's daily-snapshot + briefing email schedule.
  return scheduledTime.getUTCHours() === 0 ? 'cold' : 'hot';
}

// ─── Heal window ─────────────────────────────────────────────────

/**
 * Hour-snapped heal window: [top of (now's hour) − days, top of now's hour).
 * Both bounds are 'YYYY-MM-DD HH:00:00' strings, bound as ?1 / ?2 into the
 * sweep and the upsert so the two statements cover the identical window.
 * Exported for unit testing.
 */
export function healWindow(now: Date, windowDays: number): { start: string; end: string } {
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
  const startMs = endMs - windowDays * 24 * 60 * 60 * 1000;
  const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  return { start: fmt(startMs), end: fmt(endMs) };
}

// ─── Heal SQL ────────────────────────────────────────────────────
// Binds: ?1 = window start, ?2 = window end (see healWindow).

function healSQL(table: CubeName): string {
  // PR-BO (2026-05-22): INSERT ... ON CONFLICT(pk) DO UPDATE SET ... WHERE
  // <existing IS NOT excluded> — unchanged buckets cost 0 row mutations
  // (INSERT OR REPLACE billed 2 per bucket). Use `IS NOT` (not `!=`) so
  // NULL on either side compares correctly — source_lat/source_lng/
  // first_seen/last_seen can legitimately be NULL on arcs.
  //
  // The upsert alone never removes a group; the paired cubeStaleSweepSQL
  // statement (same batch) does.
  switch (table) {
    case 'geo':
      return `
        INSERT INTO threat_cube_geo
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
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND lat IS NOT NULL
          AND lng IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6, 7
        ON CONFLICT(hour_bucket, lat_bucket, lng_bucket, country_code, threat_type, severity, source_feed)
        DO UPDATE SET
          threat_count = excluded.threat_count,
          updated_at = excluded.updated_at
        WHERE threat_cube_geo.threat_count IS NOT excluded.threat_count
      `;
    case 'provider':
      return `
        INSERT INTO threat_cube_provider
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
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND hosting_provider_id IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5
        ON CONFLICT(hour_bucket, hosting_provider_id, threat_type, severity, source_feed)
        DO UPDATE SET
          threat_count = excluded.threat_count,
          updated_at = excluded.updated_at
        WHERE threat_cube_provider.threat_count IS NOT excluded.threat_count
      `;
    case 'brand':
      return `
        INSERT INTO threat_cube_brand
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
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND target_brand_id IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5
        ON CONFLICT(hour_bucket, target_brand_id, threat_type, severity, source_feed)
        DO UPDATE SET
          threat_count = excluded.threat_count,
          updated_at = excluded.updated_at
        WHERE threat_cube_brand.threat_count IS NOT excluded.threat_count
      `;
    case 'status':
      // No status filter and no dimension NOT NULL filter — this is the
      // only path that reconciles status mutations (active → down →
      // remediated) for older hour buckets, so it always reads the
      // whole window.
      return `
        INSERT INTO threat_cube_status
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
        WHERE created_at >= ?1
          AND created_at < ?2
        GROUP BY 1, 2, 3, 4, 5
        ON CONFLICT(hour_bucket, threat_type, severity, source_feed, status)
        DO UPDATE SET
          threat_count = excluded.threat_count,
          updated_at = excluded.updated_at
        WHERE threat_cube_status.threat_count IS NOT excluded.threat_count
      `;
    case 'arcs':
      return `
        INSERT INTO threat_cube_arcs
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
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND lat IS NOT NULL
          AND lng IS NOT NULL
          AND target_brand_id IS NOT NULL
        GROUP BY 1, 2, 3, 4, 5, 6
        ON CONFLICT(hour_bucket, country_code, target_brand_id, threat_type, severity, source_feed)
        DO UPDATE SET
          threat_count = excluded.threat_count,
          source_lat = excluded.source_lat,
          source_lng = excluded.source_lng,
          first_seen = excluded.first_seen,
          last_seen = excluded.last_seen,
          updated_at = excluded.updated_at
        WHERE threat_cube_arcs.threat_count IS NOT excluded.threat_count
           OR threat_cube_arcs.first_seen IS NOT excluded.first_seen
           OR threat_cube_arcs.last_seen IS NOT excluded.last_seen
           OR threat_cube_arcs.source_lat IS NOT excluded.source_lat
           OR threat_cube_arcs.source_lng IS NOT excluded.source_lng
      `;
  }
}

// Exported for unit testing.
export function healSQLForTest(table: CubeName): string {
  return healSQL(table);
}

/**
 * Heal one cube over [start, end): one atomic batch of the stale-row sweep
 * and the guarded upsert, both bound to the same window. Returns rows written.
 * Exported for unit testing.
 */
export async function healCube(
  db: D1Database,
  table: CubeName,
  window: { start: string; end: string },
): Promise<number> {
  const results = await db.batch([
    db.prepare(cubeStaleSweepSQL(table)).bind(window.start, window.end),
    db.prepare(healSQL(table)).bind(window.start, window.end),
  ]);
  return results.reduce((sum, r) => sum + (r?.meta?.changes ?? 0), 0);
}

// ─── Agent module ────────────────────────────────────────────────

export const cubeHealerAgent: AgentModule = {
  name: 'cube_healer',
  displayName: 'Cube Healer',
  description: 'OLAP cube maintenance — 6-hourly 2-day heal (14-day once a day) + brand summaries',
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
    // Also writes brands.threat_count via lib/brand-count-reconciler.ts —
    // not declared here because the resource-drift check extracts only SQL
    // in this file (same as the dark-web/app-store summaries above).
  ],
  outputs: [],
  status: 'active',
  category: 'ops',
  pipelinePosition: 13,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    let rowsWritten = 0;
    const partialFailures: AgentOutputEntry[] = [];

    // Choose hot (2d) vs cold (14d) window based on cron tick time.
    // The orchestrator threads `scheduledTime` (ISO string) through
    // ctx.input — same pattern as Navigator. Fall back to wall-clock
    // when called outside the cron path (manual/admin trigger).
    const scheduledTimeRaw = typeof ctx.input?.scheduledTime === 'string'
      ? ctx.input.scheduledTime
      : null;
    const scheduledTime = scheduledTimeRaw ? new Date(scheduledTimeRaw) : new Date();
    const scope = pickHealScope(scheduledTime);
    const windowDays = scope === 'cold' ? COLD_HEAL_WINDOW_DAYS : HOT_HEAL_WINDOW_DAYS;
    // Snapped to the top of the hour at execute() time (wall clock, not the
    // cron tick) so the upper bound always excludes the current partial hour.
    const window = healWindow(new Date(), windowDays);

    // ── Geo heal ────────────────────────────────────────────────
    // If geo throws here we let it propagate up to executeAgent(),
    // which marks status='failed' — matching the legacy "first query
    // throws → status: 'failed'" contract.
    const geoRows = await healCube(env.DB, 'geo', window);
    rowsWritten += geoRows;

    // ── Provider heal ───────────────────────────────────────────
    // If provider throws after geo succeeded, capture as partial-failure
    // diagnostic. Don't propagate — the rest of the chain still has work
    // to do and the geo cube is already healed. (executeAgent will mark
    // status='success' but the diagnostic agent_output row carries the
    // error for forensic visibility.)
    try {
      const providerRows = await healCube(env.DB, 'provider', window);
      rowsWritten += providerRows;
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
      const brandRows = await healCube(env.DB, 'brand', window);
      rowsWritten += brandRows;
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
      const statusRows = await healCube(env.DB, 'status', window);
      rowsWritten += statusRows;
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
      const arcsRows = await healCube(env.DB, 'arcs', window);
      rowsWritten += arcsRows;
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
    // each tick via a guarded upsert (see lib/cube-builder.ts).
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

    // ── Brand counter reconciliation (2026-07-07 drift audit) ───
    // brands.threat_count / last_threat_seen had NO owner: several
    // brand-link paths set threats.target_brand_id without bumping the
    // counter (analyst keyword pre-match above all), so 45% of linked
    // brands drifted and 3,246 sat at 0 — which also silently excluded
    // them from the mastodon/reddit `threat_count > 0` eligibility
    // gate. Same healer pattern as the cubes: full diff per tick,
    // batched fix-ups for drifted rows only. Stamps
    // metrics:brand_threat_count_drift for platform-diagnostics.
    let brandDrift: { brandsChecked: number; drifted: number; fixed: number } | null = null;
    try {
      const { reconcileBrandThreatCounts } = await import('../lib/brand-count-reconciler');
      brandDrift = await reconcileBrandThreatCounts(env);
      rowsWritten += brandDrift.fixed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      partialFailures.push({
        type: 'diagnostic',
        summary: 'cube_healer brand counter reconciliation failed',
        severity: 'high',
        details: { error: errMsg, stage: 'brand_count_reconcile', rowsLanded: rowsWritten },
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
      output: { rowsWritten, partialFailureCount: partialFailures.length, scope, windowDays, windowStart: window.start, windowEnd: window.end, brandDrift },
      agentOutputs: partialFailures,
    };
  },
};
