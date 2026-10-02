/**
 * Haiku helper functions — thin wrappers over the canonical
 * Anthropic client at lib/anthropic.ts.
 *
 * After Phase 4 Step 2, this file has no transport code of its own:
 * every helper here defers to callAnthropic / callAnthropicJSON, which
 * write to budget_ledger automatically. The KV-based trackUsage path
 * is gone — the ledger is the single source of truth for spend.
 *
 * Each public helper takes a `ctx` parameter so the wrapper can attribute
 * the call to the right agent + run. Pass `{ agentId, runId }` from the
 * AgentContext, or `{ agentId, runId: null }` from handlers / lib helpers
 * without a run context.
 */

import type { Env } from "../types";
import {
  callAnthropic,
  callAnthropicJSON,
  AnthropicError,
  AiDisabledError,
  AI_RULES_ONLY_PREFIX,
  isAiRulesOnly,
} from "./anthropic";
import { BudgetManager } from "./budgetManager";
import { HOT_PATH_HAIKU } from "./ai-models";

const HAIKU_MODEL = HOT_PATH_HAIKU;

// ─── Caller context (used by every helper) ───────────────────────

export interface HaikuCallContext {
  /** Agent / call site identifier for budget_ledger attribution. */
  agentId: string;
  /** agent_runs.id when invoked from an agent run, otherwise null. */
  runId?: string | null;
}

// ─── Response types ──────────────────────────────────────────────

export interface HaikuClassification {
  threat_type: string;
  confidence: number;      // 0-100
  severity: string;        // critical, high, medium, low, info
  // reasoning/ioc_indicators are no longer requested by classifyThreat()
  // (Lever #3 of the AI cost-reduction plan) — neither caller (Sentinel
  // line 274, admin-classify.ts line 143) consumed them. Marked optional
  // so existing types/parsing stay compatible if the model still emits
  // them for legacy reasons.
  reasoning?: string;
  ioc_indicators?: string[];
}

export interface HaikuBrandMatch {
  brand_name: string;
  confidence: number;      // 0-100
  reasoning: string;
  matched_indicators: string[];
}

export interface HaikuInsight {
  title: string;
  summary: string;
  severity: string;
  details: Record<string, unknown>;
  recommendations: string[];
}

/**
 * Why a failure happened, so a caller can tell a DELIBERATE SKIP from an
 * OUTAGE.
 *
 * Before this discriminator existed, every helper here collapsed both into
 * `{ success: false, error: string }`. Callers do `if (!result.success)
 * useHeuristic()` — which is correct for a budget throttle and catastrophic
 * for an HTTP 400. The platform ran ~3 months on rule-based fallbacks with
 * zero working AI and every agent reporting success, because nothing could
 * see the difference (last budget_ledger row 2026-07-10, root cause
 * `Anthropic HTTP 400 — "Your credit balance is too low"`).
 *
 *   throttled    — OUR choice. BudgetManager hard/emergency throttle told
 *                  non-critical callers to skip, OR the platform-wide
 *                  `AI_MODE=rules_only` switch is on (AiDisabledError).
 *                  No API call was made.
 *                  Expected, self-inflicted, not an incident.
 *   budget_cap   — OUR choice. The per-agent monthlyTokenCap pre-flight in
 *                  callAnthropic refused the call. No API call was made.
 *   api_error    — THEIR refusal (or ours misconfigured): HTTP 4xx/5xx, or
 *                  no API key configured. This is the outage class.
 *   network      — fetch threw / timed out. Nothing reached Anthropic.
 *   parse_error  — the call billed and returned 2xx, but the body wasn't
 *                  usable (no text block, no JSON payload, malformed JSON).
 *
 * `api_error`, `network` and `parse_error` all mean "AI is not working".
 * `throttled` and `budget_cap` mean "AI was intentionally skipped".
 */
export type HaikuFailureKind =
  | 'throttled'
  | 'budget_cap'
  | 'api_error'
  | 'parse_error'
  | 'network';

export interface HaikuResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  model?: string;
  tokens_used?: number;
  /** Set only when `success === false`. Additive — `success` and `error`
   *  stay byte-identical so no existing call site changes behaviour. */
  failure_kind?: HaikuFailureKind;
}

