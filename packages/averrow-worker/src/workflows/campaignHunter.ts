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
import type { Env } from "../types";
import {
  resolveHunterBrand,
  runHuntAndSummarize,
  type ResolvedBrand,
} from "../agents/campaign-hunter";

export type CampaignHunterParams = {
  brandName: string;
  brandDomain: string;
  brandId?: string;
  /** Caller-supplied run id so the dispatch response can be polled. */
  runId?: string;
};

const AGENT_ID = "campaign_hunter";

async function logActivity(
  env: Env,
  eventType: string,
  message: string,
  metadata: Record<string, unknown>,
  severity: "info" | "warning" | "critical" = "info",
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), AGENT_ID, eventType, message, JSON.stringify(metadata), severity).run();
  } catch {
    // Audit-only; never break the run.
  }
}

export class CampaignHunterWorkflow extends WorkflowEntrypoint<Env, CampaignHunterParams> {
  async run(event: WorkflowEvent<CampaignHunterParams>, step: WorkflowStep) {
    const params = event.payload;
    const runId = params.runId ?? crypto.randomUUID();
    const startMs = Date.now();

    // ── Step 1: open the run ──────────────────────────────────────
    await step.do("init-run", async () => {
      await this.env.DB.prepare(
        `INSERT INTO agent_runs (id, agent_id, started_at, status, records_processed, outputs_generated)
         VALUES (?, ?, datetime('now'), 'partial', 0, 0)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(runId, AGENT_ID).run();
      await logActivity(this.env, "started",
        `Campaign Hunter workflow started for ${params.brandName} (${params.brandDomain})`,
        { run_id: runId, brand: params.brandDomain, triggered_by: "workflow" });
    });

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
        await this.env.DB.prepare(
          `UPDATE agent_runs SET status = 'failed', error_message = 'brand_not_resolved',
             duration_ms = ?, completed_at = datetime('now') WHERE id = ?`,
        ).bind(Date.now() - startMs, runId).run();
        await logActivity(this.env, "batch_complete",
          `Campaign Hunter could not resolve brand "${params.brandName}"`,
          { run_id: runId, resolved: false }, "warning");
      });
      return { runId, resolved: false };
    }

    // ── Investigation loop: each model turn is a durable step ─────
    // step.do is generically constrained to Serializable returns; the loop's
    // step seam is unconstrained, so adapt with a loose cast (AnthropicResponse
    // and the resolved brand are plain JSON, so this is sound at runtime).
    const stepFn = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
      (step.do as (n: string, cb: () => Promise<unknown>) => Promise<unknown>)(label, fn) as Promise<T>;

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
        await this.env.DB.prepare(
          `UPDATE agent_runs SET status = 'failed', error_message = ?, duration_ms = ?,
             completed_at = datetime('now') WHERE id = ?`,
        ).bind(msg.slice(0, 500), Date.now() - startMs, runId).run();
        await logActivity(this.env, "batch_complete",
          `Campaign Hunter failed for ${brand.name}: ${msg.slice(0, 120)}`,
          { run_id: runId, error: msg.slice(0, 200) }, "critical");
      });
      throw err;
    }

    // ── Persist outputs + finalize the run (one durable step) ─────
    await step.do("persist", async () => {
      let outputsGenerated = 0;
      for (const output of summary.agentOutputs) {
        try {
          await this.env.DB.prepare(
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

      await this.env.DB.prepare(
        `UPDATE agent_runs SET status = 'success', duration_ms = ?, records_processed = ?,
           outputs_generated = ?, tokens_used = 0, completed_at = datetime('now') WHERE id = ?`,
      ).bind(Date.now() - startMs, summary.itemsProcessed, outputsGenerated, runId).run();

      await this.env.DB.prepare(
        `UPDATE agent_configs SET consecutive_failures = 0, updated_at = datetime('now') WHERE agent_id = ?`,
      ).bind(AGENT_ID).run();

      await logActivity(this.env, "batch_complete",
        `Campaign Hunter complete for ${brand.name} — ${JSON.stringify(summary.output)}`,
        { run_id: runId, ...summary.output });
    });

    return { runId, resolved: true, ...summary.output };
  }
}
