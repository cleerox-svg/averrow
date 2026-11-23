/**
 * Campaign Hunter — durable Workflow runtime (Phase 2).
 *
 * Runs the same agentic investigation as agents/campaign-hunter.ts, but as a
 * Cloudflare Workflow so each model turn checkpoints durably: a worker recycle
 * mid-investigation resumes from the last completed turn instead of restarting
 * (and re-paying for) the whole loop. The loop's deterministic idempotency key
 * (lib/anthropic.ts) makes any step replay free.
 *
 * Self-contained lifecycle (mirrors lib/agentRunner.ts executeAgent SQL, like
 * workflows/nexusRun.ts): every DB write is wrapped in step.do() so completed
 * writes are never replayed. The agent module stays the manual/inline fallback.
 *
 * Dispatched via /api/internal/agents/campaign_hunter/workflow. See
 * docs/AGENTIC_DEEP_SCAN_SPEC.md §3.1.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../types";
import {
  resolveHunterBrand,
  runHuntAndSummarize,
  type ResolvedBrand,
} from "../agents/campaign-hunter";
import { runWithWorkflowMeter } from "../lib/d1-meter";
import { isDeliberateAiSkipError } from "../lib/haiku";

export type CampaignHunterParams = {
  brandName: string;
  brandDomain: string;
  brandId?: string;
  /** Caller-supplied run id so the dispatch response can be polled. */
  runId?: string;
};

import { resolveTelemetry, telemetryDbFor, type TelemetryRoute } from "../lib/db-route";

const AGENT_ID = "campaign_hunter";

async function logActivity(
  db: D1Database,
  eventType: string,
  message: string,
  metadata: Record<string, unknown>,
  severity: "info" | "warning" | "critical" = "info",
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), AGENT_ID, eventType, message, JSON.stringify(metadata), severity).run();
  } catch {
    // Audit-only; never break the run.
  }
}

export class CampaignHunterWorkflow extends WorkflowEntrypoint<Env, CampaignHunterParams> {
  // Per-run D1 attribution → AE `workflow:campaign_hunter` (lib/d1-meter.ts):
  // this.env is swapped for a metered copy for the duration of the run and
  // the tally is flushed after every step.do callback.
  async run(event: WorkflowEvent<CampaignHunterParams>, step: WorkflowStep) {
    return runWithWorkflowMeter(
      "workflow:campaign_hunter",
      this.env,
      step,
      (env) => { this.env = env; },
      (meteredStep) => this.meteredRun(event, meteredStep),
    );
  }

