/**
 * ARCHITECT — operational telemetry collector.
 *
 * Pulls 7-day agent health, cron health, queue depth, and AI Gateway
 * stats from whatever observability is wired today. When a data source
 * isn't wired yet we return zeros / nulls and mark a TODO — never
 * fabricate values. Later phases of ARCHITECT will expand this as the
 * observability surface grows.
 */

import type { Env } from "../../../types";
import type {
  AgentTelemetry,
  CronTelemetry,
  OpsTelemetry,
} from "../types";
import { applySplit, byDesc, historyParts, unionGrouped, unionRows } from "../../../lib/telemetry-read";

// ─── Query row shapes ─────────────────────────────────────────────

interface AgentAggRow {
  agent_id: string;
  runs: number;
  successes: number;
  failures: number;
  avg_duration_ms: number | null;
  last_run_at: string | null;
  last_error: string | null;
}

interface CostRow {
  agent_id: string;
  total_cost: number;
}

interface ModelCostRow {
  model: string;
  total_cost: number;
}

interface CronStatusRow {
  status: string | null;
  runs: number;
  failures: number;
}

// ─── Public API ───────────────────────────────────────────────────

export async function collectOpsTelemetry(env: Env): Promise<OpsTelemetry> {
  const collectedAt = new Date().toISOString();
  const windowDays = 7;
  const sinceIso = sevenDaysAgoIso();

  const telemetryWarnings: string[] = [];

  // budget_ledger writes are wired through lib/anthropic.ts — every
  // SUCCESSFUL Anthropic call (direct or via lib/haiku.ts) records a row
  // via BudgetManager.recordCost(). A FAILED call writes nothing.
  //
  // So an empty ledger is AMBIGUOUS and has exactly two causes:
  //   (a) BENIGN — call sites short-circuited: budget cost guards, the
  //       per-agent token cap, or simply no eligible work this window.
  //   (b) OUTAGE — calls were made and every one of them failed. This is
  //       what actually happened for ~3 months (last ledger row
  //       2026-07-10 11:10:20 UTC): an unpaid Anthropic balance returned
  //       `HTTP 400 — "Your credit balance is too low to access the
  //       Anthropic API."` on every request, agents fell through to their
  //       rule-based paths, and nothing alerted.
  //
  // This comment and the warning below previously asserted (a) as fact,
  // which made them part of the silence. Do NOT read an empty ledger as
  // benign. Disambiguate with the strictly-API counters:
  //   - `ai_health` in GET /api/internal/platform-diagnostics (per-agent
  //     attempted / succeeded; attempted > 0 && succeeded = 0 = outage,
  //     attempted = 0 = genuinely quiet), and
  //   - the `platform_ai_calls_failing` notification Flight Control
  //     raises on exactly that conjunction.
  const budgetLedgerHasRows = await ledgerHasRows(env);
  if (!budgetLedgerHasRows) {
    telemetryWarnings.push(
      "budget_ledger has no rows in the window — AI cost metrics " +
        "(ai_cost_usd_7d, ai_gateway.total_cost_usd_7d, ai_gateway.model_mix) " +
        "will report zero. Logging is wired (lib/anthropic.ts → " +
        "BudgetManager.recordCost) and only SUCCESSFUL calls write a row, " +
        "so this is ambiguous: either AI call sites short-circuited " +
        "(cost guards / per-agent cap / no eligible work), OR every AI " +
        "call failed and the agents silently fell back to rule-based " +
        "paths. Do not assume the benign reading — an unpaid Anthropic " +
        "balance (HTTP 400) emptied this ledger for ~3 months. " +
        "Disambiguate via the `ai_health` block in " +
        "/api/internal/platform-diagnostics (attempted > 0 with " +
        "succeeded = 0 means outage; attempted = 0 means genuinely " +
        "quiet) and the platform_ai_calls_failing notification.",
    );
  }

  const agents = await collectAgentTelemetry(env, sinceIso);
  const crons = await collectCronTelemetry(env, sinceIso);

  // TODO: wire Cloudflare Queues API once producers/consumers are declared
  // in wrangler.toml — no queues currently bound.
  const queuesDepth: Record<string, number> = {};

  const aiGateway = await collectAiGatewayStats(env, sinceIso);

  return {
    collected_at: collectedAt,
    window_days: windowDays,
    agents,
    crons,
    queues_depth: queuesDepth,
    ai_gateway: aiGateway,
    telemetry_warnings: telemetryWarnings,
  };
}

