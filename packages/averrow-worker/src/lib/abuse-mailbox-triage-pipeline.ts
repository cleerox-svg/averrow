// Averrow — per-message abuse-mailbox triage pipeline
//
// The body of AbuseMailboxTriageWorkflow (workflows/abuseMailboxTriage.ts),
// kept free of the `cloudflare:workers` import so it can be unit-tested
// with a mocked step. Steps:
//
//   1. classify — rules verdict for this one message; if the rules sent it
//      to review AND AI is enabled (AI_MODE != rules_only), the AI second
//      opinion for this row (determination deferred to step 3).
//   2. sleep    — ~2 minutes, so the determination lands after the ack.
//   3. send     — deliverAbuseDetermination: atomic determination_sent_at
//      claim, so a concurrent hourly sweeper can never double-send.
//
// Every step is idempotent on replay: the rules UPDATE is guarded by
// classification='pending', the AI pass by its eligibility predicate, and
// the send by the claim.

import type { Env } from "../types";
import { isAiRulesOnly } from "./anthropic";
import { runAbuseRulesForMessage } from "./abuse-mailbox-rules-runner";
import { deliverAbuseDetermination, type DeliveryOutcome } from "./abuse-mailbox-determination";

export interface AbuseTriageParams {
  messageId: string;
}

/** The subset of WorkflowStep the pipeline uses (mockable in tests). */
export interface TriageStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: WorkflowSleepDuration): Promise<void>;
}

export const DETERMINATION_DELAY: WorkflowSleepDuration = "2 minutes";

export interface TriagePipelineResult {
  messageId: string;
  /** 'malicious' | 'review' | 'not_pending' */
  rules: string;
  /** 'skipped' | 'skipped_rules_only' | 'classified' | 'failed' */
  ai: string;
  delivery: DeliveryOutcome;
}

/** Workflow instance id for a message — one triage instance per message. */
export function abuseTriageInstanceId(messageId: string): string {
  return `abuse-${messageId}`;
}

export async function runAbuseTriagePipeline(
  env: Env,
  params: AbuseTriageParams,
  step: TriageStep,
): Promise<TriagePipelineResult> {
  const messageId = params.messageId;

  const classified = await step.do("classify", async (): Promise<{ rules: string; ai: string }> => {
    const r = await runAbuseRulesForMessage(env, messageId);
    // Transient D1 failure — throw so the Workflow retries the step. If
    // retries exhaust, the hourly sweeper classifies the row anyway.
    if (r.status === "error") throw new Error(`rules pass failed: ${r.error}`);
    if (r.status !== "classified") return { rules: r.status, ai: "skipped" };
    if (r.verdict.kind !== "review" || isAiRulesOnly(env)) {
      return { rules: r.verdict.kind, ai: r.verdict.kind === "review" ? "skipped_rules_only" : "skipped" };
    }
    const { runAbuseClassifierBackfill } = await import("./abuse-mailbox-classifier");
    const ai = await runAbuseClassifierBackfill(env, { messageId, limit: 1, deferDetermination: true });
    return {
      rules: "review",
      ai: ai.classified > 0 ? "classified" : ai.skipped_rules_only ? "skipped_rules_only" : "failed",
    };
  });

  await step.sleep("await-determination", DETERMINATION_DELAY);

  const delivery = await step.do("send-determination", () => deliverAbuseDetermination(env, messageId));

  return { messageId, rules: classified.rules, ai: classified.ai, delivery };
}
