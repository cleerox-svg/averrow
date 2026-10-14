/**
 * Cube Healer Agent — Phase 4.2 retroactive drift remediation.
 *
 * Runs 6-hourly via the "12 *\/6 * * *" cron. Performs a bulk rebuild of
 * threat_cube_geo, threat_cube_provider, threat_cube_brand,
 * threat_cube_status, and threat_cube_arcs over an hour-snapped window.
 * Per cube and per DAY of the window, one atomic db.batch() of [stale-row
 * sweep, guarded upsert] (healCube / healDayChunks): a D1 limit on one day
 * rolls back that day only, and the other days still commit. The sweep
 * (cubeStaleSweepSQL, lib/cube-builder.ts) deletes window rows whose key
 * vanished from the source (threats went inactive or moved group); the
 * upsert rewrites only the groups whose aggregate changed.
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
 *   A cube with a few failed days still finishes 'success' with a
 *   diagnostic agent_output row (severity='high'). When MORE THAN HALF of
 *   any cube's days fail, the run returns AgentResult.degraded →
 *   executeAgent finalizes agent_runs.status='partial' (completed_at set),
 *   so a mostly-stale cube never reads as a healthy run.
 *
 * Observatory Phase B additions (no new cron — all inside this agent):
 *   - threat_cube_velocity (B3, migration 0300) healed with the other
 *     cubes; its cold window is 90 days (VELOCITY_COLD_HEAL_WINDOW_DAYS),
 *     read through a partial covering index.
 *   - incremental velocity stamping: one ≤500-row page per run
 *     (lib/velocity-writer.ts runVelocityStampPage) before the heals.
 *   - takedown_outcome_daily (B2, migration 0299): rebuilt on the cold
 *     (UTC hour 0) tick only — hour-only gate, per the cron-audit rule.
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
 * Velocity cube cold window (B3). Wider than the other cubes' 14 days because
 * the flag is stamped AFTER ingest (incremental page below, plus the admin
 * backfill), so old hours keep changing, and /velocity-nodes serves up to
 * 90d. Affordable because the heal reads only the flagged rows through the
 * partial covering index idx_threats_velocity_fast_created (0300).
 */
export const VELOCITY_COLD_HEAL_WINDOW_DAYS = 90;

/** A cube with more than this fraction of its day chunks failed finishes
 *  the run degraded ('partial'), not 'success'. */
export const DEGRADED_FAILED_DAY_FRACTION = 0.5;

/** Pure: the cubes whose failed-day fraction exceeds the degraded threshold. */
export function degradedCubes(results: ReadonlyArray<{ table: CubeName; failed: number; chunks: number }>): CubeName[] {
  return results
    .filter((r) => r.chunks > 0 && r.failed / r.chunks > DEGRADED_FAILED_DAY_FRACTION)
    .map((r) => r.table);
}

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
    case 'velocity':
      // Observatory Phase B (B3, migration 0300). The predicate text matches
      // idx_threats_velocity_fast_created's partial WHERE so the read is a
      // covering-index range over the window's FLAGGED rows only.
      return `
        INSERT INTO threat_cube_velocity
          (hour_bucket, country_code, flag, threat_count, updated_at)
        SELECT
          strftime('%Y-%m-%d %H:00:00', created_at),
          COALESCE(country_code, 'XX'),
          weaponization_flag,
          COUNT(*),
          datetime('now')
        FROM threats
        WHERE created_at >= ?1
          AND created_at < ?2
          AND status = 'active'
          AND weaponization_flag IN ('very_fast', 'fast')
        GROUP BY 1, 2, 3
        ON CONFLICT(hour_bucket, country_code, flag)
        DO UPDATE SET
          threat_count = excluded.threat_count,
          updated_at = excluded.updated_at
        WHERE threat_cube_velocity.threat_count IS NOT excluded.threat_count
      `;
  }
}

// Exported for unit testing.
export function healSQLForTest(table: CubeName): string {
  return healSQL(table);
}

/**
 * Split an hour-snapped heal window into day-sized [start, end) chunks,
 * oldest first. Every chunk boundary stays hour-snapped (the window start
 * is, and each chunk is exactly 24h); the last chunk is shorter when the
 * window is not a whole number of days. Exported for unit testing.
 */
