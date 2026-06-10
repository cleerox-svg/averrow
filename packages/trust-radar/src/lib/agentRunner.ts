/**
 * Agent Runner — Orchestrator for AI agent execution (v2).
 *
 * Uses v2 tables: agent_runs, agent_outputs, agent_configs.
 * Circuit breaker: auto-trips agents after N consecutive failures.
 * flight_control and architect are protected from auto-trip.
 */

import type { Env } from "../types";
import { createNotification } from "./notifications";
import { withD1Retry } from "./d1-retry";

// ─── Types ──────────────────────────────────────────────────────

export type AgentName =
  | "sentinel"
  | "analyst"
  | "cartographer"
  | "strategist"
  | "observer"
  | "pathfinder"
  | "sparrow"
  | "nexus"
  | "trustbot"
  | "seed_strategist"
  | "flight_control"
  | "curator"
  | "watchdog"
  | "architect"
  | "narrator"
  | "notification_narrator"
  | "app_store_monitor"
  | "dark_web_monitor"
  | "social_monitor"
  | "social_discovery"
  | "auto_seeder"
  | "cube_healer"
  | "navigator"
  | "enricher"
  | "public_trust_check"
  | "qualified_report"
  | "brand_analysis"
  | "brand_report"
  | "brand_deep_scan"
  | "honeypot_generator"
  | "brand_enricher"
  | "lookalike_scanner"
  | "trademark_monitor"
  | "admin_classify"
  | "url_scan"
  | "scan_report"
  | "social_ai_assessor"
  | "geo_campaign_assessment"
  | "evidence_assembler"
  | "geoip_refresh"
  | "attributor"
  | "news_watcher"
  | "campaign_hunter";

export type TriggerType = "scheduled" | "event" | "manual" | "api";
export type RunStatus = "success" | "partial" | "failed";

export interface AgentRunRow {
  id: string;
  agent_id: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
  records_processed: number;
  outputs_generated: number;
}

export interface AgentOutputRow {
  id: string;
  agent_id: string;
  type: string;
  summary: string;
  severity: string | null;
  details: string | null;
  related_brand_ids: string | null;
  related_campaign_id: string | null;
  related_provider_ids: string | null;
  created_at: string;
}

export interface AgentContext {
  env: Env;
  runId: string;
  agentName: string;
  input: Record<string, unknown>;
  triggeredBy: string | null;
}

export interface AgentResult {
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  output: Record<string, unknown>;
  model?: string;
  tokensUsed?: number;
  approvals?: ApprovalRequest[];
  /** Agent outputs to persist in agent_outputs table */
  agentOutputs?: AgentOutputEntry[];
}

export interface AgentOutputEntry {
  type: AgentOutputType;
  summary: string;
  severity?: "critical" | "high" | "medium" | "low" | "info";
  details?: Record<string, unknown>;
  relatedBrandIds?: string[];
  relatedCampaignId?: string;
  relatedProviderIds?: string[];
}

export interface ApprovalRequest {
  actionType: string;
  description: string;
  details: Record<string, unknown>;
  expiresInHours?: number;
}

/** Agent category — drives presentation grouping on the Agents page
 *  and FC card mesh. Adds 'sync' to the standard's stock list because
 *  the synchronous-AI class added in Phase 3 deserves its own bucket
 *  in the UI. */
export type AgentCategory =
  | "orchestration"
  | "intelligence"
  | "response"
  | "ops"
  | "meta"
  | "sync";

/** Lifecycle state of an agent (AGENT_STANDARD §5).
 *
 *   - 'active'  — registered + scheduled, runs normally.
 *   - 'paused'  — circuit-breaker tripped or operator-paused; FC
 *                 honours `agent_configs.enabled = 0` independently,
 *                 so this is a module-level intent.
 *   - 'shadow'  — runs but its agent_outputs aren't acted on. Used
 *                 during a re-roll-out where you want signal without
 *                 side effects. Today no agents are in shadow mode.
 *   - 'retired' — module is kept around for git history but not in
 *                 agentModules. The architect module is the only one
 *                 today (Phase 2.2).
 */
export type AgentStatus = "active" | "paused" | "shadow" | "retired";

