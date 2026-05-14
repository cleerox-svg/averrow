/**
 * CartographerMainWorkflow — durable execution wrapper for the cart agent.
 *
 * Cart's `execute()` is a 1173-line, 7-phase pipeline. Pre-PR-M it ran
 * inline from cron + FC scaleAgents, sharing the parent worker's CPU
 * budget. Post-PR-M dispatch can route through this workflow class so
 * each invocation gets its own Worker invocation with its own CPU + wall
 * budget — and on transient failure the Workflows runtime retries the
 * step automatically.
 *
 * SCOPE NOTE — this PR ships the single-step wrapper version. The full
 * per-phase split (each of Phase 0 / 0.5 / 1 / 2 / 3 / 4 / 5 becoming an
 * independent step.do with its own retry policy) is the eventual end
 * state but requires refactoring cart's accumulator-heavy execute() into
 * pure phase functions. That's a 500-line refactor of a hot path; we
 * stage it as a follow-up PR once this workflow path is validated in
 * prod via manual triggers.
 *
 * The wrapper still gives us:
 *  - Independent CPU budget per invocation (not shared with the
 *    orchestrator parent worker)
 *  - Auto-retry on Workflows-level failure (per the `retries` policy on
 *    the step.do below)
 *  - Workflow instance ID for tracing
 *  - Hook point for the future per-phase split — when a phase is ready
 *    to extract, replace this single step.do with multiple step.do calls
 *    accumulating results across them
 *
 * DISPATCHED FROM (post-PR-O):
 *  - `9 * * * *` cron tick (handleScheduled in cron/orchestrator.ts)
 *  - Manual: POST /api/internal/agents/cartographer/main-workflow
 *
 * PR-M does NOT switch the cron yet — that's PR-O. PR-M only adds the
 * class + binding + manual endpoint so we can validate manually first.
 *
 * AGENT MODULE FALLBACK:
 *  - agents/cartographer.ts.cartographerAgent.execute() stays in place
 *    as the manual fallback at /api/internal/agents/cartographer/run.
 *    FC scaleAgents continues to use the agent module for backlog drain
 *    (multi-instance offset stride).
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types';

interface CartographerMainParams {
  // Reserved for future per-phase parameterization (e.g. skip specific
  // phases on emergency cutover). Empty in v1.
  forceRefresh?: boolean;
}

export class CartographerMainWorkflow extends WorkflowEntrypoint<Env, CartographerMainParams> {
  async run(_event: WorkflowEvent<CartographerMainParams>, step: WorkflowStep) {
    // Log workflow start to agent_activity_log so the
    // platform-diagnostics handler's workflow-aware agent_mesh rollup
    // (PR-J) sees this as a fresh dispatch. Matches the nexus workflow
    // pattern (workflows/nexusRun.ts).
    await step.do('log-start', async () => {
      await this.env.DB.prepare(`
        INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
        VALUES (?, 'cartographer', 'started', ?, ?, 'info')
      `).bind(
        crypto.randomUUID(),
        'CartographerMainWorkflow started',
        JSON.stringify({ triggered_by: 'workflow' })
      ).run();
    });

    // Single big step wrapping cart's full agent execute(). Retries
    // the whole run on Workflows-level failure (up to 2 attempts, 60s
    // apart). Each attempt is a fresh Worker invocation with its own
    // 5-min CPU budget + 15-min wall.
    //
    // Why retries=2 and not higher: cart is idempotent (ON CONFLICT
    // writes everywhere) so multiple attempts are safe, but it
    // also runs every hour on its dedicated cron — a third attempt's
    // wall time would extend past the cadence boundary anyway.
    const result = await step.do(
      'cartographer-execute',
      { retries: { limit: 2, delay: '60 seconds', backoff: 'exponential' }, timeout: '14 minutes' },
      async () => {
        const { cartographerAgent } = await import('../agents/cartographer');
        const { executeAgent } = await import('../lib/agentRunner');
        // executeAgent inserts the agent_runs row + handles success/
        // failure status transitions. Inside, cartographerAgent.execute()
        // runs all 7 phases.
        const r = await executeAgent(
          this.env,
          cartographerAgent,
          { trigger: 'cartographer_main_workflow' },
          'cron',
          'scheduled'
        );
        return {
          runId: r.runId,
          status: r.status,
          itemsProcessed: r.result?.itemsProcessed ?? 0,
          tokensUsed: r.result?.tokensUsed ?? 0,
        };
      }
    );

    // Match the nexus workflow shape — emit a completion record the
    // diagnostics rollup understands. Mirrors workflows/nexusRun.ts
    // batch_complete pattern, but with cart-specific payload.
    await step.do('log-complete', async () => {
      await this.env.DB.prepare(`
        INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
        VALUES (?, 'cartographer', 'batch_complete', ?, ?, 'info')
      `).bind(
        crypto.randomUUID(),
        `CartographerMainWorkflow complete — ${result.itemsProcessed} items processed, ${result.tokensUsed} tokens`,
        JSON.stringify(result)
      ).run();
    });

    return result;
  }
}
