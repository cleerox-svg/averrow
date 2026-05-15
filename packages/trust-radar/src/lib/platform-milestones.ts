// Platform milestones — celebrate two parallel ingest signals.
//
// We track two complementary metrics:
//
//   1. threats_ingested  — `COUNT(*) FROM threats`. Active threats
//                          currently in the threats table. May dip
//                          when rows are resolved or dropped.
//   2. total_ingested    — `SUM(records_ingested) FROM feed_pull_history`.
//                          Lifetime ingest volume from feed pulls.
//                          Only goes up. Same number the /feeds page
//                          surfaces as "TOTAL INGESTED".
//
// Both metrics fire against the same MILESTONE_VALUES list. The
// platform_milestones PK is composite (metric, value), so each metric
// can cross 400K / 1M / 10M independently. The Home banner reads the
// most-recent row across either metric and labels accordingly.
//
// Navigator calls both checks at the end of every 5-min tick. Cheap:
// each is a single aggregate query + one SELECT on the milestone
// table + ≤ 1 INSERT per crossing. Idempotent under composite PK.

import type { Env } from '../types';
import { cachedCount } from './cached-count';

const MILESTONE_VALUES = [
  100_000,
  200_000,
  250_000,
  300_000,
  350_000,
  400_000,
  450_000,
  500_000,
  750_000,
  1_000_000,
  1_500_000,
  2_000_000,
  3_000_000,
  5_000_000,
  7_500_000,
  10_000_000,
  25_000_000,
  50_000_000,
  100_000_000,
] as const;

export type MilestoneMetric = "threats_ingested" | "total_ingested";

export interface MilestoneRow {
  value: number;
  metric: string;
  fired_at: string;
  agent_run_id: string | null;
  notes: string | null;
}

export interface MilestoneCheckResult {
  metric: MilestoneMetric;
  current: number;
  fired: number[];
}

async function fireCrossings(
  db: D1Database,
  metric: MilestoneMetric,
  current: number,
  agentRunId: string | null | undefined,
): Promise<number[]> {
  // Pull every fired value for THIS metric so the diff stays
  // metric-scoped — composite PK means 400K under threats_ingested
  // doesn't suppress 400K under total_ingested.
  const firedRows = await db
    .prepare(
      `SELECT value FROM platform_milestones WHERE metric = ?`,
    )
    .bind(metric)
    .all<{ value: number }>();
  const alreadyFired = new Set((firedRows.results ?? []).map((r) => r.value));

  const fired: number[] = [];
  for (const milestone of MILESTONE_VALUES) {
    if (current >= milestone && !alreadyFired.has(milestone)) {
      try {
        await db
          .prepare(
            `INSERT OR IGNORE INTO platform_milestones
                (metric, value, fired_at, agent_run_id)
             VALUES (?, ?, datetime('now'), ?)`,
          )
          .bind(metric, milestone, agentRunId ?? null)
          .run();
        fired.push(milestone);
      } catch (err) {
        // Non-fatal: re-attempt next tick.
        console.error(`[platform-milestones] insert failed for ${metric}=${milestone}:`, err);
      }
    }
  }
  return fired;
}

/**
 * threats_ingested — `COUNT(*) FROM threats` against MILESTONE_VALUES.
 *
 * Called from Navigator on every 5-min tick (288x/day). Pre-PR-I this
 * was a bare `SELECT COUNT(*) FROM threats` that scanned the full table
 * each call — diag 2026-05-14 attributed ~87M rows-read across 306
 * calls (avg 285K rows/call). Now routed through cachedCount with a
 * 4-min TTL, so the 5-min cron hits cache ~4× out of 5. Milestone
 * thresholds advance slowly (next is 500K, current 299K), so 4-min
 * staleness is well within tolerance.
 */
export async function checkAndFireThreatMilestones(
  env: Env,
  agentRunId?: string | null,
): Promise<MilestoneCheckResult> {
  const current = await cachedCount(env, 'count.threats.total', 240, async () => {
    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM threats`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  });
  const fired = await fireCrossings(env.DB, "threats_ingested", current, agentRunId);
  return { metric: "threats_ingested", current, fired };
}

/**
 * total_ingested — `SUM(records_ingested) FROM feed_pull_history`
 * against MILESTONE_VALUES. Same number the /feeds page surfaces.
 *
 * Same Navigator dispatch pattern as checkAndFireThreatMilestones —
 * cached for 4 min so the 5-min cron mostly hits.
 */
export async function checkAndFireIngestionMilestones(
  env: Env,
  agentRunId?: string | null,
): Promise<MilestoneCheckResult> {
  const current = await cachedCount(env, 'count.feed_pulls.total_ingested', 240, async () => {
    const row = await env.DB
      .prepare(`SELECT COALESCE(SUM(records_ingested), 0) AS n FROM feed_pull_history`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  });
  const fired = await fireCrossings(env.DB, "total_ingested", current, agentRunId);
  return { metric: "total_ingested", current, fired };
}

/**
 * Most-recent fired milestone across ALL metrics. Drives the Home
 * banner — operators see the freshest celebration regardless of which
 * metric crossed.
 */
export async function getLatestMilestone(
  db: D1Database,
): Promise<MilestoneRow | null> {
  return await db
    .prepare(
      `SELECT value, metric, fired_at, agent_run_id, notes
         FROM platform_milestones
        ORDER BY fired_at DESC
        LIMIT 1`,
    )
    .first<MilestoneRow>();
}

/** For diagnostics. */
export function listMilestoneTargets(): readonly number[] {
  return MILESTONE_VALUES;
}
