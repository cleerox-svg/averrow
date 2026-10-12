/**
 * Page Capture Agent — phishing page evidence capture
 * (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md).
 *
 * Renders queued suspected fake login pages (IdP-impersonation family +
 * manual "Capture now") in Cloudflare Browser Rendering and stores a desktop
 * + mobile screenshot, the rendered HTML and a meta.json in the private R2
 * bucket `averrow-phish-captures`, with every object's SHA-256 in D1.
 *
 * Thin, SQL-free wrapper (same delegation pattern as executive_monitor /
 * ct_monitor): the queue, capture, storage, sweep and evidence-linking logic
 * lives in lib/page-capture.ts, so this file's declared reads/writes stay
 * empty for the architect-manifest drift gate.
 *
 * Dispatched on its own dedicated cron `*\/10 * * * *` (exact event.cron
 * match in cron/orchestrator.ts) — own Worker budget, one agent_runs row per
 * tick, plus a telemetry agent_events row (`pages_captured`,
 * target_agent NULL). Manual trigger: POST /api/internal/agents/page_capture/run.
 *
 * When BROWSER or PHISH_CAPTURES is unbound (staging / dev) the run is a
 * clean no-op: agent_runs records 0 processed and the event payload carries
 * `skipped: "bindings_absent:…"`.
 *
 * Deterministic — NO AI (budget cap 0 surfaces any unexpected AI spend).
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

export const pageCaptureAgent: AgentModule = {
  name: "page_capture",
  displayName: "Page Capture",
  description:
    "Renders suspected fake login pages in a headless browser and stores desktop + mobile screenshots and the rendered HTML as hashed, 180-day evidence for the Identity Threats detail and takedowns",
  color: "#0A8AB5",
  trigger: "scheduled",
  requiresApproval: false,
  // Every-10-minutes cadence → 30 min (≈ interval × 3) so one missed tick
  // doesn't trip the FC stall watchdog.
  stallThresholdMinutes: 30,
  parallelMax: 1,
  // No AI calls — browser rendering + R2 + D1 only.
  costGuard: "enforced",
  budget: { monthlyTokenCap: 0 },
  // Direct SQL surface is empty — delegates to lib/page-capture.ts.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "response",
  // Unique tail slot — 44 is phantom_enumerator.
  pipelinePosition: 45,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, input, runId } = ctx;
    const { runPageCapture, emitPageCaptureEvent } = await import("../lib/page-capture");

    const scheduledRaw = typeof input["scheduledTime"] === "string" ? Date.parse(input["scheduledTime"]) : NaN;
    const stats = await runPageCapture(env, {
      scheduledTime: Number.isFinite(scheduledRaw) ? new Date(scheduledRaw) : undefined,
    });
    await emitPageCaptureEvent(env, runId, stats);

    const outputs: AgentOutputEntry[] = [];
    if (stats.failed > 0 || stats.sweep.expired > 0) {
      outputs.push({
        type: "diagnostic",
        summary:
          `Page capture: ${stats.captured} captured, ${stats.blocked} blocked, ` +
          `${stats.failed} failed, ${stats.sweep.expired} expired`,
        severity: "info",
        details: stats,
      });
    }

    return {
      itemsProcessed: stats.captured + stats.blocked + stats.failed + stats.requeued,
      itemsCreated: stats.captured + stats.blocked,
      itemsUpdated: stats.sweep.expired,
      output: stats,
      agentOutputs: outputs,
    };
  },
};
