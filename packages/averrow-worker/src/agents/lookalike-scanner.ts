/**
 * Lookalike Scanner — scheduled agent (not synchronous) that checks
 * newly-registered lookalike-domain candidates from the typosquat
 * generator, runs DNS/HTTP/MX/BIMI checks + deterministic page analysis,
 * composes a rule-based threat level, and stores the results. No AI call
 * (AI_STRATEGY_2026-10 Phase 1 #18 retired the per-row Haiku verdict).
 *
 * Phase 3.8 of agent audit. The audit (§5) initially categorised
 * this as a sync candidate; on closer read it's cron-driven (via
 * runLookalikeDomainCheck in orchestrator.ts → handleScheduled
 * hourly tick), not handler-driven. Belongs to the scheduled class.
 *
 * Wraps the existing checkLookalikeBatch(env) function in scanners/
 * lookalike-domains.ts. ONE agent_runs row per hourly tick covers all
 * rows scanned that tick.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import {
  checkLookalikeBatch,
  lookalikeCheckDefects,
  seedLookalikesForOrgBrands,
} from "../scanners/lookalike-domains";
import { analyzeLookalikePages } from "../scanners/lookalike-page-analysis";

export const lookalikeScannerAgent: AgentModule = {
  name: "lookalike_scanner",
  displayName: "Lookalike Scanner",
  description: "Cron-driven scanner that classifies newly-registered typosquat candidates via DNS/HTTP/MX/BIMI + page-content rules",
  color: "#F59E0B",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 120,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 20_000_000 },
  // Delegates to scanners/lookalike-domains.ts checkLookalikeBatch.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 29,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const agentOutputs: AgentOutputEntry[] = [];
    let scanError: string | null = null;

    // Seed candidates for tenant-monitored brands that have none yet, so the
    // checker below has a non-empty pool. Best-effort — a seeding failure must
    // not block the check pass.
    try {
      const seed = await seedLookalikesForOrgBrands(ctx.env);
      if (seed.brands_seeded > 0) {
        agentOutputs.push({
          type: "diagnostic",
          summary: `Seeded lookalike candidates for ${seed.brands_seeded} brand(s): ${seed.candidates_created} new permutations`,
          severity: "info",
          details: seed,
        });
      }
    } catch (err) {
      agentOutputs.push({
        type: "diagnostic",
        summary: `lookalike seed step failed: ${err instanceof Error ? err.message : String(err)}`,
        severity: "low",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    try {
      const check = await checkLookalikeBatch(ctx.env);
      // Surface the run's counters as a diagnostic so they reach
      // `agent_runs` / `agent_outputs` and the /v2/agents page, not only
      // the log stream. `row_errors` is the reason this exists: with
      // per-row error isolation a poisoned row no longer aborts the
      // tick, so a non-zero count is now a thing that can happen
      // SILENTLY — and a silent defect counter is not telemetry. It
      // raises the diagnostic severity by itself.
      //
      // It is no longer the ONLY such counter. Per-row isolation plus
      // the BEC lane's own try/catch left four MORE independently
      // swallowed failure paths — a BIMI alert that never filed, a
      // RELEASED claim that itself failed (a permanently lost finding),
      // an un-stamped cooldown (a row re-selected every tick) and an
      // inline page throw — each a `logger.error` and nothing else.
      // CLAUDE.md §11: operator-visible failure belongs on `agent_runs`,
      // not the log stream. `lookalikeCheckDefects` is the ONE place
      // that fold is defined, so a counter added later cannot silently
      // miss the severity decision.
      if (check.checked > 0) {
        const defects = lookalikeCheckDefects(check);
        agentOutputs.push({
          type: "diagnostic",
          summary: `Checked ${check.checked} lookalike domain(s): ` +
            `${check.new_registrations} observed registration(s), ` +
            `${check.registrations_lost} lapse(s), ` +
            `${check.mx_gained} MX / ${check.web_gained} web appearance(s), ` +
            `${check.baselines_established} baseline(s) established ` +
            `(${check.baselines_suppressed} with no signal), ` +
            `${check.bimi_alerts} BIMI alert(s) from ${check.bimi_lookups} lookup(s), ` +
            `${check.mail_web_level_lifts} mail+web level lift(s), ` +
            `${check.alerts_withheld_below_floor} alert(s) withheld below the severity floor, ` +
            `${check.checks_unresolved} unresolved, ` +
            `${check.rows_parked} parked / ${check.rows_unparked} re-admitted, ` +
            `${defects} defect(s) [${check.row_errors} row, ` +
            `${check.bimi_alert_errors} BIMI alert, ` +
            `${check.bimi_claim_release_failures} BIMI claim release, ` +
            `${check.cooldown_stamp_failures} cooldown stamp, ` +
            `${check.inline_page_errors} page]`,
          severity: defects > 0 ? "high" : "info",
          details: { ...check, defects } as Record<string, unknown>,
        });
      }
    } catch (err) {
      scanError = err instanceof Error ? err.message : String(err);
      agentOutputs.push({
        type: "diagnostic",
        summary: `lookalike_scanner batch failed: ${scanError}`,
        severity: "high",
        details: { error: scanError },
      });
    }

    // Deterministic page-content phishing analysis (D6 / S2.4). Throttled
    // re-check of the registered + resolving + has_web population via the
    // SSRF-safe fetcher. Best-effort — never fails the run. Runs after the
    // registration check so freshly-registered domains (analyzed inline)
    // are already page_fetched_at-stamped and skipped here.
    try {
      const pages = await analyzeLookalikePages(ctx.env);
      if (pages.analyzed > 0) {
        agentOutputs.push({
          type: "diagnostic",
          summary: `Page analysis: ${pages.analyzed} scanned, ${pages.escalated} escalated, ` +
            `${pages.credential_harvest} credential-harvest, ${pages.alerts_raised} alert(s) raised` +
            `${pages.alert_cap_hit ? ' (per-run alert cap hit)' : ''}`,
          severity: pages.credential_harvest > 0 ? "high" : "info",
          details: { ...pages } as Record<string, unknown>,
        });
      }
    } catch (err) {
      agentOutputs.push({
        type: "diagnostic",
        summary: `lookalike page analysis failed: ${err instanceof Error ? err.message : String(err)}`,
        severity: "low",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
      // Don't throw — let the standard runner mark the run 'success'
      // with a diagnostic. The scanner's failure modes are mostly
      // per-row (DNS timeouts, page-fetch throws) handled inside the lib;
      // a top-level throw means the loop didn't complete, which is
      // worth surfacing but not flagging as 'failed' since some
      // work likely landed. (Phase 4 partial-status work will
      // refine this — for now sub-call diagnostics are the trail.)
    }

    return {
      itemsProcessed: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: { error: scanError },
      agentOutputs,
    };
  },
};
