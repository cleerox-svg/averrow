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
import { callAnthropic, callAnthropicJSON, AnthropicError } from "./anthropic";
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
  reasoning: string;
  ioc_indicators: string[];
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

export interface HaikuProviderScore {
  provider_name: string;
  reputation_score: number; // 0-100
  // Prose fields are only requested when reputation_score < 70 — see
  // scoreProvider() prompt. Cartographer's call site at agents/cartographer.ts
  // also only consumes them on the < 70 path (line 733). Marked optional
  // so the high-score path doesn't have to fake them.
  reasoning?: string;
  risk_factors?: string[];
  response_assessment?: string;
}

interface HaikuResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  model?: string;
  tokens_used?: number;
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
  // Global AI throttle gate — covers every agent on the hot path.
  const throttled = await isAiThrottled(env);
  if (throttled) {
    return { success: false, error: `throttled: ${throttled}` };
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
    return { success: false, error: msg };
  }
}

// ─── Raw text caller (for YES/NO style prompts) ─────────────────

export async function callHaikuRaw(
  env: Env,
  ctx: HaikuCallContext,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 16,
): Promise<{ success: boolean; text?: string; error?: string; tokens_used?: number }> {
  // Global AI throttle gate — same path as callJsonSafe.
  const throttled = await isAiThrottled(env);
  if (throttled) {
    return { success: false, error: `throttled: ${throttled}` };
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
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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
  const systemPrompt = `You are a cybersecurity threat classifier. Analyze the given threat indicator and classify it.
Respond with ONLY a JSON object (no markdown, no explanation outside the JSON) with these fields:
- threat_type: one of "phishing", "typosquatting", "impersonation", "malware_distribution", "credential_harvesting"
- confidence: number 0-100
- severity: one of "critical", "high", "medium", "low", "info"
- reasoning: brief explanation
- ioc_indicators: array of notable IOC patterns found`;

  const userMessage = `Classify this threat:
- URL: ${threat.malicious_url ?? "N/A"}
- Domain: ${threat.malicious_domain ?? "N/A"}
- IP: ${threat.ip_address ?? "N/A"}
- Source Feed: ${threat.source_feed}
- IOC Value: ${threat.ioc_value ?? "N/A"}`;

  return callJsonSafe<HaikuClassification>(env, ctx, systemPrompt, userMessage);
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

// ─── Provider Reputation Scoring ─────────────────────────────────

export async function scoreProvider(
  env: Env,
  ctx: HaikuCallContext,
  provider: {
    name: string;
    asn: string | null;
    active_threats: number;
    total_threats: number;
    avg_response_time: number | null;
    threat_types: Record<string, number>;
    trend_7d: number;
    trend_30d: number;
  },
): Promise<HaikuResponse<HaikuProviderScore>> {
  // Conditional verbosity (Lever #1 of the AI cost-reduction plan):
  // ~70% of providers score >= 70 and the prose fields go straight in
  // the bin at agents/cartographer.ts:733 (only emitted to outputs[]
  // when score < 70 OR repeatOffender). Asking the model for them
  // anyway was paying for tokens we throw away. On Haiku 4.5, output
  // is 5x input — output tokens were 83% of cartographer's bill.
  //
  // New prompt: score-only when low risk, full breakdown when notable.
  // maxTokens dropped 1024 -> 384 to cap the verbose path (typical
  // verbose response is ~250 tokens, leaving 50% headroom).
  const systemPrompt = `You are a hosting provider reputation analyst. Score the hosting provider based on their threat hosting metrics.

Respond with ONLY a JSON object (no markdown, no prose outside the JSON).

If reputation_score >= 70 (low risk, "looks fine"):
  {"provider_name":"...","reputation_score":NN}
  Omit reasoning, risk_factors, response_assessment entirely.

If reputation_score < 70 (notable risk):
  {"provider_name":"...","reputation_score":NN,"reasoning":"<= 1 sentence, <= 200 chars","risk_factors":["...", "..."],"response_assessment":"<= 1 sentence, <= 150 chars"}
  Cap risk_factors at 3 items. Each item <= 60 chars. No filler.

100 = excellent abuse response, no recent threats. 0 = bulletproof / non-responsive / heavy threat hosting.`;

  const userMessage = `Score this hosting provider's reputation:
${JSON.stringify(provider, null, 2)}`;

  return callJsonSafe<HaikuProviderScore>(env, ctx, systemPrompt, userMessage, 384);
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