/**
 * Message prefixes thrown by lib/anthropic.ts for the non-HTTP failure
 * modes. AnthropicError carries `.status` for HTTP failures (the typed
 * field we prefer), but the transport / response-shape failures carry no
 * typed discriminator, so these are matched on `.message`.
 *
 * Keep in sync with the throw sites in lib/anthropic.ts:
 *   - `Anthropic fetch failed:`            callAnthropic fetch catch
 *   - `budget_cap_exceeded:`               callAnthropic budget pre-flight
 *   - `Anthropic response JSON parse failed:`  callAnthropic JSON.parse catch
 *   - `Anthropic response had no text block`   callAnthropicJSON
 *   - `Anthropic response had no JSON payload` callAnthropicJSON
 *   - `Anthropic JSON parse failed:`           callAnthropicJSON
 */
const BUDGET_CAP_PREFIX = 'budget_cap_exceeded:';
const NETWORK_PREFIX = 'Anthropic fetch failed:';
const PARSE_MARKERS = [
  'Anthropic response JSON parse failed',
  'Anthropic response had no text block',
  'Anthropic response had no JSON payload',
  'Anthropic JSON parse failed',
] as const;

/**
 * Bucket a thrown wrapper error into a HaikuFailureKind.
 *
 * Defaults to `api_error` rather than a "don't know" bucket: an
 * unrecognised throw out of the Anthropic client means AI is not working,
 * and the whole point of this field is that an unknown failure must never
 * read as a deliberate skip. `resolveApiKey`'s "No API key configured"
 * throw lands here too, which is correct — a missing key is an outage.
 */
/**
 * True when a failure_kind means WE CHOSE to skip the call, so no request
 * ever reached Anthropic.
 *
 * Agents use this to keep their strictly-API counters honest: a throttled
 * or budget-capped result must NOT count as an attempted API call, or a
 * deliberate cost throttle would read identically to an outage and trip
 * `platform_ai_calls_failing`.
 */
export function isDeliberateAiSkip(kind: HaikuFailureKind | null | undefined): boolean {
  return kind === 'throttled' || kind === 'budget_cap';
}

/**
 * Strictly-API AI counters for one agent run, plus the one way to update
 * them. Shared by analyst / sentinel / cartographer so the three cannot
 * drift — Flight Control's `platform_ai_calls_failing` check and the
 * diagnostics `ai_health` block both read these exact key names back out
 * of `agent_outputs.details` via json_extract.
 *
 * These exist because the agents' PRE-EXISTING counters are not a usable
 * "is AI alive" test and must not be repurposed:
 *   - sentinel's `haikuSuccesses` increments for a rules-based skip that
 *     makes NO API call, so `haiku=N/0` can mean zero calls were made.
 *     This is why its telemetry read healthy through a 3-month outage.
 *   - analyst's only increments after a confidence gate, so a healthy
 *     low-confidence answer counts as neither success nor failure.
 *   - cartographer's counts post-processed providers, and its batch path
 *     post-processes 5 providers per single API call.
 * Those feed summary strings and agent_runs details operators read today,
 * so their semantics are left alone.
 */
export interface AiCallCounters {
  /** Requests that actually left for Anthropic. A throttled or
   *  budget-capped result is NOT an attempt — no request was made — or a
   *  deliberate cost throttle would be indistinguishable from an outage. */
  aiCallsAttempted: number;
  /** Of those, how many came back usable. */
  aiCallsSucceeded: number;
  /** Calls we chose not to make (budget throttle / per-agent cap). */
  aiCallsSkipped: number;
  /** FIRST failure only — one line, never accumulated per item. An outage
   *  repeats identically for every item in a batch; the first error string
   *  is the whole diagnosis and more is noise. */
  aiFirstFailureKind: HaikuFailureKind | null;
  aiFirstError: string | null;
}

export function newAiCallCounters(): AiCallCounters {
  return {
    aiCallsAttempted: 0,
    aiCallsSucceeded: 0,
    aiCallsSkipped: 0,
    aiFirstFailureKind: null,
    aiFirstError: null,
  };
}