  private async meteredRun(event: WorkflowEvent<CampaignHunterParams>, step: WorkflowStep) {
    const params = event.payload;
    const runId = params.runId ?? crypto.randomUUID();
    const startMs = Date.now();

    // ── Step 1: open the run ──────────────────────────────────────
    // The telemetry route is resolved ONCE, inside the durable init step,
    // and returned from it (Track B1c): a replayed or resumed run reuses the
    // persisted value, so every later step finalizes on the DB the row was
    // inserted into even if db_route:telemetry flipped in between. An
    // instance that ran init-run before this field existed returns
    // undefined → core, where its row was written.
    const initRoute = await step.do("init-run", async (): Promise<TelemetryRoute> => {
      const { route, db } = await resolveTelemetry(this.env);
      await db.prepare(
        `INSERT INTO agent_runs (id, agent_id, started_at, status, records_processed, outputs_generated)
         VALUES (?, ?, datetime('now'), 'partial', 0, 0)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(runId, AGENT_ID).run();
      await logActivity(db, "started",
        `Campaign Hunter workflow started for ${params.brandName} (${params.brandDomain})`,
        { run_id: runId, brand: params.brandDomain, triggered_by: "workflow" });
      return route;
    });
    const runRoute: TelemetryRoute = initRoute ?? "core";
    const runDb = (): D1Database => telemetryDbFor(this.env, runRoute);

    // ── Step 2: resolve the brand ─────────────────────────────────
    const brand = await step.do("resolve-brand", async (): Promise<ResolvedBrand | null> => {
      return resolveHunterBrand(this.env, {
        brandName: params.brandName,
        brandDomain: params.brandDomain,
        brandId: params.brandId,
      });
    });

    if (!brand) {
      await step.do("finalize-not-resolved", async () => {
        await runDb().prepare(
          `UPDATE agent_runs SET status = 'failed', error_message = 'brand_not_resolved',
             duration_ms = ?, completed_at = datetime('now') WHERE id = ?`,
        ).bind(Date.now() - startMs, runId).run();
        await logActivity(runDb(), "batch_complete",
          `Campaign Hunter could not resolve brand "${params.brandName}"`,
          { run_id: runId, resolved: false }, "warning");
      });
      return { runId, resolved: false };
    }

    // ── Investigation loop: each model turn is a durable step ─────
    // step.do is generically constrained to Serializable returns; the loop's
    // step seam is unconstrained, so adapt with a loose cast (AnthropicResponse
    // and the resolved brand are plain JSON, so this is sound at runtime).
    //
    // A deliberate AI skip (AI_MODE / AI_CLAUDE_TASKS / spend throttle /
    // per-agent cap) is re-thrown as NonRetryableError: retrying would only
    // be refused again. The loop (lib/agent-loop.ts) recognises the skip by
    // its message marker once it crosses the step boundary and stops with
    // stoppedBy "ai_skipped" — finalised below as a skipped run, not a
    // failure.
    const stepFn = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
      (step.do as (n: string, cb: () => Promise<unknown>) => Promise<unknown>)(label, async () => {
        try {
          return await fn();
        } catch (err) {
          if (isDeliberateAiSkipError(err)) {
            throw new NonRetryableError(err instanceof Error ? err.message : String(err));
          }
          throw err;
        }
      }) as Promise<T>;

    let summary;
    try {
      summary = await runHuntAndSummarize({
        env: this.env,
        runId,
        brand,
        brandDomain: params.brandDomain,
        step: stepFn,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await step.do("finalize-error", async () => {
        await runDb().prepare(
          `UPDATE agent_runs SET status = 'failed', error_message = ?, duration_ms = ?,
             completed_at = datetime('now') WHERE id = ?`,
        ).bind(msg.slice(0, 500), Date.now() - startMs, runId).run();
        await logActivity(runDb(), "batch_complete",
          `Campaign Hunter failed for ${brand.name}: ${msg.slice(0, 120)}`,
          { run_id: runId, error: msg.slice(0, 200) }, "critical");
      });
      throw err;
    }

    // ── Persist outputs + finalize the run (one durable step) ─────
    // Outputs go to the run's telemetry DB (agent_outputs is in the agents
    // family, Track B1 wave 2) — the route the init step resolved.
    await step.do("persist", async () => {
      let outputsGenerated = 0;
      for (const output of summary.agentOutputs) {
        try {
          await runDb().prepare(
            `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, related_brand_ids, related_campaign_id, related_provider_ids, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          ).bind(
            crypto.randomUUID(), AGENT_ID, output.type, String(output.summary),
            output.severity ? String(output.severity) : null,
            output.details ? JSON.stringify(output.details) : null,
            output.relatedBrandIds ? JSON.stringify(output.relatedBrandIds) : null,
            output.relatedCampaignId ? String(output.relatedCampaignId) : null,
            output.relatedProviderIds ? JSON.stringify(output.relatedProviderIds) : null,
          ).run();
          outputsGenerated++;
        } catch {
          // mirror executeAgent: a failed output insert doesn't fail the run
        }
      }

      await runDb().prepare(
        `UPDATE agent_runs SET status = 'success', duration_ms = ?, records_processed = ?,
           outputs_generated = ?, tokens_used = ?, completed_at = datetime('now') WHERE id = ?`,
      ).bind(Date.now() - startMs, summary.itemsProcessed, outputsGenerated, summary.tokensUsed, runId).run();

      await runDb().prepare(
        // No-op unless there is something to reset (see agentRunner).
        `UPDATE agent_configs SET consecutive_failures = 0, updated_at = datetime('now') WHERE agent_id = ? AND consecutive_failures <> 0`,
      ).bind(AGENT_ID).run();

      // A deliberate AI skip finishes like any completed run (status
      // 'success', the info diagnostic row says why) — never 'failed', never
      // a critical activity row, never a consecutive_failures bump.
      await logActivity(runDb(), "batch_complete",
        summary.aiSkipped
          ? `Campaign Hunter skipped for ${brand.name} — AI not available: ${summary.aiSkipped.slice(0, 160)}`
          : `Campaign Hunter complete for ${brand.name} — ${JSON.stringify(summary.output)}`,
        { run_id: runId, ...summary.output });
    });

    return { runId, resolved: true, ...summary.output };
  }
}
