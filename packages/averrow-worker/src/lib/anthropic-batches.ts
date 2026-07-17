/**
 * Anthropic Message Batches API wrapper.
 *
 * Companion to lib/anthropic.ts. The standard /v1/messages endpoint is
 * synchronous (request → response within seconds, full standard pricing).
 * The /v1/messages/batches endpoint is asynchronous (submit → poll → ingest
 * within 24h, 50% discount on BOTH input and output tokens).
 *
 * Use this for any agent workload where:
 *   - Results don't need to come back in the same cron tick
 *   - Cost savings matter more than latency
 *   - The batch is large enough to amortize the submit/poll overhead
 *
 * The cartographer provider-scoring workload is the first user (Lever #6
 * of the AI cost-reduction plan). Provider reputation scores don't move
 * materially in an hour, so a 24h-stale batch result is acceptable in
 * exchange for halving the bill.
 *
 * Sentinel and Analyst are real-time consumers (the cron tick acts on
 * the result before exiting) and CAN'T use this path.
 *
 * API reference: https://docs.anthropic.com/en/api/creating-message-batches
 */

import { BudgetManager } from "./budgetManager";
import type { Env } from "../types";

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 30_000;
// Batches API discount factor applied to both input and output tokens.
// Anthropic's pricing page: https://www.anthropic.com/pricing
const BATCH_DISCOUNT = 0.5;

export type AnthropicBatchesEnv = Pick<
  Env,
  "ANTHROPIC_API_KEY" | "LRX_API_KEY" | "CF_ACCOUNT_ID" | "DB"
>;

export interface BatchRequestParams {
  model: string;
  max_tokens: number;
  system?: string | Array<Record<string, unknown>>;
  messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }>;
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface BatchRequest {
  /** Caller-supplied identifier to match results back to inputs. */
  custom_id: string;
  params: BatchRequestParams;
}

export interface BatchSubmitResponse {
  id: string;
  type: "message_batch";
  processing_status: "in_progress" | "canceling" | "ended";
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at: string | null;
  created_at: string;
  expires_at: string;
  archived_at?: string | null;
  cancel_initiated_at?: string | null;
  results_url: string | null;
}

export interface BatchResultEntry {
  custom_id: string;
  result:
    | { type: "succeeded"; message: { content: Array<{ type: string; text?: string }>; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } } }
    | { type: "errored"; error: { type: string; message: string } }
    | { type: "canceled" | "expired" };
}

function resolveApiKey(env: AnthropicBatchesEnv): string {
  const apiKey = env.ANTHROPIC_API_KEY || env.LRX_API_KEY;
  if (!apiKey) throw new Error("[anthropic-batches] No API key configured");
  if (apiKey.startsWith("lrx_")) throw new Error("[anthropic-batches] LRX_API_KEY is an LRX proxy key — set ANTHROPIC_API_KEY");
  return apiKey;
}

function resolveBaseUrl(env: AnthropicBatchesEnv, useGateway: boolean): string {
  if (useGateway && env.CF_ACCOUNT_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/averrow-ai-gateway/anthropic`;
  }
  return "https://api.anthropic.com";
}

/**
 * Submit a batch of requests. Returns the batch_id which the caller
 * must persist (KV or D1) to retrieve results later. Anthropic
 * processes the batch asynchronously; typical completion is < 1h
 * for small batches but the SLA is 24h.
 */
export async function submitMessageBatch(
  env: AnthropicBatchesEnv,
  requests: BatchRequest[],
  opts: { useGateway?: boolean; timeoutMs?: number } = {},
): Promise<BatchSubmitResponse> {
  if (requests.length === 0) throw new Error("[anthropic-batches] submitMessageBatch: empty requests array");
  const apiKey = resolveApiKey(env);
  const baseUrl = resolveBaseUrl(env, opts.useGateway ?? true);

  const res = await fetch(`${baseUrl}/v1/messages/batches`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requests }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`[anthropic-batches] submit HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as BatchSubmitResponse;
}

/**
 * Check the status of a previously-submitted batch. Returns the same
 * shape as the submit response. When `processing_status === 'ended'`
 * and `results_url` is populated, results can be downloaded.
 */
export async function getMessageBatch(
  env: AnthropicBatchesEnv,
  batchId: string,
  opts: { useGateway?: boolean; timeoutMs?: number } = {},
): Promise<BatchSubmitResponse> {
  const apiKey = resolveApiKey(env);
  const baseUrl = resolveBaseUrl(env, opts.useGateway ?? true);

  const res = await fetch(`${baseUrl}/v1/messages/batches/${encodeURIComponent(batchId)}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`[anthropic-batches] get HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as BatchSubmitResponse;
}

/**
 * Download and parse the JSONL results for a completed batch. Each line
 * of the response body is one BatchResultEntry. Skips empty/blank lines.
 */
export async function downloadBatchResults(
  env: AnthropicBatchesEnv,
  resultsUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<BatchResultEntry[]> {
  const apiKey = resolveApiKey(env);
  // Results URL goes direct to api.anthropic.com — gateway doesn't
  // proxy the results endpoint as of this writing.
  const res = await fetch(resultsUrl, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    throw new Error(`[anthropic-batches] download HTTP ${res.status}`);
  }
  const text = await res.text();
  const out: BatchResultEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as BatchResultEntry);
    } catch (err) {
      console.warn(`[anthropic-batches] skipping malformed JSONL line: ${trimmed.slice(0, 100)}`);
    }
  }
  return out;
}

/**
 * Bill all succeeded entries in a batch's results to the ledger at the
 * 50%-discount Batches rate. Same write path as the per-call
 * BudgetManager.recordCost so AI Spend / Cost Optimization dashboards
 * see batch cost in the same per-agent rollups.
 *
 * Folds the discount into the effective input/output token counts so
 * estimateCost() (which charges per-token at standard model rates)
 * produces the correct discounted USD.
 */
export async function recordBatchCostInLedger(
  env: AnthropicBatchesEnv,
  agentId: string,
  runId: string | null,
  model: string,
  results: BatchResultEntry[],
): Promise<{ calls: number; input_tokens: number; output_tokens: number; cost_usd_estimate: number }> {
  if (!env.DB) {
    return { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd_estimate: 0 };
  }
  const budget = new BudgetManager(env.DB);
  let calls = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  for (const entry of results) {
    if (entry.result.type !== "succeeded") continue;
    const usage = entry.result.message.usage;
    // Apply Batches discount BEFORE feeding to recordCost. estimateCost
    // doesn't know about batches — by handing it pre-discounted token
    // counts we keep the existing ledger math correct.
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const effectiveInput = (usage.input_tokens ?? 0)
      + Math.round(cacheCreation * 1.25)
      + Math.round(cacheRead * 0.1);
    const inputBilled = Math.round(effectiveInput * BATCH_DISCOUNT);
    const outputBilled = Math.round((usage.output_tokens ?? 0) * BATCH_DISCOUNT);
    try {
      const cost = await budget.recordCost(agentId, runId, model, inputBilled, outputBilled);
      totalCost += cost;
      totalInput += inputBilled;
      totalOutput += outputBilled;
      calls++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[anthropic-batches] recordCost failed agentId=${agentId} custom_id=${entry.custom_id}: ${msg}`);
    }
  }
  return { calls, input_tokens: totalInput, output_tokens: totalOutput, cost_usd_estimate: totalCost };
}