export function healDayChunks(window: { start: string; end: string }): Array<{ start: string; end: string }> {
  const toMs = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');
  const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const startMs = toMs(window.start);
  const endMs = toMs(window.end);
  const chunks: Array<{ start: string; end: string }> = [];
  for (let ms = startMs; ms < endMs; ms += DAY_MS) {
    chunks.push({ start: fmt(ms), end: fmt(Math.min(ms + DAY_MS, endMs)) });
  }
  return chunks;
}

export interface HealChunkFailure {
  start: string;
  end: string;
  error: string;
}

export interface HealCubeResult {
  rowsWritten: number;
  /** Day chunks attempted. */
  chunks: number;
  /** Day chunks whose batch failed (rolled back); the others committed. */
  failures: HealChunkFailure[];
}

/**
 * Heal one cube over [start, end), one DAY at a time. Each day is its own
 * atomic batch of [stale-row sweep, guarded upsert] bound to that day, so a
 * D1 statement/duration limit on a large window rolls back one day, not the
 * whole 14-day heal (the former single-batch shape lost every upsert when
 * the sweep or upsert over 14 days hit a limit). A failed day is recorded
 * and the remaining days still run. Never throws. Exported for unit testing.
 */
export async function healCube(
  db: D1Database,
  table: CubeName,
  window: { start: string; end: string },
): Promise<HealCubeResult> {
  const chunks = healDayChunks(window);
  const result: HealCubeResult = { rowsWritten: 0, chunks: chunks.length, failures: [] };
  for (const chunk of chunks) {
    try {
      const results = await db.batch([
        db.prepare(cubeStaleSweepSQL(table)).bind(chunk.start, chunk.end),
        db.prepare(healSQL(table)).bind(chunk.start, chunk.end),
      ]);
      result.rowsWritten += results.reduce((sum, r) => sum + (r?.meta?.changes ?? 0), 0);
    } catch (err) {
      result.failures.push({ ...chunk, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Diagnostic for a cube heal that lost one or more day chunks. */
export function healFailureOutput(table: CubeName, r: HealCubeResult, rowsLanded: number): AgentOutputEntry {
  return {
    type: 'diagnostic',
    summary: `cube_healer ${table} heal failed for ${r.failures.length}/${r.chunks} day(s) (${rowsLanded} rows so far)`,
    severity: 'high',
    details: {
      error: r.failures[0]?.error ?? null,
      stage: table,
      rowsLanded,
      failedDays: r.failures,
      daysAttempted: r.chunks,
    },
  };
}

// ─── Agent module ────────────────────────────────────────────────

export const cubeHealerAgent: AgentModule = {
  name: 'cube_healer',
  displayName: 'Cube Healer',
  description: 'OLAP cube maintenance — 6-hourly 2-day heal (14-day once a day; velocity 90-day) + velocity stamping + daily takedown outcome rollup + brand summaries',
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
    { kind: 'd1_table', name: 'threat_cube_velocity' },
    { kind: 'd1_table', name: 'agent_events' },
    // Also writes threats.weaponization_* (lib/velocity-writer.ts) and
    // takedown_outcome_daily (lib/takedown-outcome-rollup.ts) — not declared
    // for the same reason as below. Also writes brands.threat_count via lib/brand-count-reconciler.ts —
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
    const velocityWindow = scope === 'cold'
      ? healWindow(new Date(), VELOCITY_COLD_HEAL_WINDOW_DAYS)
      : window;

    // ── Velocity stamping (B3) ──────────────────────────────────
    // One bounded incremental page (≤500 rows, KV keyset cursor over the
    // partial index idx_threats_velocity_unstamped) BEFORE the cube heals,
    // so the velocity heal below already counts what this page stamped.
    // Every run (no time gate). Metadata only — never gates triage.
    let velocityStamp: { scanned: number; written: number; cursorReset: boolean } | null = null;
    try {
      const { runVelocityStampPage } = await import('../lib/velocity-writer');
      const r = await runVelocityStampPage(env);
      velocityStamp = { scanned: r.scanned, written: r.written, cursorReset: r.cursor_to === '' };
      rowsWritten += r.written;
    } catch (err) {
      partialFailures.push({
        type: 'diagnostic',
        summary: 'cube_healer velocity stamping page failed',
        severity: 'medium',
        details: { error: err instanceof Error ? err.message : String(err), stage: 'velocity_stamp', rowsLanded: rowsWritten },
      });
    }

    // ── Cube heals (geo, provider, brand, status, arcs, velocity) ─
    // Each cube heals day by day (healCube). A failed day becomes a
    // partial-failure diagnostic and the remaining days and cubes still
    // run. Geo keeps its legacy "catastrophic" contract: when EVERY geo day
    // fails, throw up to executeAgent() (→ status='failed'). When MORE THAN
    // HALF of any cube's days fail, the run finishes degraded (→
    // status='partial', AgentResult.degraded) instead of 'success' — that
    // cube is mostly stale and the run must not read as healthy. Status is
    // the only path that reconciles status mutations (active → down →
    // remediated) for older hour buckets; arcs feeds the Observatory globe;
    // velocity uses its own (90-day on cold) window.
    const healOutcomes: Array<{ table: CubeName; failed: number; chunks: number }> = [];
    for (const table of ['geo', 'provider', 'brand', 'status', 'arcs', 'velocity'] as const) {
      const r = await healCube(env.DB, table, table === 'velocity' ? velocityWindow : window);
      rowsWritten += r.rowsWritten;
      healOutcomes.push({ table, failed: r.failures.length, chunks: r.chunks });
      if (r.failures.length === 0) continue;
      if (table === 'geo' && r.failures.length === r.chunks) {
        throw new Error(`cube_healer geo heal failed for every day: ${r.failures[0]?.error ?? "unknown error"}`);
      }
      partialFailures.push(healFailureOutput(table, r, rowsWritten));
    }
    const mostlyFailed = degradedCubes(healOutcomes);

    // ── Takedown outcome rollup (B2) ────────────────────────────
    // Once per UTC day, on the cold (hour-0, 00:12) tick only. HOUR-only gate
    // via pickHealScope — never a minute check (CLAUDE.md §6 cron-audit rule).
    let takedownRollup: { sourceRows: number; cells: number; rowsWritten: number; staleDeleted: number } | null = null;
    if (scope === 'cold') {
      try {
        const { runTakedownOutcomeRollup } = await import('../lib/takedown-outcome-rollup');
        const r = await runTakedownOutcomeRollup(env);
        takedownRollup = { sourceRows: r.sourceRows, cells: r.cells, rowsWritten: r.rowsWritten, staleDeleted: r.staleDeleted };
        rowsWritten += r.rowsWritten;
      } catch (err) {
        partialFailures.push({
          type: 'diagnostic',
          summary: 'cube_healer takedown outcome rollup failed',
          severity: 'high',
          details: { error: err instanceof Error ? err.message : String(err), stage: 'takedown_outcome_rollup', rowsLanded: rowsWritten },
        });
      }
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

    // ── Completion telemetry (agent_events, target_agent NULL) ──
    // CLAUDE.md §6: every agent emits to agent_events after its work.
    // Telemetry only — no dispatch. Best-effort: a failed insert never fails
    // the heal that already committed.
    try {
      await env.DB.prepare(
        `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
         VALUES (?, 'cubes_healed', 'cube_healer', NULL, ?, 3, 'pending')`,
      ).bind(
        crypto.randomUUID(),
        JSON.stringify({
          run_id: ctx.runId ?? null,
          scope,
          rows_written: rowsWritten,
          partial_failures: partialFailures.length,
          degraded_cubes: mostlyFailed,
          velocity_stamped: velocityStamp?.written ?? null,
          takedown_cells: takedownRollup?.cells ?? null,
        }),
      ).run();
    } catch {
      // telemetry only
    }

    return {
      itemsProcessed: rowsWritten,
      itemsCreated: rowsWritten,
      itemsUpdated: 0,
      output: {
        rowsWritten, partialFailureCount: partialFailures.length, scope, windowDays,
        windowStart: window.start, windowEnd: window.end, brandDrift,
        velocityWindowStart: velocityWindow.start, velocityStamp, takedownRollup,
        degradedCubes: mostlyFailed,
      },
      agentOutputs: partialFailures,
      ...(mostlyFailed.length > 0
        ? { degraded: { reason: `cube heal failed for more than half the days of: ${mostlyFailed.join(', ')}` } }
        : {}),
    };
  },
};