/** Output type union — each entry an agent emits to agent_outputs. */
export type AgentOutputType =
  | "insight"
  | "classification"
  | "correlation"
  | "score"
  | "trend_report"
  | "diagnostic"
  | "hygiene_report";

/** Per-output declaration. The optional schema lets agents validate
 *  their `details` payload before INSERT — Phase 4.4 ships only the
 *  type list; Phase 5 wires schema-aware persistence. */
export interface AgentOutputDecl {
  type: AgentOutputType;
  /** Optional Zod schema for the `details` payload. When present,
   *  Phase 5's audit-agent-standard.ts will require runner-level
   *  validation. */
  schema?: unknown;
}

/** Resource declaration — what an agent reads from / writes to.
 *  Used by Phase 4.3 + Phase 5's drift CI gate to compare static SQL
 *  extraction against the declared set. The discriminated union keeps
 *  D1 tables, KV namespaces, R2 buckets, and other env bindings in
 *  separate buckets so per-resource lint rules can target them
 *  (e.g. "no agent may read users.email"). */
export type ResourceDecl =
  | { kind: "d1_table"; name: string }
  | { kind: "kv"; namespace: string; prefix?: string }
  | { kind: "r2"; bucket: string; prefix?: string }
  | { kind: "queue"; name: string }
  | { kind: "binding"; name: string }
  // External HTTP dependencies (DNS resolvers, third-party APIs we
  // call directly, etc.). Surfaced in the AgentDeclarationsPanel
  // so operators can see the off-platform endpoints an agent depends
  // on. Not extracted by the SQL drift checker — declared manually.
  | { kind: "external"; name: string; url?: string };

export interface AgentBudget {
  /** Anthropic-token cap per calendar month (input + output combined,
   *  Haiku-equivalent). 0 = exempt agents (no AI calls expected). */
  monthlyTokenCap: number;
  /** D1 reads cap per calendar month — optional, not yet enforced. */
  monthlyD1ReadCap?: number;
  /** D1 writes cap per calendar month — optional, not yet enforced. */
  monthlyD1WriteCap?: number;
  /** Fraction of any cap (0..1) at which an alert is raised.
   *  Default 0.8 if omitted. */
  alertAt?: number;
}

export interface AgentModule {
  name: AgentName;
  displayName: string;
  description: string;
  color: string;
  trigger: TriggerType;
  requiresApproval?: boolean;

  // ── Supervision (FC reads these — AGENT_STANDARD §3) ──────────
  /** Minutes after a run is considered stalled. Replaces the
   *  STALL_THRESHOLDS map that used to live in flightControl.ts. FC
   *  re-dispatches stalled scheduled agents; sync agents use this
   *  for the runaway-call alarm only. */
  stallThresholdMinutes: number;
  /** Maximum concurrent runs FC will permit. Default 1 for cron-driven
   *  agents; sync agents may scale up to handle multiple HTTP
   *  callers in parallel. */
  parallelMax: number;
  /** 'enforced' = subject to platform AI cost guard.
   *  'exempt'   = bypass platform throttle (architecture review only —
   *               flight_control / cube_healer / navigator / enricher
   *               do not call AI; sync exempts require justification). */
  costGuard: "enforced" | "exempt";

  // ── Per-agent budget (AGENT_STANDARD §11) ──────────────────────
  /** Monthly token / D1 caps. Required so every agent declares
   *  intent. Phase 4.2 only adds the declarations; Phase 5 wires
   *  the pre-flight enforcement check that reads `budget_ledger` and
   *  refuses an AI call when the agent is over `monthlyTokenCap`.
   *  An exempt agent (`costGuard: 'exempt'`) declares
   *  `monthlyTokenCap: 0` so the diagnostic can flag any unexpected
   *  AI spend on it as a regression. */
  budget: AgentBudget;

  // ── Resource declarations (AGENT_STANDARD §10) ─────────────────
  /** Tables / KV namespaces / R2 buckets the agent reads from.
   *  Implicit reads (agent_runs / agent_outputs / agent_events /
   *  budget_ledger, agent_configs) are NOT listed here — they're
   *  platform infrastructure every agent touches via the runner.
   *
   *  Phase 4.3 only adds the declarations and matches them to the
   *  architect manifest's static SQL extraction. Phase 5's
   *  audit-agent-standard.ts script compares declarations to the
   *  fresh extraction on each build and fails CI on drift. */
  reads: ResourceDecl[];
  writes: ResourceDecl[];

