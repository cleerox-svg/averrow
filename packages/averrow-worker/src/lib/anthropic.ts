/**
 * Canonical Anthropic Messages API wrapper.
 *
 * Every Anthropic call in the worker goes through callAnthropic().
 * That is the whole point of this file: adding a new AI call site
 * without ledger tracking should be structurally impossible.
 *
 * Contract:
 * - Every successful call writes a row to budget_ledger via
 *   BudgetManager.recordCost(agentId, runId, model, input_tokens,
 *   output_tokens) exactly once. No caller needs to remember.
 * - Failed calls do NOT write a ledger row (no tokens consumed) but
 *   are logged to console with the agentId so operators can trace
 *   them to the right caller.
 * - Callers get the raw Anthropic response back, so code that needs
 *   usage.input_tokens / output_tokens / tool_use.input for its own
 *   logic still has everything it needs.
 *
 * Features:
 * - Plain text completion (content[].text)
 * - JSON mode — helper below extracts the first JSON object from text
 * - Tool use — pass tools + tool_choice, read content[].input
 * - Haiku and Sonnet (or any model in BudgetManager.COST_PER_MILLION)
 * - Optional routing through Cloudflare AI Gateway when CF_ACCOUNT_ID
 *   is set, otherwise direct api.anthropic.com
 *
 * If you need a new capability, add it here — do not spin up a new
 * direct fetch call site. rg "api\.anthropic\.com" across the worker
 * should only hit this file.
 */

import { BudgetManager } from "./budgetManager";
import { checkAgentBudget } from "./per-agent-budget";
import type { Env } from "../types";

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Types ──────────────────────────────────────────────────────

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  // Prompt caching metrics — present on responses that include
  // cache_control blocks. cache_creation_input_tokens are billed at
  // 1.25× standard input rate (cache write), cache_read_input_tokens
  // at 0.1× (90% discount). Absent on responses without caching.
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicResponse {
  id?: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: AnthropicUsage;
}

/**
 * Minimal env shape the wrapper needs. Accepts the full Env type at
 * call sites without forcing every caller to pass a DB binding it
 * may not have — db is used for ledger writes only, and callers
 * without DB access (rare, but lib helpers from public fetch paths
 * can hit this) will get an explicit warning instead of a crash.
 */
export type AnthropicEnv = Pick<
  Env,
  "ANTHROPIC_API_KEY" | "LRX_API_KEY" | "CF_ACCOUNT_ID" | "DB"
> & {
  // Optional KV — Phase 5.1's per-agent budget gate uses CACHE for
  // its 60s decision cache. Test fixtures + the retired architect
  // env shape don't carry CACHE; the gate's try/catch handles
  // absence by falling through to the slow path each call.
  CACHE?: KVNamespace;
};