async function ledgerHasRows(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS present FROM budget_ledger LIMIT 1`,
    ).first<{ present: number }>();
    return row !== null;
  } catch {
    // If the table doesn't exist at all, treat that as "no rows" so
    // ARCHITECT still surfaces the warning rather than crashing.
    return false;
  }
}

// ─── Agent telemetry ──────────────────────────────────────────────

async function collectAgentTelemetry(
  env: Env,
  sinceIso: string,
): Promise<AgentTelemetry[]> {
  // agent_runs uses TEXT datetime('now') format — lexicographic compare
  // matches chronological order.
  // Track B1c: agent_runs spans telemetry ∪ core during the cut-over.
  const runParts = await historyParts(env, "agent_runs");
  const runRows = { results: await unionGrouped<AgentAggRow & { n_dur?: number }>(runParts, (p) => ({
    sql: `SELECT
       agent_id,
       COUNT(*)                                       AS runs,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
       SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failures,
       AVG(duration_ms)                               AS avg_duration_ms,
       MAX(started_at)                                AS last_run_at,
       NULL                                           AS last_error,
       COUNT(duration_ms)                             AS n_dur
     FROM agent_runs
     WHERE started_at >= ?/*split*/
     GROUP BY agent_id`,
    binds: [sinceIso],
  }), {
    groupBy: ["agent_id"],
    sum: ["runs", "successes", "failures", "n_dur"],
    max: ["last_run_at", "last_error"],
    avg: [{ col: "avg_duration_ms", weight: "n_dur" }],
    drop: ["n_dur"],
  }) };

  // Per-agent 7-day AI cost from budget_ledger.
  const costRows = await env.DB.prepare(
    `SELECT agent_id, SUM(cost_usd) AS total_cost
       FROM budget_ledger
      WHERE created_at >= ?
      GROUP BY agent_id`,
  )
    .bind(sinceIso)
    .all<CostRow>();

  const costByAgent = new Map<string, number>();
  for (const r of costRows.results ?? []) {
    costByAgent.set(r.agent_id, r.total_cost ?? 0);
  }

  // Most recent error message per agent (separate query — easier than window
  // functions on the aggregation above).
  const errorByAgent = await collectLastErrors(env, sinceIso);

  const out: AgentTelemetry[] = [];
  for (const row of runRows.results ?? []) {
    out.push({
      agent_name: row.agent_id,
      runs_7d: row.runs ?? 0,
      successes_7d: row.successes ?? 0,
      failures_7d: row.failures ?? 0,
      avg_duration_ms:
        row.avg_duration_ms === null || row.avg_duration_ms === undefined
          ? null
          : Math.round(row.avg_duration_ms),
      ai_cost_usd_7d: costByAgent.get(row.agent_id) ?? 0,
      last_run_at: row.last_run_at ?? null,
      last_error: errorByAgent.get(row.agent_id) ?? null,
    });
  }
  out.sort((a, b) => a.agent_name.localeCompare(b.agent_name));
  return out;
}

interface LastErrorRow {
  agent_id: string;
  error_message: string | null;
}

async function collectLastErrors(
  env: Env,
  sinceIso: string,
): Promise<Map<string, string>> {
  const parts = await historyParts(env, "agent_runs");
  const rows = { results: await unionRows<LastErrorRow & { started_at?: string }>(parts, (p) => ({
    sql: `SELECT agent_id, error_message, started_at
       FROM agent_runs
      WHERE started_at >= ?
        AND status = 'failed'
        AND error_message IS NOT NULL/*split*/
      ORDER BY started_at DESC`,
    binds: [sinceIso],
  }), { sort: byDesc<LastErrorRow & { started_at?: string }>("started_at"), drop: ["started_at"] }) };

  const map = new Map<string, string>();
  for (const r of rows.results ?? []) {
    if (!map.has(r.agent_id) && r.error_message) {
      map.set(r.agent_id, r.error_message);
    }
  }
  return map;
}

// ─── Cron telemetry ───────────────────────────────────────────────

async function collectCronTelemetry(
  env: Env,
  sinceIso: string,
): Promise<CronTelemetry[]> {
  // Cron patterns are declared in wrangler.toml, not in D1. The repo
  // collector is the source of truth for patterns; here we surface the
  // aggregate health of the single hourly cron that wraps all scheduled
  // agents.
  //
  // TODO: wire Cloudflare Cron Trigger analytics (graphQL analytics API)
  // once CF_ACCOUNT_ID + CF_API_TOKEN include the Analytics scope, to
  // separate handler-level outcome from per-agent outcome.
  const cronParts = await historyParts(env, "agent_runs");
  const perPart = await Promise.all(cronParts.map((part) => {
    const q = applySplit(part, {
      sql: `SELECT
       (SELECT status FROM agent_runs
          WHERE started_at >= ?/*split*/
          ORDER BY started_at DESC LIMIT 1) AS status,
       (SELECT MAX(started_at) FROM agent_runs WHERE started_at >= ?/*split*/) AS last_at,
       COUNT(*) AS runs,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
     FROM agent_runs
     WHERE started_at >= ?/*split*/`,
      binds: [sinceIso, sinceIso, sinceIso],
    });
    return part.db.prepare(q.sql).bind(...q.binds).first<CronStatusRow & { last_at?: string | null }>();
  }));
  // Union: counts summed; status from the part holding the newest run.
  const row: CronStatusRow | null = perPart.length === 1 ? (perPart[0] ?? null) : perPart.reduce<(CronStatusRow & { last_at?: string | null }) | null>((acc, r) => {
    if (!r) return acc;
    if (!acc) return { ...r };
    const newer = (r.last_at ?? "") > (acc.last_at ?? "");
    return {
      ...acc,
      status: newer ? r.status : acc.status,
      last_at: newer ? r.last_at : acc.last_at,
      runs: (acc.runs ?? 0) + (r.runs ?? 0),
      failures: (acc.failures ?? 0) + (r.failures ?? 0),
    };
  }, null);

  const lastStatus: CronTelemetry["last_status"] =
    row?.status === "success"
      ? "success"
      : row?.status === "failed"
        ? "failure"
        : "unknown";

  return [
    {
      pattern: "0 * * * *",
      runs_7d: row?.runs ?? 0,
      failures_7d: row?.failures ?? 0,
      last_status: lastStatus,
    },
  ];
}

// ─── AI Gateway stats ─────────────────────────────────────────────

async function collectAiGatewayStats(
  env: Env,
  sinceIso: string,
): Promise<OpsTelemetry["ai_gateway"]> {
  // Total 7-day AI spend and per-model mix come from budget_ledger.
  const totalRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost FROM budget_ledger
      WHERE created_at >= ?`,
  )
    .bind(sinceIso)
    .first<{ total_cost: number }>();

  const modelRows = await env.DB.prepare(
    `SELECT model, SUM(cost_usd) AS total_cost
       FROM budget_ledger
      WHERE created_at >= ?
      GROUP BY model`,
  )
    .bind(sinceIso)
    .all<ModelCostRow>();

  const modelMix: Record<string, number> = {};
  for (const r of modelRows.results ?? []) {
    modelMix[r.model] = r.total_cost ?? 0;
  }

  // TODO: cache_hit_rate requires the Cloudflare AI Gateway analytics API
  // (GET /accounts/{id}/ai-gateway/gateways/{gw}/analytics). Not yet wired
  // to the worker — return null until the binding + API token land.
  return {
    total_cost_usd_7d: totalRow?.total_cost ?? 0,
    cache_hit_rate: null,
    model_mix: modelMix,
  };
}

// ─── Utilities ────────────────────────────────────────────────────

function sevenDaysAgoIso(): string {
  const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // agent_runs stores datetime('now') which is "YYYY-MM-DD HH:MM:SS" (UTC).
  // Format to match lexicographic comparison semantics.
  return d.toISOString().replace("T", " ").slice(0, 19);
}
