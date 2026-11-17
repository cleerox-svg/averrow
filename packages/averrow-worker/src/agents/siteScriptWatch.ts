/**
 * Site Script Watch Agent — client-side supply-chain (Magecart /
 * polyfill.io class) monitoring of customer brands' OWN websites.
 *
 * Each run renders at most ONE due brand's home page in Cloudflare Browser
 * Rendering (same session plumbing, request interceptor and SSRF guard as
 * page_capture), diffs the scripts it runs and the hosts it contacts against
 * the brand's stored inventory, matches them against ACTIVE threats, and
 * records site_script_findings (new_host / new_script / body_changed /
 * sri_removed / new_contacted_host / ioc_match). Schema: migration 0337.
 *
 * Thin, SQL-free wrapper (same delegation pattern as page_capture): the
 * selection, scan, diff, persistence and retention logic lives in
 * lib/site-script-scan.ts, so this file's declared reads/writes stay empty
 * for the architect-manifest drift gate.
 *
 * Dispatched from the `*\/10 * * * *` cron branch in cron/orchestrator.ts
 * AFTER page_capture, only when the invocation still has
 * SITE_SCAN_MIN_BUDGET_MS of its window left; input.deadlineMs is the
 * absolute end of that window (scheduledTime + SITE_SCRIPT_TICK_WINDOW_MS).
 * Manual trigger: POST /api/internal/agents/site_script_watch/run (awaited
 * in-request, input.trigger 'manual' → short D1 write retry). A browser
 * session that cannot be opened claims nothing and ends the run degraded
 * ('partial'). Writes
 * agent_runs via executeAgent plus a telemetry agent_events row
 * (`site_scripts_scanned`, target_agent NULL).
 *
 * Without the BROWSER binding (staging / dev) the run is a clean no-op.
 * Deterministic — NO AI (budget cap 0 surfaces any unexpected AI spend).
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

export const siteScriptWatchAgent: AgentModule = {
  name: "site_script_watch",
  displayName: "Site Script Watch",
  description:
    "Renders customer brands' own websites and flags new or changed scripts, removed SRI, new contacted hosts and scripts or hosts that match active threats (Magecart-style supply-chain compromise)",
  color: "#0A8AB5",
  trigger: "scheduled",
  requiresApproval: false,
  // Runs on the every-10-minutes cron; a tick whose window page_capture used
  // up writes no run, so allow several missed ticks before FC calls it stalled.
  stallThresholdMinutes: 60,
  parallelMax: 1,
  // No AI calls — browser rendering + D1 only.
  costGuard: "enforced",
  budget: { monthlyTokenCap: 0 },
  // Direct SQL surface is empty — delegates to lib/site-script-scan.ts.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "response",
  // Unique tail slot — 45 is page_capture.
  pipelinePosition: 46,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, input, runId } = ctx;
    const { runSiteScriptWatch, emitSiteScriptEvent, SITE_SCAN_BROWSER_UNAVAILABLE } = await import("../lib/site-script-scan");

    const scheduledRaw = typeof input["scheduledTime"] === "string" ? Date.parse(input["scheduledTime"]) : NaN;
    const deadlineMs =
      typeof input["deadlineMs"] === "number" && Number.isFinite(input["deadlineMs"]) ? input["deadlineMs"] : undefined;
    let stats;
    try {
      stats = await runSiteScriptWatch(env, {
        scheduledTime: Number.isFinite(scheduledRaw) ? new Date(scheduledRaw) : undefined,
        deadlineMs,
        manual: input["trigger"] === "manual",
      });
    } catch (err) {
      // executeAgent records the failure in agent_runs.error_message; the
      // telemetry event still goes out so the run is traceable there too.
      await emitSiteScriptEvent(env, runId, null, err instanceof Error ? err.message : String(err));
      throw err;
    }
    await emitSiteScriptEvent(env, runId, stats);

    const outputs: AgentOutputEntry[] = [];
    if (stats.findings_inserted > 0 || stats.scan_status === "failed") {
      outputs.push({
        type: "diagnostic",
        summary:
          stats.scan_status === "failed"
            ? `Site Script Watch: scan of brand ${stats.brand_id} failed`
            : `Site Script Watch: ${stats.findings_inserted} new finding(s) for brand ${stats.brand_id}` +
              (stats.ioc_matches > 0 ? ` (${stats.ioc_matches} matched active threats)` : ""),
        severity: stats.ioc_matches > 0 ? "high" : "info",
        details: stats,
        relatedBrandIds: stats.brand_id ? [stats.brand_id] : undefined,
      });
    }

    const scanned = stats.scan_status === null ? 0 : 1;
    const swept =
      stats.sweep.scans + stats.sweep.contacted + stats.sweep.findings + stats.sweep.inventory + stats.sweep.expired;
    const result: AgentResult = {
      itemsProcessed: scanned,
      itemsCreated: stats.findings_inserted,
      itemsUpdated: swept + stats.reaped,
      output: stats,
      agentOutputs: outputs,
    };
    // Browser Rendering could not open a session: infra, not the site. No
    // scan was claimed (the brand keeps its slot); the run finishes
    // degraded → agent_runs 'partial' with completed_at set.
    if (stats.skipped === SITE_SCAN_BROWSER_UNAVAILABLE) {
      result.degraded = { reason: typeof stats.browser_error === "string" ? stats.browser_error : "browser session unavailable" };
    }
    return result;
  },
};
