// Daily snapshots — dedicated-cron dispatch (`28 0,12 * * *`).
//
// Handler-dispatched writer (agent_id 'daily_snapshots'), same pattern as
// the daily briefing (`handlers/briefing.ts` `withBriefingRun`): it is NOT
// a registered AgentModule — no entry in agents/*.ts, so it does not appear
// in the architect manifest or the resource-drift gate — but it honours the
// agent-run contract (CLAUDE.md §6): an `agent_runs` row at start, completed
// with `completed_at` + `records_processed` (or `error_message`), then a
// telemetry `agent_events` row (`snapshots_generated`, target_agent NULL).
//
// Why a dedicated cron: generation used to sit at the tail of the hourly
// orchestrator (hour 0, or any hour with no row today), which is routinely starved
// before reaching it (same failure class as PR-E/F/Q/T and the briefing).
// Prod was missing provider snapshots on 11 of ~23 days — some days had no
// rows at all, and 2026-10-12 had 10,137 brand rows / 0 provider rows
// because the "any row today" fallback could not see a missing TYPE.
//
// Idempotency is per entity type: each type is probed with a PK-prefix
// `SELECT 1 … LIMIT 1` and generated only if absent. The 00:28 run does the
// work; the 12:28 run costs two one-row probes unless a type is missing, in
// which case it repairs only that type. Existing types are never rebuilt.

import { createAgentRun, completeAgentRun, failAgentRun } from "../db/agent-runs";
import { logger } from "../lib/logger";
import {
  generateSnapshotType,
  type SnapshotEntityType,
} from "../lib/snapshots";
import type { Env } from "../types";

export const DAILY_SNAPSHOTS_AGENT_ID = "daily_snapshots";
export const DAILY_SNAPSHOTS_CRON = "28 0,12 * * *";

/**
 * Provider first: it is the type with a live consumer (Flight Control's
 * provider-escalation watcher) and the heavier statement, so it gets the
 * freshest budget. The two types are isolated — one failing never stops
 * the other.
 */
const SNAPSHOT_TYPES: readonly SnapshotEntityType[] = ["provider", "brand"];

export type SnapshotTypeOutcome =
  | { action: "generated"; rows: number }
  | { action: "skipped"; rows: 0 }
  | { action: "failed"; rows: 0; error: string };

export interface DailySnapshotsRunResult {
  date: string;
  status: "success" | "partial" | "failed";
  provider: SnapshotTypeOutcome;
  brand: SnapshotTypeOutcome;
  recordsProcessed: number;
}

/**
 * Generate any missing snapshot types for the UTC date of `scheduledTime`.
 * Never throws: per-type failures are recorded on the run row
 * (`error_message`) and returned; run bookkeeping is best-effort so a D1
 * hiccup on agent_runs cannot stop the snapshot work.
 */
export async function runDailySnapshotsCron(
  env: Env,
  scheduledTime: Date,
  trigger = "cron",
): Promise<DailySnapshotsRunResult> {
  const date = scheduledTime.toISOString().slice(0, 10);

  let runId: string | null = null;
  try {
    runId = await createAgentRun(env, DAILY_SNAPSHOTS_AGENT_ID);
  } catch (err) {
    logger.error("daily_snapshots_run_start_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const outcomes = {} as Record<SnapshotEntityType, SnapshotTypeOutcome>;
  for (const type of SNAPSHOT_TYPES) {
    try {
      const r = await generateSnapshotType(env.DB, date, type, { skipExisting: true });
      outcomes[type] = r.action === "skipped" ? { action: "skipped", rows: 0 } : { action: "generated", rows: r.rows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes[type] = { action: "failed", rows: 0, error: message };
      logger.error("daily_snapshots_type_error", { date, entity_type: type, error: message });
    }
  }

  const failures = SNAPSHOT_TYPES.filter((t) => outcomes[t].action === "failed");
  const recordsProcessed = SNAPSHOT_TYPES.reduce((n, t) => n + outcomes[t].rows, 0);
  const status: DailySnapshotsRunResult["status"] =
    failures.length === 0
      ? "success"
      : failures.length === SNAPSHOT_TYPES.length
        ? "failed"
        : "partial";
  const errorMessage =
    failures.length === 0
      ? null
      : failures
          .map((t) => {
            const o = outcomes[t];
            return `${t}: ${o.action === "failed" ? o.error : ""}`;
          })
          .join("; ");

  if (runId) {
    try {
      if (status === "failed") {
        await failAgentRun(env, runId, errorMessage ?? "all snapshot types failed");
      } else {
        await completeAgentRun(env, runId, {
          records_processed: recordsProcessed,
          outputs_generated: SNAPSHOT_TYPES.filter((t) => outcomes[t].action === "generated").length,
          status,
          error_message: errorMessage,
        });
      }
    } catch (err) {
      logger.error("daily_snapshots_run_complete_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Telemetry-only completion event: target_agent = NULL, so the
  // orchestrator's agent_events consumer records it without dispatching.
  try {
    await env.DB.prepare(
      `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
       VALUES (?, 'snapshots_generated', ?, NULL, ?, 3, 'pending')`,
    )
      .bind(
        crypto.randomUUID(),
        DAILY_SNAPSHOTS_AGENT_ID,
        JSON.stringify({ date, trigger, status, provider: outcomes.provider, brand: outcomes.brand }),
      )
      .run();
  } catch (err) {
    logger.error("daily_snapshots_event_write_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    date,
    status,
    provider: outcomes.provider,
    brand: outcomes.brand,
    recordsProcessed,
  };
}