/**
 * Record the outcome of ONE real wrapper call.
 *
 * MUST be called exactly once per API call, at the site where the call is
 * initiated — never per processed item. Sentinel shares one promise across
 * sibling threats and cartographer post-processes 5 providers per batch
 * call; counting per item in either would let `succeeded` exceed
 * `attempted` and break the >= floor in Flight Control's gate.
 *
 * `ok` is the caller's own definition of a usable response, because that
 * differs per wrapper (parsed JSON vs non-empty text vs a batch whose
 * length matches the input).
 */
export function recordAiCall(
  c: AiCallCounters,
  result: { success: boolean; error?: string; failure_kind?: HaikuFailureKind },
  ok: boolean,
  logPrefix?: string,
): void {
  if (ok) {
    c.aiCallsAttempted++;
    c.aiCallsSucceeded++;
    return;
  }
  if (isDeliberateAiSkip(result.failure_kind)) {
    c.aiCallsSkipped++;
    return;
  }
  c.aiCallsAttempted++;
  if (c.aiFirstError === null) {
    c.aiFirstFailureKind = result.failure_kind ?? null;
    c.aiFirstError = result.error ?? 'no data returned';
    if (logPrefix) {
      console.error(`${logPrefix} FIRST AI FAILURE — kind=${c.aiFirstFailureKind ?? 'unknown'}, error: ${c.aiFirstError}`);
    }
  }
}

/**
 * Minimum real API calls before "every call failed" is an outage rather
 * than noise, applied by Flight Control to its per-agent SUM over the
 * detection window.
 *
 * Three is the smallest count that cannot be one unlucky request. It sits
 * in FC rather than in the per-run verdict below on purpose: FC sums
 * across the window, so an agent failing 1-2 calls per run still
 * accumulates past the floor within the window and alerts. A per-run floor
 * would instead be a permanent detection ceiling for low-volume agents.
 *
 * The specific noise this removes is one transient 529 reaching
 * super_admins' phones. The other half of that problem — sentinel's single
 * best-effort APT call per run being able to mark a whole run degraded —
 * is handled at the source by tracking it as opportunistic, not by a floor.
 */
export const AI_OUTAGE_MIN_ATTEMPTS = 3;

/**
 * True when every real API call on an agent's REQUIRED AI path failed.
 * The one definition of "this run's AI is dead".
 *
 * No floor here, deliberately: a run that made 2 calls and had both
 * refused DID fall back to rules for everything it was asked to do, and
 * saying so is honest. The consequences of a degraded run are all
 * internal — a severity-high `agent_outputs` row and `agent_runs.status =
 * 'partial'`, which the public status page counts as a success and no
 * orphan/stall path touches. Nobody is paged by this; FC's floor governs
 * that.
 */
export function isAiAllFailing(c: Pick<AiCallCounters, 'aiCallsAttempted' | 'aiCallsSucceeded'>): boolean {
  return c.aiCallsAttempted > 0 && c.aiCallsSucceeded === 0;
}

/**
 * Split the `created_at || char(31) || json_object(...)` value the
 * AI-failure rollups in agents/flightControl.ts and handlers/diagnostics.ts
 * aggregate (see either query for why it is shaped that way) back into its two fields.
 *
 * Never throws — a diagnostic that cannot be
 * parsed must degrade to "unknown", not break the alert that carries it.
 */
export function parseNewestFailure(
  packed: string | null,
): { kind: string | null; error: string | null } {
  if (!packed) return { kind: null, error: null };
  const sep = packed.indexOf('\u001f');
  if (sep === -1) return { kind: null, error: null };
  try {
    const parsed: unknown = JSON.parse(packed.slice(sep + 1));
    if (typeof parsed !== 'object' || parsed === null) return { kind: null, error: null };
    const o = parsed as Record<string, unknown>;
    return {
      kind: typeof o.kind === 'string' ? o.kind : null,
      error: typeof o.error === 'string' ? o.error : null,
    };
  } catch {
    return { kind: null, error: null };
  }
}

