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
// Idempotency is per entity type and resumable: each type continues after
// the highest entity_id already written for the date (one-row PK MAX probe)
// and is written in bounded keyset chunks (lib/snapshots.ts). The 00:28 run
// does the work; the 12:28 run costs one boundary read per complete type
// and finishes any type an earlier run left half-written.
//
// Orphaned-run fix (2026-11-07): from 2026-11-04 every 00:28 run (and the
// 12:28 run on 11-05 / 11-07) stayed 'running' forever with no
// completed_at and no snapshots_generated event — while its snapshot rows
// DID commit (e.g. 11-07 brand: 11,019 rows ≈ the 44K rows written). The
// invocation never ran a line after the single whole-table INSERT … SELECT
// (~1.75M rows read), and nothing closes a 'running' row: the navigator
// reaper matched only 'partial' and Flight Control's recovery only walks
// registered AgentModules. Now: (1) the work is chunked and each chunk
// heartbeats records_processed, so progress is durable and visible;
// (2) a wall-clock budget stops starting new chunks well inside the cron
// invocation's limit, leaving the rest to the 12:28 resume; (3) finalize
// runs in a `finally`, with retries; (4) lib/agent-runs-reaper.ts now also
// reaps stuck 'running' rows.
//
// Still orphaned after that (2026-11-08 → 11-10, 6 of 6 runs): the AE meter
// shows the invocation RETURNED (cron:28 0,12 rows recorded at settle — 26
// queries on 11-10), yet the run row kept its chunk-5 heartbeat (5,000 while
// 6,000 rows had committed) and no snapshots_generated event landed. The
// heavy chunks spent D1's 10-second resource window, and every write after
// them — heartbeat, the 3 finalize attempts 250 ms / 1 s apart, the event —
// was rejected inside that same window ("D1 DB is overloaded"). Now: chunk
// statements retry overload errors past the window, chunks are smaller with
// a pause between them, and finalize + the event back off 3 s / 6 s / 12 s.

import { createAgentRun, finalizeAgentRun, updateAgentRunProgress } from "../db/agent-runs";
import { D1_OVERLOAD_RETRY_BASE_MS, withD1Retry } from "../lib/d1-retry";
import { logger } from "../lib/logger";
import {
  generateSnapshotType,
  type SnapshotEntityType,
} from "../lib/snapshots";
import type { Env } from "../types";

export const DAILY_SNAPSHOTS_AGENT_ID = "daily_snapshots";
export const DAILY_SNAPSHOTS_CRON = "28 0,12 * * *";

/**
 * Wall-clock budget for starting new chunks, measured from handler start.
 * Well inside the scheduled invocation's limit so the finalize + event
 * writes always have room; a type cut short resumes on the next pass.
 */
export const DAILY_SNAPSHOTS_BUDGET_MS = 8 * 60_000;

/**
 * Entities per chunk on the cron path (the manual endpoint keeps
 * SNAPSHOT_CHUNK_SIZE = 1000). A 1000-provider chunk read ~300K rows in one
 * statement (prod 2026-11-10: 6 chunks, 1.9M rows) — enough on its own to
 * spend D1's 10-second window. 250 keeps each statement ~4× lighter.
 */
export const DAILY_SNAPSHOTS_CHUNK_SIZE = 250;

/** Pause between chunks so consecutive statements don't share one 10 s window. */
export const DAILY_SNAPSHOTS_INTER_CHUNK_PAUSE_MS = 500;

/**
 * Finalize backoff: 3 attempts after the first, waiting past D1's 10-second
 * overload window (3 s + 6 s + 12 s). The old [250, 1000] retried inside the
 * window that had just rejected the first attempt.
 */
export const DAILY_SNAPSHOTS_FINALIZE_BACKOFF_MS: readonly number[] = [3_000, 6_000, 12_000];