export interface AnthropicCallOptions {
  /** Attribution ID for the ledger row — stable string, e.g. "sentinel", "admin". */
  agentId: string;
  /** Optional run ID (agent_runs.id). null for admin / lib helpers without a run context. */
  runId?: string | null;
  /** Any key in BudgetManager.COST_PER_MILLION. */
  model: string;
  /** System prompt. */
  system?: string;
  /** Chat messages — typically a single user message. */
  messages: AnthropicMessage[];
  /** Max output tokens. */
  maxTokens: number;
  /** Tool definitions for tool_use mode. */
  tools?: unknown[];
  /** Tool choice — typically { type: "tool", name: "..." } to force a call. */
  toolChoice?: unknown;
  /** Per-request timeout override (default 30s). */
  timeoutMs?: number;
  /**
   * Route through Cloudflare AI Gateway when CF_ACCOUNT_ID is set.
   * Default: true. Set false to force direct api.anthropic.com.
   */
  useGateway?: boolean;
  /**
   * Override the deterministic idempotency key for this call. By default
   * `callAnthropic` computes a stable key from
   * (agentId + runId + model + system + messages + maxTokens) — see
   * computeIdempotencyKey() below. Callers can pass a custom value when
   * the natural derivation isn't stable (e.g. inputs that include
   * timestamps), or set this to an empty string to suppress the header
   * entirely.
   */
  idempotencyKey?: string;
  /**
   * Wrap the `system` prompt in a `cache_control: { type: 'ephemeral' }`
   * block so Anthropic caches it for subsequent calls (Lever #4 of the
   * AI cost-reduction plan).
   *
   * Cache hits return `cache_read_input_tokens` in usage and are billed
   * at 10% of standard input rate. Cache writes are billed at 125%. The
   * cache TTL is 5 minutes by default — refresh implicit on every cache
   * hit. Minimum cacheable size is 1024 tokens for Sonnet, 2048 for Haiku.
   *
   * Use only when the system prompt is:
   *   - Static across many calls (e.g. Architect's reconciliation prompt)
   *   - Long enough to clear the model's minimum (Haiku ≥ 2048 tokens)
   *   - Called at a rate that beats the 5-min TTL
   *
   * No-op for callers that don't set it — backwards compatible with every
   * existing call site. Wire up per-callsite, not globally.
   */
  cacheSystem?: boolean;
  /**
   * Wrap the last user-message in a cache_control block (sliding cache
   * boundary). Useful when the prefix of the conversation is stable but
   * the tail varies — Anthropic caches everything up to and including
   * the cache_control block. Same billing rules as cacheSystem.
   *
   * Most call sites here send a single user message, so this option is
   * effectively "cache the whole message" — useful when the message
   * itself is a large fixed context bundle (e.g. NEXUS pivot detection).
   */
  cacheLastUserMessage?: boolean;
}

/**
 * Compute a deterministic idempotency key from the call options.
 *
 * Same logical request (same agent + run + model + prompt) always
 * yields the same key, so a retry of a transient failure (Workflows
 * platform error, worker death, etc.) can land on Anthropic with the
 * same key as the original attempt. When Anthropic honors the
 * `anthropic-idempotency-key` header (it does for the `/v1/messages`
 * endpoint, returning the cached response for repeats within a 24h
 * window), this avoids paying twice for the same logical work.
 *
 * The hash is truncated to 16 hex chars for compactness — collision
 * probability over a year of Averrow's ~50K-call volume is well
 * below the dedup window's 24h tolerance.
 *
 * Defense-in-depth on top of cart's existing higher-level idempotency
 * (provider_threat_stats has ON CONFLICT, email_security_scans has its
 * own staleness check). Both layers prevent double work — but the
 * Anthropic-side dedup also saves AI tokens, which our layer doesn't.
 */
export async function computeIdempotencyKey(opts: AnthropicCallOptions): Promise<string> {
  const payload = JSON.stringify({
    agentId: opts.agentId,
    runId: opts.runId ?? null,
    model: opts.model,
    system: opts.system ?? null,
    messages: opts.messages,
    maxTokens: opts.maxTokens,
  });
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(payload));
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class AnthropicError extends Error {
  constructor(
    message: string,
    public readonly agentId: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "AnthropicError";
  }
}

// ─── Key + transport ─────────────────────────────────────────────

function resolveApiKey(env: AnthropicEnv, agentId: string): string {
  const apiKey = env.ANTHROPIC_API_KEY || env.LRX_API_KEY;
  if (!apiKey) {
    throw new AnthropicError(
      `[anthropic] No API key configured (checked ANTHROPIC_API_KEY and LRX_API_KEY). agentId=${agentId}`,
      agentId,
    );
  }
  if (apiKey.startsWith("lrx_")) {
    throw new AnthropicError(
      `[anthropic] LRX_API_KEY is an LRX proxy key — set ANTHROPIC_API_KEY to a real Anthropic key (sk-ant-...). agentId=${agentId}`,
      agentId,
    );
  }
  return apiKey;
}