export function classifyAnthropicFailure(err: unknown): HaikuFailureKind {
  // AI_MODE=rules_only — a deliberate platform-wide skip, never an outage.
  // Checked before the generic AnthropicError branch (it is a subclass).
  if (err instanceof AiDisabledError) return 'throttled';
  if (!(err instanceof AnthropicError)) return 'api_error';
  if (err.message.startsWith(AI_RULES_ONLY_PREFIX)) return 'throttled';
  // Typed field first — an HTTP status is unambiguous.
  if (typeof err.status === 'number') return 'api_error';
  if (err.message.startsWith(BUDGET_CAP_PREFIX)) return 'budget_cap';
  if (err.message.startsWith(NETWORK_PREFIX)) return 'network';
  if (PARSE_MARKERS.some((m) => err.message.includes(m))) return 'parse_error';
  return 'api_error';
}

// ─── Cost guard (BudgetManager-backed) ───────────────────────────

/**
 * Returns a string reason if non-critical AI calls should be paused
 * due to budget throttle, or null to proceed. Backed by BudgetManager
 * — same throttle ladder Flight Control uses.
 */
export async function checkCostGuard(env: Env, critical: boolean): Promise<string | null> {
  try {
    const budget = new BudgetManager(env.DB);
    const status = await budget.getStatus();
    if (status.throttle_level === "emergency") {
      return critical ? null : `budget emergency throttle (${status.pct_used}% of $${status.config.monthly_limit_usd})`;
    }
    if (status.throttle_level === "hard") {
      return critical ? null : `budget hard throttle (${status.pct_used}% of $${status.config.monthly_limit_usd})`;
    }
    return null;
  } catch (err) {
    console.warn(`[haiku] checkCostGuard: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Internal call helpers ──────────────────────────────────────

/**
 * Returns true when AI should be skipped for non-critical callers.
 *
 * Caches the throttle decision in KV (60s TTL) so that callers on the hot
 * path don't each run the budget_ledger SUM aggregation. The BudgetManager
 * query is the expensive part; this wrapper makes it effectively free for
 * the next minute once computed.
 *
 * When the budget is in hard/emergency throttle, every AI call site should
 * skip to the rule-based fallback. Without this gate, agents like Sentinel,
 * Cartographer Phase 2, and Analyst call Haiku in per-item loops and blow
 * past the configured monthly_limit_usd unchecked.
 */
async function isAiThrottled(env: Env): Promise<string | null> {
  try {
    const cached = await env.CACHE.get("ai:throttle_reason");
    if (cached !== null) {
      return cached === "" ? null : cached;
    }
  } catch { /* fall through to recompute */ }

  const blocked = await checkCostGuard(env, false);

  try {
    // Cache the decision for 60s. Empty string = not throttled. Non-empty = throttled reason.
    await env.CACHE.put("ai:throttle_reason", blocked ?? "", { expirationTtl: 60 });
  } catch { /* non-fatal */ }

  return blocked;
}

/** The envelope every helper returns when AI_MODE=rules_only. */
function rulesOnlySkip(): { success: false; error: string; failure_kind: HaikuFailureKind } {
  return { success: false, error: 'throttled: AI_MODE=rules_only', failure_kind: 'throttled' };
}

/**
 * Convert thrown wrapper errors / parse failures into the legacy
 * { success, data, error } envelope every public helper here returns.
 */
async function callJsonSafe<T>(
  env: Env,
  ctx: HaikuCallContext,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 1024,
): Promise<HaikuResponse<T>> {
  // AI_MODE=rules_only — answer before the budget gate so a disabled
  // platform spends no KV/D1 read either. callAnthropic enforces the same
  // switch for direct callers; this is just the cheaper early exit.
  if (isAiRulesOnly(env)) return rulesOnlySkip();

  // Global AI throttle gate — covers every agent on the hot path.
  const throttled = await isAiThrottled(env);
  if (throttled) {
    return { success: false, error: `throttled: ${throttled}`, failure_kind: 'throttled' };
  }

  try {
    const { parsed, response } = await callAnthropicJSON<T>(env, {
      agentId: ctx.agentId,
      runId: ctx.runId ?? null,
      model: HAIKU_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens,
    });
    return {
      success: true,
      data: parsed,
      model: response.model,
      tokens_used: response.usage.input_tokens + response.usage.output_tokens,
    };
  } catch (err) {
    const msg = err instanceof AnthropicError ? err.message : err instanceof Error ? err.message : String(err);
    return { success: false, error: msg, failure_kind: classifyAnthropicFailure(err) };
  }
}

// ─── Raw text caller (for YES/NO style prompts) ─────────────────

export async function callHaikuRaw(
  env: Env,
  ctx: HaikuCallContext,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 16,
): Promise<{
  success: boolean;
  text?: string;
  error?: string;
  tokens_used?: number;
  /** See HaikuFailureKind — set only when `success === false`. Additive. */
  failure_kind?: HaikuFailureKind;
}> {
  if (isAiRulesOnly(env)) return rulesOnlySkip();

  // Global AI throttle gate — same path as callJsonSafe.
  const throttled = await isAiThrottled(env);
  if (throttled) {
    return { success: false, error: `throttled: ${throttled}`, failure_kind: 'throttled' };
  }

  try {
    const response = await callAnthropic(env, {
      agentId: ctx.agentId,
      runId: ctx.runId ?? null,
      model: HAIKU_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens,
      timeoutMs: 15_000,
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return {
      success: true,
      text: textBlock?.text?.trim() ?? "",
      tokens_used: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      failure_kind: classifyAnthropicFailure(err),
    };
  }
}

// ─── Threat Classification ───────────────────────────────────────

export async function classifyThreat(
  env: Env,
  ctx: HaikuCallContext,
  threat: {
    malicious_url?: string | null;
    malicious_domain?: string | null;
    ip_address?: string | null;
    source_feed: string;
    ioc_value?: string | null;
  },
): Promise<HaikuResponse<HaikuClassification>> {
  // Lever #3 of the AI cost-reduction plan. Sentinel + admin-classify
  // (the only two callers) consume confidence + severity and ignore
  // reasoning + ioc_indicators (verified via callsite audit). Asking
  // for the prose anyway costs ~150 output tokens per call at 5x input
  // rate. Sentinel runs ~873 calls/day with out:in = 1.00, so output
  // dominates the bill the same way it does for cartographer.
  //
  // New prompt: numeric/categorical only. maxTokens dropped 1024 → 128
  // (response is now ~30 tokens of JSON; 4x headroom).
  const systemPrompt = `You are a cybersecurity threat classifier. Analyze the indicator and classify it.

Respond with ONLY a JSON object (no markdown, no prose outside the JSON):
{"threat_type":"<one of: phishing, typosquatting, impersonation, malware_distribution, credential_harvesting>","confidence":<0-100>,"severity":"<one of: critical, high, medium, low, info>"}

No reasoning. No IOC list. The caller derives those from rule-based logic.`;

  const userMessage = `Classify this threat:
- URL: ${threat.malicious_url ?? "N/A"}
- Domain: ${threat.malicious_domain ?? "N/A"}
- IP: ${threat.ip_address ?? "N/A"}
- Source Feed: ${threat.source_feed}
- IOC Value: ${threat.ioc_value ?? "N/A"}`;

  return callJsonSafe<HaikuClassification>(env, ctx, systemPrompt, userMessage, 128);
}

// ─── Brand Inference ─────────────────────────────────────────────

export async function inferBrand(
  env: Env,
  ctx: HaikuCallContext,
  threat: {
    malicious_url?: string | null;
    malicious_domain?: string | null;
    page_title?: string | null;
    source_feed: string;
  },
  knownBrands: string[],
): Promise<HaikuResponse<HaikuBrandMatch>> {
  const systemPrompt = `You are a brand impersonation detector. Analyze the threat indicator and determine which brand is being targeted/impersonated.
Respond with ONLY a JSON object (no markdown, no explanation outside the JSON) with these fields:
- brand_name: the brand being targeted (use official name)
- confidence: number 0-100 (use 0 if no brand match)
- reasoning: brief explanation
- matched_indicators: array of indicators that suggest brand targeting`;

  const brandList = knownBrands.length > 0
    ? `Known brands in our database: ${knownBrands.slice(0, 50).join(", ")}`
    : "No known brands in database yet.";

  const userMessage = `${brandList}

Identify the targeted brand for this threat:
- URL: ${threat.malicious_url ?? "N/A"}
- Domain: ${threat.malicious_domain ?? "N/A"}
- Page Title: ${threat.page_title ?? "N/A"}
- Source Feed: ${threat.source_feed}`;

  return callJsonSafe<HaikuBrandMatch>(env, ctx, systemPrompt, userMessage);
}

// ─── Daily Insight Generation ────────────────────────────────────

export interface HaikuBriefingItem {
  title: string;
  severity: string;
  summary: string;
  related_brand_id?: string | null;
  related_campaign_id?: string | null;
}

export async function generateInsight(
  env: Env,
  ctx: HaikuCallContext,
  context: {
    period: string;
    threats_summary: Record<string, unknown>;
    top_brands: Array<{ name: string; count: number; id?: string }>;
    top_providers: Array<{ name: string; count: number }>;
    trend_data: Record<string, unknown>;
    recent_campaigns?: Array<{ id: string; name: string; threat_count: number }>;
    agent_context?: Array<{ agent: string; summary: string }>;
    type_distribution?: Array<{ threat_type: string; count: number }>;
    email_security_summary?: string;
    spam_trap_summary?: string;
    threat_feed_summary?: string;
    high_risk_brands_summary?: string;
    narrative_summary?: string;
    social_monitor_summary?: string;
    social_mentions_summary?: string;
    lookalike_domain_summary?: string;
    ct_certificate_summary?: string;
    enrichment_validation_summary?: string;
    geopolitical_campaign_summary?: string;
    app_store_summary?: string;
    dark_web_summary?: string;
  },
): Promise<HaikuResponse<{ items: HaikuBriefingItem[] }>> {
  const systemPrompt = `You are a senior threat intelligence analyst at a security operations center. Based on the data provided, write 3-5 intelligence briefing items. Each item must have:
- A concise descriptive title (e.g., 'Roblox Credential Harvest Expanding')
- A severity level: critical, high, medium, or info
- A 2-3 sentence summary explaining WHAT is happening, WHO is being targeted, HOW the attack works, and WHY it matters
- A related_brand_id if the item is about a specific brand (use the brand ID from the data, or null)
- A related_campaign_id if the item is about a specific campaign (use the campaign ID from the data, or null)

Focus on: new or expanding campaigns, brand targeting spikes, infrastructure shifts, emerging attack patterns, and notable changes from previous periods. Write for a security professional — be specific, cite numbers, name the brands and providers involved. Do NOT write generic security advice.

Respond with ONLY a JSON object: {"items": [...]}`;

  const userMessage = `Generate intelligence briefing items from this ${context.period} data:
${JSON.stringify(context, null, 2)}`;

  return callJsonSafe<{ items: HaikuBriefingItem[] }>(env, ctx, systemPrompt, userMessage);
}

// Legacy single-insight generation (kept for backward compatibility)
export async function generateSingleInsight(
  env: Env,
  ctx: HaikuCallContext,
  context: {
    period: string;
    threats_summary: Record<string, unknown>;
    top_brands: Array<{ name: string; count: number }>;
    top_providers: Array<{ name: string; count: number }>;
    trend_data: Record<string, unknown>;
  },
): Promise<HaikuResponse<HaikuInsight>> {
  const systemPrompt = `You are a threat intelligence analyst. Generate an executive intelligence briefing from the data provided.
Respond with ONLY a JSON object (no markdown, no explanation outside the JSON) with these fields:
- title: brief title for the insight
- summary: 2-3 sentence executive summary
- severity: one of "critical", "high", "medium", "low", "info"
- details: object with key findings
- recommendations: array of actionable recommendations`;

  const userMessage = `Generate a ${context.period} threat intelligence briefing:
${JSON.stringify(context, null, 2)}`;

  return callJsonSafe<HaikuInsight>(env, ctx, systemPrompt, userMessage);
}

// ─── Batch Classification ────────────────────────────────────────

export async function batchClassify(
  env: Env,
  ctx: HaikuCallContext,
  threats: Array<{
    id: string;
    malicious_url?: string | null;
    malicious_domain?: string | null;
    ip_address?: string | null;
    source_feed: string;
    ioc_value?: string | null;
  }>,
): Promise<HaikuResponse<Array<{ id: string; classification: HaikuClassification }>>> {
  const systemPrompt = `You are a cybersecurity threat classifier. Classify each threat in the batch.
Respond with ONLY a JSON array (no markdown) where each element has:
- id: the threat id
- classification: object with threat_type, confidence (0-100), severity, reasoning, ioc_indicators`;

  const userMessage = `Classify these ${threats.length} threats:\n${JSON.stringify(threats, null, 2)}`;

  return callJsonSafe<Array<{ id: string; classification: HaikuClassification }>>(
    env, ctx, systemPrompt, userMessage,
  );
}

// ─── Campaign Name Generation ────────────────────────────────────

export async function generateCampaignName(
  env: Env,
  ctx: HaikuCallContext,
  campaign: {
    domains?: string[];
    target_brands?: string[];
    threat_types?: string[];
    providers?: string[];
    threat_count?: number;
    ip_count?: number;
  },
): Promise<HaikuResponse<{ name: string }>> {
  const systemPrompt = `You generate short, descriptive threat campaign names (3-6 words) based on cluster metadata.
The name should describe the attack method and target, like "GoDaddy Phishing Kit Network" or "Crypto Exchange Credential Harvest".
Do not use technical IDs, IP addresses, or UUIDs.
Respond with ONLY a JSON object: {"name": "Your Campaign Name Here"}`;

  const userMessage = `Generate a campaign name for this threat cluster:
- Domains: ${(campaign.domains || []).slice(0, 10).join(", ") || "N/A"}
- Target brands: ${(campaign.target_brands || []).join(", ") || "Unknown"}
- Threat types: ${(campaign.threat_types || []).join(", ") || "Mixed"}
- Hosting providers: ${(campaign.providers || []).join(", ") || "Unknown"}
- Threat count: ${campaign.threat_count ?? 0}
- Unique IPs: ${campaign.ip_count ?? 1}`;

  return callJsonSafe<{ name: string }>(env, ctx, systemPrompt, userMessage);
}

// ─── Brand Threat Analysis ───────────────────────────────────────

export interface HaikuBrandAnalysis {
  analysis: string;
  risk_level: string;
  key_findings: string[];
}

export async function analyzeBrandThreats(
  env: Env,
  ctx: HaikuCallContext,
  context: {
    brand_name: string;
    threat_count: number;
    providers: string[];
    domains: string[];
    threat_types: Record<string, number>;
    campaigns: string[];
  },
): Promise<HaikuResponse<HaikuBrandAnalysis>> {
  const types = Object.entries(context.threat_types).map(([k, v]) => `${k} (${v})`).join(", ");
  const systemPrompt = `You are a brand protection analyst. Analyze the threat landscape for the brand and write a concise threat assessment.
Respond with ONLY a JSON object (no markdown) with these fields:
- analysis: a 3-4 sentence threat assessment suitable for a brand protection briefing. Be specific about the attack methodology, infrastructure used, and risk level.
- risk_level: one of "critical", "high", "medium", "low"
- key_findings: array of 2-4 brief key findings`;

  const userMessage = `Analyze the threat landscape for ${context.brand_name}. Based on the data: ${context.threat_count} active phishing threats, hosted across ${context.providers.slice(0, 10).join(", ") || "unknown providers"}, targeting ${context.domains.slice(0, 5).join(", ") || "unknown domains"}. The primary attack types are ${types || "unknown"}. Campaigns: ${context.campaigns.slice(0, 5).join(", ") || "none identified"}. Write a 3-4 sentence threat assessment suitable for a brand protection briefing. Be specific about the attack methodology, infrastructure used, and risk level.`;

  return callJsonSafe<HaikuBrandAnalysis>(env, ctx, systemPrompt, userMessage);
}

// ─── Generic Analysis ────────────────────────────────────────────

export async function analyzeWithHaiku(
  env: Env,
  ctx: HaikuCallContext,
  prompt: string,
  context: Record<string, unknown>,
): Promise<HaikuResponse<{ response: string; structured?: Record<string, unknown> }>> {
  const systemPrompt = `You are a cybersecurity analyst. Analyze the provided data and respond with a JSON object containing:
- response: your analysis as a string
- structured: optional object with any structured findings`;

  const userMessage = `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`;

  return callJsonSafe(env, ctx, systemPrompt, userMessage);
}