/**
 * Overload retries for each chunk statement and the event write (withD1Retry
 * with D1_OVERLOAD_RETRY_BASE_MS: 3 s, 6 s, 12 s + ≤ 0.75 s jitter each). 3,
 * matching finalize: with 2 the waits total ~9 s, so the last retry can land
 * inside the same 10-second overload window. Budget: no chunk STARTS after
 * DAILY_SNAPSHOTS_BUDGET_MS (8 min); a chunk started just before it can wait
 * ≤ ~23 s, then finalize ≤ ~21 s and the event ≤ ~23 s — ~9.2 min worst
 * case, well inside the 15-minute scheduled invocation.
 */
export const DAILY_SNAPSHOTS_WRITE_RETRIES = 3;

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
  /** Budget ran out before the last chunk; the next pass resumes. */
  | { action: "incomplete"; rows: number }
  /** `rows` = chunks committed before the failing statement. */
  | { action: "failed"; rows: number; error: string };

export interface DailySnapshotsRunResult {
  date: string;
  status: "success" | "partial" | "failed";
  provider: SnapshotTypeOutcome;
  brand: SnapshotTypeOutcome;
  recordsProcessed: number;
}

export interface DailySnapshotsOptions {
  /** Override DAILY_SNAPSHOTS_BUDGET_MS (tests). */
  budgetMs?: number;
  /** Override the chunk size (tests). */
  chunkSize?: number;
  /** Clock (tests). */
  now?: () => number;
  /** Finalize retry backoff (tests). */
  finalizeBackoffMs?: readonly number[];
  /** Pause between chunks (tests). */
  interChunkPauseMs?: number;
  /** Overload retry base for chunk statements + the event write (tests). */
  overloadBaseMs?: number;
  /** Sleep used between chunks (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Generate any missing snapshot rows for the UTC date of `scheduledTime`.
 * Never throws: per-type failures are recorded on the run row
 * (`error_message`) and returned; run bookkeeping is best-effort so a D1
 * hiccup on agent_runs cannot stop the snapshot work, and the finalize
 * sits in a `finally` so every path that reaches it closes the run.
 */
export async function runDailySnapshotsCron(
  env: Env,
  scheduledTime: Date,
  trigger = "cron",
  opts: DailySnapshotsOptions = {},
): Promise<DailySnapshotsRunResult> {
  const date = scheduledTime.toISOString().slice(0, 10);
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? DAILY_SNAPSHOTS_BUDGET_MS);

  let runId: string | null = null;
  try {
    runId = await createAgentRun(env, DAILY_SNAPSHOTS_AGENT_ID);
  } catch (err) {
    logger.error("daily_snapshots_run_start_error", { error: errMsg(err) });
  }

  const outcomes: Record<SnapshotEntityType, SnapshotTypeOutcome> = {
    provider: { action: "failed", rows: 0, error: "not attempted" },
    brand: { action: "failed", rows: 0, error: "not attempted" },
  };
  let status: DailySnapshotsRunResult["status"] = "failed";
  let recordsProcessed = 0;

