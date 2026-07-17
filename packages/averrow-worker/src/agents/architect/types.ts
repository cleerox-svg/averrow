/**
 * ARCHITECT meta-agent — shared types for context collectors.
 *
 * These types describe the ContextBundle that Phase 1 collectors build.
 * Later phases (Haiku inventory pass, Sonnet synthesis, report rollup)
 * consume the same bundle shape, so keep it stable.
 */

export type RunType = "weekly" | "ondemand" | "deep";
export type RunStatus = "collecting" | "analyzing" | "complete" | "failed";

export interface AgentFile {
  name: string;
  path: string;
  entrypoint: string | null;
  triggers: string[]; // e.g. ['cron','queue','http']
  reads: string[]; // table/binding names referenced
  writes: string[];
  ai_models_referenced: string[];
  loc: number;
  last_modified: string; // ISO
}

export interface FeedFile {
  name: string;
  path: string;
  source_type: string; // 'http','rss','api','stream'
  schedule: string | null;
  loc: number;
  last_modified: string;
}

export interface CronHandler {
  pattern: string;
  handler_path: string;
  agents_invoked: string[];
}

export interface WorkerEntry {
  name: string;
  path: string;
  bindings: string[];
}

export interface RepoInventory {
  collected_at: string;
  agents: AgentFile[];
  feeds: FeedFile[];
  crons: CronHandler[];
  workers: WorkerEntry[];
  totals: {
    agents: number;
    feeds: number;
    crons: number;
    workers: number;
  };
}

export interface TableInventory {
  name: string;
  rows: number;
  /**
   * Estimated bytes-on-disk for the table, derived by sampling row size
   * and extrapolating by row count. `null` means sampling was attempted
   * and failed (timeout, permission error, empty schema) — consumers
   * should treat this as "unknown" and distinguish it from `0`, which
   * means the table really is empty.
   */
  est_bytes: number | null;
  has_indexes: boolean;
  index_count: number;
  growth_7d_rows: number | null;
  growth_7d_pct: number | null;
}

export interface DataLayerInventory {
  collected_at: string;
  tables: TableInventory[];
  totals: {
    table_count: number;
    total_rows: number;
    /** Sum of known `est_bytes` values. Tables with `null` are excluded. */
    total_est_bytes: number;
  };
}

/**
 * Runtime liveness row for one feed. Joins `feed_configs` (the
 * runtime source of truth for per-feed schedule + enabled flag) with
 * `feed_status` and recent rollups from `feed_pull_history`.
 *
 * This is the signal the Phase 2 feeds analyzer uses to decide if a
 * feed is alive. `repo.feeds[].schedule` is always `null` because the
 * TypeScript `FeedModule` interface does not declare a schedule —
 * schedules live in the `feed_configs` D1 table so they can be
 * hot-edited without a deploy. Do not use `repo.feeds[].schedule` as
 * a liveness signal; use this row instead.
 */
export interface FeedRuntimeRow {
  feed_name: string;
  /** `1` = enabled in `feed_configs`, `0` = disabled. */
  enabled: number;
  /** Cron pattern from `feed_configs.schedule_cron`. */
  schedule_cron: string | null;
  /** Most recent successful pull timestamp from `feed_status`. */
  last_successful_pull: string | null;
  /**
   * Most recent pull attempt (success or failure) from
   * `feed_pull_history`. Null when the feed has never been attempted.
   */
  last_attempted_pull: string | null;
  /** Last error message on `feed_status`, if any. */
  last_error: string | null;
  /**
   * Consecutive failed pulls since the last success, computed from
   * `feed_pull_history`. `0` means the most recent pull succeeded (or
   * there are no pulls yet).
   */
  consecutive_failures: number;
  /** Total pull attempts in the last 7 days. */
  pulls_7d: number;
  /** Successful pulls in the last 7 days. */
  successes_7d: number;
}

export interface AgentTelemetry {
  agent_name: string;
  runs_7d: number;
  successes_7d: number;
  failures_7d: number;
  avg_duration_ms: number | null;
  ai_cost_usd_7d: number;
  last_run_at: string | null;
  last_error: string | null;
}

export interface CronTelemetry {
  pattern: string;
  runs_7d: number;
  failures_7d: number;
  last_status: "success" | "failure" | "unknown";
}

export interface OpsTelemetry {
  collected_at: string;
  window_days: number;
  agents: AgentTelemetry[];
  crons: CronTelemetry[];
  queues_depth: Record<string, number>;
  ai_gateway: {
    total_cost_usd_7d: number;
    cache_hit_rate: number | null;
    model_mix: Record<string, number>;
  };
  /**
   * Human-readable gaps in the telemetry pipeline — e.g. "budget_ledger
   * is empty because AI Gateway cost ingestion isn't wired yet". When
   * populated these tell ARCHITECT that a zero-valued field means
   * "missing signal", not "nothing to report". Empty array = healthy.
   */
  telemetry_warnings: string[];
}

export interface ContextBundle {
  /**
   * Bundle schema version.
   *
   * - `1` — original shape (no `feed_runtime`).
   * - `2` — added top-level `feed_runtime` array sourced from the
   *   data-layer collector, so the feeds analyzer can see runtime
   *   dispatch state that the repo walker cannot (schedules live in
   *   the `feed_configs` D1 table, not in source). Phase 2 analyzers
   *   must tolerate v1 bundles by defaulting `feed_runtime` to an
   *   empty array.
   */
  bundle_version: 1 | 2;
  run_id: string;
  generated_at: string;
  repo: RepoInventory;
  data_layer: DataLayerInventory;
  ops: OpsTelemetry;
  /**
   * Present on v2 bundles. Omitted on v1 bundles — consumers must
   * treat missing / undefined as an empty array.
   */
  feed_runtime?: FeedRuntimeRow[];
}