  // ── Output contract (AGENT_STANDARD §9) ────────────────────────
  /** Output types the agent's execute() emits via
   *  `result.agentOutputs[].type`. Empty array = no agent_outputs
   *  rows expected. Drives Phase 5's runner-level schema validation
   *  (per-type Zod) and the Agents page's "what does this emit?"
   *  surface. */
  outputs: AgentOutputDecl[];

  // ── Lifecycle status (AGENT_STANDARD §5) ───────────────────────
  /** Module-level lifecycle intent. Distinct from agent_configs.enabled
   *  (which is the runtime circuit-breaker state). FC's recovery
   *  loop and the Agents page filter by this — 'retired' modules
   *  are excluded from supervision. */
  status: AgentStatus;

  // ── Presentation (AGENT_STANDARD §3, §7) ────────────────────────
  /** Drives the Agents page group / FC card mesh bucketing. Phase 4.5
   *  ports this from averrow-ops's agent-metadata.ts so the backend is
   *  the single source of truth; Phase 5 will surface it via the
   *  agents API and the UI fetches instead of reading a hardcoded
   *  registry. */
  category: AgentCategory;
  /** Sort key on the Agents page + FC mesh. Lower = earlier in the
   *  pipeline. Conventionally:
   *    0       — flight_control (supervisor, top of mesh)
   *    1-21    — pre-Phase-3 cron + intelligence + ops agents
   *    22-34   — Phase 3 sync agents (chronological add order)
   *    35+     — utility / retired modules */
  pipelinePosition: number;

  execute: (ctx: AgentContext) => Promise<AgentResult>;
}

// ─── Circuit Breaker ────────────────────────────────────────────

/** Agents that can still be manually disabled but are never auto-tripped. */
export const PROTECTED_FROM_CIRCUIT_BREAKER = new Set(["flight_control", "architect"]);

/** Default consecutive-failure threshold when system_config has no row. */
const DEFAULT_AGENT_FAILURE_THRESHOLD = 3;

export type CircuitState = "closed" | "tripped";

export interface ExecuteAgentResult {
  runId: string;
  status: RunStatus | "circuit_open";
  result: AgentResult | null;
  error?: string;
  reason?: string;
}

// ─── Run Execution ──────────────────────────────────────────────