  try {
    const written: Record<SnapshotEntityType, number> = { provider: 0, brand: 0 };
    const heartbeat = async (): Promise<void> => {
      if (!runId) return;
      try {
        await updateAgentRunProgress(env, runId, written.provider + written.brand);
      } catch (err) {
        logger.warn("daily_snapshots_heartbeat_error", { error: errMsg(err) });
      }
    };

    for (const type of SNAPSHOT_TYPES) {
      try {
        const r = await generateSnapshotType(env.DB, date, type, {
          resume: true,
          deadline,
          now,
          chunkSize: opts.chunkSize ?? DAILY_SNAPSHOTS_CHUNK_SIZE,
          interChunkPauseMs: opts.interChunkPauseMs ?? DAILY_SNAPSHOTS_INTER_CHUNK_PAUSE_MS,
          sleep: opts.sleep,
          retry: {
            label: `daily_snapshots ${type} chunk`,
            overloadBaseMs: opts.overloadBaseMs ?? D1_OVERLOAD_RETRY_BASE_MS,
            retries: DAILY_SNAPSHOTS_WRITE_RETRIES,
          },
          onChunk: async (rowsSoFar) => {
            written[type] = rowsSoFar;
            await heartbeat();
          },
        });
        outcomes[type] = !r.complete
          ? { action: "incomplete", rows: r.rows }
          : r.action === "skipped"
            ? { action: "skipped", rows: 0 }
            : { action: "generated", rows: r.rows };
      } catch (err) {
        const message = errMsg(err);
        outcomes[type] = { action: "failed", rows: written[type], error: message };
        logger.error("daily_snapshots_type_error", { date, entity_type: type, error: message });
      }
    }
  } catch (err) {
    // Unexpected throw outside the per-type guards: the outcomes already
    // recorded stand, the rest stay 'failed: not attempted'.
    logger.error("daily_snapshots_unexpected_error", { date, error: errMsg(err) });
  } finally {
    const notOk = SNAPSHOT_TYPES.filter(
      (t) => outcomes[t].action === "failed" || outcomes[t].action === "incomplete",
    );
    const allFailed = SNAPSHOT_TYPES.every((t) => outcomes[t].action === "failed");
    recordsProcessed = SNAPSHOT_TYPES.reduce((n, t) => n + outcomes[t].rows, 0);
    status = notOk.length === 0 ? "success" : allFailed ? "failed" : "partial";
    const errorMessage =
      notOk.length === 0
        ? null
        : notOk
            .map((t) => {
              const o = outcomes[t];
              return o.action === "failed"
                ? `${t}: ${o.error}`
                : `${t}: budget exhausted after ${o.rows} rows — resumes next pass`;
            })
            .join("; ");

    if (runId) {
      const fin = await finalizeAgentRun(
        env,
        runId,
        status === "failed"
          ? { kind: "failed", error_message: errorMessage ?? "all snapshot types failed" }
          : {
              kind: "complete",
              stats: {
                records_processed: recordsProcessed,
                outputs_generated: SNAPSHOT_TYPES.filter((t) => outcomes[t].action === "generated").length,
                status,
                error_message: errorMessage,
              },
            },
        {
          backoffMs: opts.finalizeBackoffMs ?? DAILY_SNAPSHOTS_FINALIZE_BACKOFF_MS,
          attempts: (opts.finalizeBackoffMs ?? DAILY_SNAPSHOTS_FINALIZE_BACKOFF_MS).length + 1,
        },
      );
      if (!fin.ok) {
        logger.error("daily_snapshots_run_complete_error", { run_id: runId, error: fin.error });
      }
    }

    // Telemetry-only completion event: target_agent = NULL, so the
    // orchestrator's agent_events consumer records it without dispatching.
    // One id for every attempt + OR IGNORE, so a retry after an ambiguous
    // failure can never write the event twice.
    const eventId = crypto.randomUUID();
    const payload = JSON.stringify({ date, trigger, status, provider: outcomes.provider, brand: outcomes.brand });
    try {
      await withD1Retry(
        () =>
          env.DB.prepare(
            `INSERT OR IGNORE INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority, status)
             VALUES (?, 'snapshots_generated', ?, NULL, ?, 3, 'pending')`,
          )
            .bind(eventId, DAILY_SNAPSHOTS_AGENT_ID, payload)
            .run(),
        {
          label: "daily_snapshots event",
          retries: DAILY_SNAPSHOTS_WRITE_RETRIES,
          overloadBaseMs: opts.overloadBaseMs ?? D1_OVERLOAD_RETRY_BASE_MS,
        },
      );
    } catch (err) {
      logger.error("daily_snapshots_event_write_error", { error: errMsg(err) });
    }
  }

  return {
    date,
    status,
    provider: outcomes.provider,
    brand: outcomes.brand,
    recordsProcessed,
  };
}