function resolveBaseUrl(env: AnthropicEnv, useGateway: boolean): string {
  if (useGateway && env.CF_ACCOUNT_ID) {
    return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/averrow-ai-gateway/anthropic`;
  }
  return "https://api.anthropic.com";
}

/**
 * Rewrite the LAST user-message in a messages array so its content
 * carries a cache_control block. Anthropic caches everything up to and
 * including the cache_control marker, so marking the tail means the
 * full conversation prefix becomes cacheable. Earlier messages and
 * non-user roles pass through untouched.
 *
 * String content is upconverted to the structured block form; existing
 * structured content gets the marker tacked onto its last block.
 */
function markLastUserCacheable(messages: AnthropicMessage[]): AnthropicMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return messages;
  const out = messages.slice();
  const target = out[lastUserIdx]!;
  if (typeof target.content === "string") {
    out[lastUserIdx] = {
      role: target.role,
      content: [{ type: "text", text: target.content, cache_control: { type: "ephemeral" } }],
    };
  } else if (Array.isArray(target.content) && target.content.length > 0) {
    const blocks = target.content.slice();
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock && typeof lastBlock === "object") {
      blocks[blocks.length - 1] = { ...lastBlock, cache_control: { type: "ephemeral" } };
      out[lastUserIdx] = { role: target.role, content: blocks };
    }
  }
  return out;
}

// ─── Core call ───────────────────────────────────────────────────

/**
 * The canonical entry point. Every Anthropic call in the worker goes
 * through here. Returns the raw response on success; callers extract
 * text, JSON, or tool_use as needed. Throws on any failure (HTTP
 * error, network error, timeout) — on throw, no ledger row is written.
 *
 * NOTE: DB is required for ledger attribution. If a caller genuinely
 * has no DB binding the wrapper will log a loud warning and continue
 * (the call itself still works) — but that should never happen in
 * practice since every Worker handler receives `env.DB`.
 */
export async function callAnthropic(
  env: AnthropicEnv,
  opts: AnthropicCallOptions,
): Promise<AnthropicResponse> {
  const {
    agentId,
    runId = null,
    model,
    system,
    messages,
    maxTokens,
    tools,
    toolChoice,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    useGateway = true,
  } = opts;

  const apiKey = resolveApiKey(env, agentId);
  const baseUrl = resolveBaseUrl(env, useGateway);

  // ── Per-agent budget pre-flight (Phase 5.1) ─────────────────
  // Refuses the call when the agent is over its declared
  // monthlyTokenCap. KV-cached for 60s per agent so a sync agent
  // burst pays at most one D1 read per minute. Fails open on D1/KV
  // hiccups (better to over-spend by a minute than crash a
  // customer-facing call). Unregistered agentIds (legacy kebab
  // attribution) pass through.
  if (env.DB) {
    const decision = await checkAgentBudget(env, agentId);
    if (!decision.ok) {
      console.warn(`[anthropic] per-agent budget rejected — agentId=${agentId}: ${decision.reason}`);
      throw new AnthropicError(`budget_cap_exceeded: ${decision.reason}`, agentId);
    }
  }

  // Lever #4: optional prompt caching. When cacheSystem is true the
  // system prompt is sent as a structured block with cache_control so
  // Anthropic returns 90%-discounted cache_read_input_tokens on
  // subsequent calls that reuse it. When cacheLastUserMessage is true
  // we wrap the final user message the same way (sliding-window cache).
  // Default off — every existing call site continues to send a plain
  // string system prompt and an unwrapped messages array.
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: opts.cacheLastUserMessage ? markLastUserCacheable(messages) : messages,
  };
  if (system !== undefined) {
    body.system = opts.cacheSystem
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system;
  }
  if (tools !== undefined) body.tools = tools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  // Compute or honor the per-call idempotency key. Empty string from
  // the caller suppresses the header entirely (e.g. when the prompt
  // legitimately includes timestamps and dedup would be wrong).
  const idempotencyKey = opts.idempotencyKey !== undefined
    ? opts.idempotencyKey
    : await computeIdempotencyKey(opts);

  const requestHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_API_VERSION,
    "content-type": "application/json",
  };
  if (idempotencyKey.length > 0) {
    requestHeaders["anthropic-idempotency-key"] = idempotencyKey;
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[anthropic] fetch failed — agentId=${agentId} model=${model} idempotencyKey=${idempotencyKey || 'none'}: ${msg}`);
    throw new AnthropicError(`Anthropic fetch failed: ${msg}`, agentId);
  }

  const responseText = await res.text();

  if (!res.ok) {
    console.error(
      `[anthropic] HTTP ${res.status} — agentId=${agentId} model=${model} idempotencyKey=${idempotencyKey || 'none'}: ${responseText.slice(0, 300)}`,
    );
    throw new AnthropicError(
      `Anthropic HTTP ${res.status}: ${responseText.slice(0, 300)}`,
      agentId,
      res.status,
      responseText.slice(0, 1000),
    );
  }

  let apiResponse: AnthropicResponse;
  try {
    apiResponse = JSON.parse(responseText) as AnthropicResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[anthropic] response JSON parse failed — agentId=${agentId}: ${msg}`);
    throw new AnthropicError(
      `Anthropic response JSON parse failed: ${msg}`,
      agentId,
    );
  }

  // ─── Ledger ──────────────────────────────────────────────────
  // Exactly one recordCost per successful call. Failures above this
  // point write nothing — no tokens consumed. recordCost itself is
  // wrapped in try/catch so a transient D1 blip does not cascade
  // into the caller losing its response.
  //
  // Lever #4: roll cache_creation_input_tokens and cache_read_input_tokens
  // into an effective input_token count so estimateCost() stays accurate
  // when prompt caching is in use. Anthropic bills cache writes at 1.25×
  // standard input rate and cache reads at 0.1×. Calls without caching
  // see no change (the cache fields are absent → 0 → adds nothing).
  // Future: add dedicated ledger columns if we want to observe cache
  // hit-rate separately from total spend.
  const usage = apiResponse.usage;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const inputTokens = (usage?.input_tokens ?? 0)
    + Math.round(cacheCreation * 1.25)
    + Math.round(cacheRead * 0.1);
  const outputTokens = usage?.output_tokens ?? 0;
  if (env.DB) {
    try {
      const budget = new BudgetManager(env.DB);
      await budget.recordCost(
        agentId,
        runId,
        apiResponse.model || model,
        inputTokens,
        outputTokens,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[anthropic] recordCost failed — agentId=${agentId} model=${model} in=${inputTokens} out=${outputTokens}: ${msg}`,
      );
    }
  } else {
    console.warn(
      `[anthropic] env.DB missing — ledger row skipped. agentId=${agentId} model=${model} in=${inputTokens} out=${outputTokens}`,
    );
  }

  return apiResponse;
}

