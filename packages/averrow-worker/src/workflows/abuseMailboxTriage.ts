/**
 * Abuse Mailbox Triage — per-message durable Workflow.
 *
 * Dispatched by handlers/abuseMailboxEmail.ts right after a report is
 * stored and acknowledged (only for non-throttled, non-follow-up rows that
 * pass the responder + backscatter guards). Runs the rules-based verdict
 * within seconds of receipt, waits ~2 minutes, then sends the
 * determination email exactly once. Instance id `abuse-<messageId>` makes
 * a duplicate dispatch a no-op.
 *
 * The hourly `17 * * * *` abuse_mailbox_classifier agent remains the
 * sweeper: it runs the same rules pass over pending rows and delivers any
 * determination this Workflow missed (dispatch failure, exhausted retries).
 *
 * The step logic lives in lib/abuse-mailbox-triage-pipeline.ts so it can be
 * unit-tested without the `cloudflare:workers` runtime.
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env } from "../types";
import {
  runAbuseTriagePipeline,
  type AbuseTriageParams,
  type TriagePipelineResult,
} from "../lib/abuse-mailbox-triage-pipeline";

export class AbuseMailboxTriageWorkflow extends WorkflowEntrypoint<Env, AbuseTriageParams> {
  async run(event: WorkflowEvent<AbuseTriageParams>, step: WorkflowStep): Promise<TriagePipelineResult> {
    // step.do is generically constrained to Serializable returns; the
    // pipeline's step results are plain JSON objects/strings, so adapt with
    // a loose cast (same pattern as workflows/campaignHunter.ts).
    const doStep = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
      (step.do as (n: string, cb: () => Promise<unknown>) => Promise<unknown>)(name, fn) as Promise<T>;
    return runAbuseTriagePipeline(this.env, event.payload, {
      do: doStep,
      sleep: (name, duration) => step.sleep(name, duration),
    });
  }
}