export async function executeAgent(
  env: Env,
  agentModule: AgentModule,
  input: Record<string, unknown> = {},
  triggeredBy: string | null = null,
  triggerType: TriggerType = "manual",
): Promise<ExecuteAgentResult> {
  const agentId = agentModule.name;

  // ── Circuit breaker gate ────────────────────────────────────
  // Ensure the config row exists (zero-ceremony for agents added after migration).
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_configs (agent_id) VALUES (?)"
  ).bind(agentId).run();

  const configRow = await env.DB.prepare(
    "SELECT enabled, paused_reason FROM agent_configs WHERE agent_id = ?"
  ).bind(agentId).first<{ enabled: number; paused_reason: string | null }>();

  if (configRow && configRow.enabled === 0) {
    const reason = configRow.paused_reason ?? "disabled";
    console.log(`[agentRunner] ${agentId}: circuit open (${reason}) — skipping`);

    // Log to agent_activity_log so FC dashboard can surface skips.
    try {
      await env.DB.prepare(
        `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity, created_at)
         VALUES (?, ?, 'circuit_open_skip', ?, ?, 'info', datetime('now'))`
      ).bind(
        crypto.randomUUID(),
        agentId,
        `Agent ${agentId} skipped — circuit open (${reason})`,
        JSON.stringify({ agent_id: agentId, paused_reason: reason }),
      ).run();
    } catch { /* never block on logging */ }

    return { runId: "", status: "circuit_open", result: null, reason };
  }

  // ── Deployment-approval gate (AGENT_STANDARD §12.1, Phase 5.4b) ──
  // Refuse the run when the agent isn't an approved deployment yet.
  // First-observed agents (no row in agent_approvals) auto-create a
  // 'pending' row and block the run; rejected/changes_requested also
  // block. The migration 0126 backfill already grandfathered the 35
  // pre-5.4 agents as 'approved', so this gate is a no-op for them.
  //
  // We import lazily to keep the module graph DAG-shaped — agent-
  // approvals.ts has no runner imports either way, but the lazy
  // shape mirrors how lib/per-agent-budget loads in lib/anthropic.
  const { getApprovalState, createPending } = await import("./agent-approvals");
  let approval: Awaited<ReturnType<typeof getApprovalState>> = null;
  let approvalGateAvailable = true;
  try {
    approval = await getApprovalState(env.DB, agentId);
  } catch (err) {
    // Fail open: when agent_approvals isn't queryable (test fake
    // missing the table, transient D1 hiccup, migration not yet
    // applied) we let the run proceed rather than crash. The
    // grandfather backfill in migration 0126 means a real prod
    // worker should always find a row for registered agents; an
    // exception here indicates infra trouble worth surfacing as a
    // log line but not the right place to fail the run.
    console.warn(
      `[agentRunner] ${agentId}: approval gate unavailable (${err instanceof Error ? err.message : String(err)}) — allowing run`,
    );
    approvalGateAvailable = false;
  }
  const blockingState = !approvalGateAvailable
    ? null
    : approval === null
      ? "missing"
      : approval.state === "approved"
        ? null
        : approval.state;

  if (blockingState !== null) {
    if (approval === null) {
      // First sighting — create the pending row so reviewers see this
      // agent in /api/admin/agents/approvals/pending. Best-effort:
      // failure to insert shouldn't crash the run path, but DOES
      // still block the agent from running until the row lands.
      try { await createPending(env.DB, agentId); } catch (err) {
        console.warn(
          `[agentRunner] ${agentId}: createPending failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const reason = approval === null
      ? "pending_approval (auto-created on first run)"
      : `${approval.state}${approval.reviewer_notes ? `: ${approval.reviewer_notes.slice(0, 80)}` : ""}`;
    console.log(`[agentRunner] ${agentId}: deployment approval gate (${reason}) — skipping`);

    // Same agent_activity_log entry shape as the circuit-breaker gate
    // so the FC dashboard can render both.
    try {
      await env.DB.prepare(
        `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity, created_at)
         VALUES (?, ?, 'approval_gate_skip', ?, ?, 'info', datetime('now'))`
      ).bind(
        crypto.randomUUID(),
        agentId,
        `Agent ${agentId} skipped — awaiting approval (${reason})`,
        JSON.stringify({ agent_id: agentId, approval_state: approval?.state ?? "missing" }),
      ).run();
    } catch { /* never block on logging */ }

    return { runId: "", status: "circuit_open", result: null, reason };
  }

  // ── Normal execution path ──────────────────────────────────
  const runId = crypto.randomUUID();

  // Create run record in v2 agent_runs table
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, agent_id, started_at, status, records_processed, outputs_generated)
     VALUES (?, ?, datetime('now'), 'partial', 0, 0)`
  ).bind(runId, agentId).run();

  const ctx: AgentContext = { env, runId, agentName: agentId, input, triggeredBy };
  const start = Date.now();

  try {
    const result = await agentModule.execute(ctx);
    const durationMs = Date.now() - start;

    // Persist agent outputs if any
    let outputsGenerated = 0;
    if (result.agentOutputs && result.agentOutputs.length > 0) {
      for (const output of result.agentOutputs) {
        const outputId = crypto.randomUUID();
        try {
          await env.DB.prepare(
            `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, related_brand_ids, related_campaign_id, related_provider_ids, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          ).bind(
            outputId, agentId, output.type, String(output.summary),
            output.severity ? String(output.severity) : null,
            output.details ? JSON.stringify(output.details) : null,
            output.relatedBrandIds ? JSON.stringify(output.relatedBrandIds) : null,
            output.relatedCampaignId ? String(output.relatedCampaignId) : null,
            output.relatedProviderIds ? JSON.stringify(output.relatedProviderIds) : null,
          ).run();
          outputsGenerated++;
        } catch (err) {
          console.error(`[agentRunner] ${agentId}: FAILED to persist output:`, err);
        }
      }
    }

    const finalStatus: RunStatus = result.approvals?.length ? "partial" : "success";

    // Finalize under retry: the agent body succeeded, so a transient D1
    // blip on THIS write must not leave the run stuck at 'partial' (which
    // the Navigator reaper would later mark failed at the per-agent
    // ceiling — the false-positive stalls seen for cartographer/analyst/
    // strategist). Idempotent UPDATE keyed on runId → safe to re-run.
    await withD1Retry(
      () =>
        env.DB.prepare(
          `UPDATE agent_runs SET
             status = ?, duration_ms = ?, records_processed = ?,
             outputs_generated = ?, tokens_used = ?, completed_at = datetime('now')
           WHERE id = ?`,
        ).bind(
          finalStatus, durationMs, result.itemsProcessed,
          outputsGenerated, result.tokensUsed ?? 0, runId,
        ).run(),
      { label: `${agentId} finalize-success` },
    );

    // ── Circuit breaker: reset counter on success/partial ────
    await env.DB.prepare(
      "UPDATE agent_configs SET consecutive_failures = 0, updated_at = datetime('now') WHERE agent_id = ?"
    ).bind(agentId).run();

    return { runId, status: finalStatus, result };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Finalize the failure under retry for the same reason as the success
    // path: a transient D1 error while recording the failure must not
    // leave the run orphaned at 'partial'. Idempotent UPDATE keyed on runId.
    await withD1Retry(
      () =>
        env.DB.prepare(
          `UPDATE agent_runs SET status = 'failed', error_message = ?, duration_ms = ?, completed_at = datetime('now') WHERE id = ?`,
        ).bind(errorMsg, durationMs, runId).run(),
      { label: `${agentId} finalize-failure` },
    );

    // ── Circuit breaker: increment counter + maybe trip ──────
    try {
      const prev = await env.DB.prepare(
        "SELECT consecutive_failures FROM agent_configs WHERE agent_id = ?"
      ).bind(agentId).first<{ consecutive_failures: number }>();
      const newCount = (prev?.consecutive_failures ?? 0) + 1;

      await env.DB.prepare(
        "UPDATE agent_configs SET consecutive_failures = ?, updated_at = datetime('now') WHERE agent_id = ?"
      ).bind(newCount, agentId).run();

      await tripCircuitIfNeeded(env, agentId, newCount, errorMsg);
    } catch (e) {
      console.error(`[agentRunner] ${agentId}: circuit breaker bookkeeping failed:`, e);
    }

    return { runId, status: "failed", result: null, error: errorMsg };
  }
}

// ─── Synchronous agent helper ───────────────────────────────────
//
// Thin wrapper around executeAgent for the synchronous (api-trigger)
// agent class introduced in AGENT_STANDARD §2. Synchronous agents are
// the ones called inline by HTTP handlers — they return a typed
// result the handler uses to build the response, instead of writing
// side effects and returning void.
//
// Identical lifecycle (agent_runs row, output schema validation,
// circuit breaker, cost guard) to executeAgent — the only difference
// is the default trigger label ('api' vs 'manual') and the return
// shape: callers get back the typed `data` directly so handlers
// don't have to reach into result.result.output.
//
// Per-agent input/output validation lives in the agent's execute()
// function via the inputSchema / outputSchema declared on the module
// (AGENT_STANDARD §8 G5/G6). runSyncAgent itself is type-agnostic —
// the generic <T> is convenience for the caller's cast.

export interface RunSyncAgentResult<T> {
  runId: string;
  status: RunStatus | "circuit_open";
  data: T | null;
  /** Populated when the underlying agent throws or its output schema
   *  rejects the AI response. Handlers should branch on `status` then
   *  fall back to a deterministic response if needed. */
  error?: string;
}

export async function runSyncAgent<T = unknown>(
  env: Env,
  agentModule: AgentModule,
  input: Record<string, unknown> = {},
): Promise<RunSyncAgentResult<T>> {
  const result = await executeAgent(env, agentModule, input, "api", "api");
  return {
    runId: result.runId,
    status: result.status,
    data: (result.result?.output ?? null) as T | null,
    error: result.error,
  };
}

// ─── Circuit Breaker Trip Check ─────────────────────────────────

async function tripCircuitIfNeeded(
  env: Env,
  agentId: string,
  newCount: number,
  lastError: string,
): Promise<void> {
  // Protected agents are never auto-tripped.
  if (PROTECTED_FROM_CIRCUIT_BREAKER.has(agentId)) return;

  // Resolve the effective threshold: per-agent override if non-NULL,
  // else global default from system_config, else hardcoded fallback.
  const perAgentRow = await env.DB.prepare(
    "SELECT consecutive_failure_threshold FROM agent_configs WHERE agent_id = ?"
  ).bind(agentId).first<{ consecutive_failure_threshold: number | null }>();

  let threshold: number;
  if (perAgentRow?.consecutive_failure_threshold != null && perAgentRow.consecutive_failure_threshold > 0) {
    threshold = perAgentRow.consecutive_failure_threshold;
  } else {
    try {
      const globalRow = await env.DB.prepare(
        "SELECT value FROM system_config WHERE key = 'agent_consecutive_failure_threshold'"
      ).first<{ value: string }>();
      const parsed = globalRow?.value != null ? parseInt(globalRow.value, 10) : NaN;
      threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_FAILURE_THRESHOLD;
    } catch {
      threshold = DEFAULT_AGENT_FAILURE_THRESHOLD;
    }
  }

  if (newCount < threshold) return;

  // Check if already tripped (concurrent run could beat us to it).
  const current = await env.DB.prepare(
    "SELECT enabled FROM agent_configs WHERE agent_id = ?"
  ).bind(agentId).first<{ enabled: number }>();
  if (!current || current.enabled === 0) return;

  // Trip the circuit breaker.
  await env.DB.prepare(
    `UPDATE agent_configs SET
       enabled = 0,
       paused_reason = 'auto:consecutive_failures',
       paused_at = datetime('now'),
       paused_after_n_failures = ?,
       updated_at = datetime('now')
     WHERE agent_id = ? AND enabled = 1`
  ).bind(newCount, agentId).run();

  const truncatedError = lastError.slice(0, 500);

  // Fire critical notification — one per transition (rate-limited via
  // the agent_id metadata key in notifications.ts).
  try {
    await createNotification(env, {
      type: "circuit_breaker_tripped",
      severity: "critical",
      title: `Agent circuit breaker tripped: ${agentId}`,
      message: `${agentId} was auto-paused after ${newCount} consecutive failures (threshold ${threshold}). Last error: ${truncatedError}`,
      link: "/admin/agents",
      metadata: {
        agent_id: agentId,
        auto_paused: true,
        consecutive_failures: newCount,
        threshold,
        last_error: truncatedError,
      },
    });
  } catch (e) {
    console.error(`[agentRunner] ${agentId}: circuit breaker notification failed:`, e);
  }

  // Log to agent_activity_log.
  try {
    await env.DB.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity, created_at)
       VALUES (?, ?, 'circuit_breaker_tripped', ?, ?, 'critical', datetime('now'))`
    ).bind(
      crypto.randomUUID(),
      agentId,
      `Agent ${agentId} auto-paused after ${newCount} consecutive failures (threshold ${threshold})`,
      JSON.stringify({
        agent_id: agentId,
        consecutive_failures: newCount,
        threshold,
        last_error: truncatedError,
      }),
    ).run();
  } catch (e) {
    console.error(`[agentRunner] ${agentId}: circuit breaker activity log failed:`, e);
  }
}

// ─── Approval Management (legacy compat) ────────────────────────

export async function resolveApproval(
  env: Env,
  approvalId: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  note?: string,
): Promise<void> {
  // Try v1 table first (for legacy agents), gracefully handle if not exists
  try {
    await env.DB.prepare(
      `UPDATE radar_agent_approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`
    ).bind(decision, decidedBy, note ?? null, approvalId).run();
  } catch {
    // radar_agent_approvals may not exist in v2-only deployments
  }
}