// ─── JSON mode helper ────────────────────────────────────────────

/**
 * Convenience wrapper for "tell the model to respond in JSON" call
 * sites. Strips markdown fences, extracts the first JSON object, and
 * parses it. Throws AnthropicError if parsing fails.
 */
export async function callAnthropicJSON<T>(
  env: AnthropicEnv,
  opts: AnthropicCallOptions,
): Promise<{ parsed: T; response: AnthropicResponse }> {
  const response = await callAnthropic(env, opts);
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new AnthropicError(
      `Anthropic response had no text block (agentId=${opts.agentId})`,
      opts.agentId,
    );
  }

  let jsonText = textBlock.text.trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  // Accept either a JSON object or a JSON array — some call sites
  // (batch classification, attribution) expect arrays.
  const match = jsonText.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) {
    throw new AnthropicError(
      `Anthropic response had no JSON payload: ${jsonText.slice(0, 200)} (agentId=${opts.agentId})`,
      opts.agentId,
    );
  }

  try {
    const parsed = JSON.parse(match[0]) as T;
    return { parsed, response };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AnthropicError(
      `Anthropic JSON parse failed: ${msg} (agentId=${opts.agentId}): ${match[0].slice(0, 200)}`,
      opts.agentId,
    );
  }
}

// ─── Text mode helper ────────────────────────────────────────────

/**
 * Convenience wrapper for plain-text completion call sites. Returns
 * the first text block's content verbatim.
 */
export async function callAnthropicText(
  env: AnthropicEnv,
  opts: AnthropicCallOptions,
): Promise<{ text: string; response: AnthropicResponse }> {
  const response = await callAnthropic(env, opts);
  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.text ?? "";
  return { text, response };
}
