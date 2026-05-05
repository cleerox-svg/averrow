// Platform milestones — celebrate threat-ingestion totals.
//
// The Navigator agent calls checkAndFireThreatMilestones() at the end
// of every 5-min tick. It does one cheap COUNT(*) on the threats
// table, compares it against MILESTONE_VALUES, and INSERT OR IGNOREs
// a row in platform_milestones for any newly-crossed value. The Home
// banner then reads the most recent row and surfaces it prominently
// until the operator dismisses it (per-device localStorage).
//
// Milestone values are deliberately a hardcoded list — these are
// rare events (we'll cross at most 1–2 per quarter on the current
// ingest curve), so the simplicity of "edit the array, ship it"
// outweighs any config-table indirection.

const MILESTONE_VALUES = [
  100_000,
  250_000,
  400_000,
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

const METRIC = "threats_ingested";

export interface MilestoneRow {
  value: number;
  metric: string;
  fired_at: string;
  agent_run_id: string | null;
  notes: string | null;
}

export interface MilestoneCheckResult {
  threats_total: number;
  fired: number[];   // milestone values fired this run (usually 0 or 1)
}

/**
 * Compare the current threat count against MILESTONE_VALUES. INSERT OR
 * IGNORE any newly-crossed milestones. Returns the values fired this
 * call (typically empty; non-empty exactly when the count just crossed
 * one of the thresholds).
 *
 * Idempotent: PK on (value) means the same milestone never fires twice.
 * Cheap: one COUNT, one platform_milestones SELECT, ≤ N inserts where
 * N is the number of crossings since the last run (≤ 1 in steady state).
 */
export async function checkAndFireThreatMilestones(
  db: D1Database,
  agentRunId?: string | null,
): Promise<MilestoneCheckResult> {
  const total = await db
    .prepare(`SELECT COUNT(*) AS n FROM threats`)
    .first<{ n: number }>();
  const threatsTotal = total?.n ?? 0;

  // Pull every fired value once so we can diff in JS. Way cheaper than
  // round-tripping per candidate milestone.
  const firedRows = await db
    .prepare(
      `SELECT value FROM platform_milestones WHERE metric = ?`,
    )
    .bind(METRIC)
    .all<{ value: number }>();
  const alreadyFired = new Set((firedRows.results ?? []).map((r) => r.value));

  const fired: number[] = [];
  for (const milestone of MILESTONE_VALUES) {
    if (threatsTotal >= milestone && !alreadyFired.has(milestone)) {
      try {
        await db
          .prepare(
            `INSERT OR IGNORE INTO platform_milestones
                (value, metric, fired_at, agent_run_id)
             VALUES (?, ?, datetime('now'), ?)`,
          )
          .bind(milestone, METRIC, agentRunId ?? null)
          .run();
        fired.push(milestone);
      } catch (err) {
        // Non-fatal: if a write fails we'll re-attempt next tick. Don't
        // block Navigator's main work on a celebratory side-effect.
        console.error(`[platform-milestones] insert failed for ${milestone}:`, err);
      }
    }
  }

  return { threats_total: threatsTotal, fired };
}

/**
 * Read the most recent fired milestone (by fired_at). Used by the
 * /api/v1/public/milestones/latest endpoint that the Home banner
 * polls for the celebration card.
 */
export async function getLatestThreatMilestone(
  db: D1Database,
): Promise<MilestoneRow | null> {
  return await db
    .prepare(
      `SELECT value, metric, fired_at, agent_run_id, notes
         FROM platform_milestones
        WHERE metric = ?
        ORDER BY fired_at DESC
        LIMIT 1`,
    )
    .bind(METRIC)
    .first<MilestoneRow>();
}

/** For diagnostics / debugging only. Returns the full milestone series. */
export function listMilestoneTargets(): readonly number[] {
  return MILESTONE_VALUES;
}
