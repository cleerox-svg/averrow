// Averrow — Workers AI (Cloudflare open models) — minimal JSON helper
//
// AI_STRATEGY_2026-10 Tier 1, first and (for now) only consumer: the abuse
// mailbox second opinion (lib/abuse-mailbox-classifier.ts). Workers AI is
// billed postpaid on the Cloudflare account, so unlike the prepaid
// Anthropic credit it cannot silently run dry.
//
// Gate: its OWN switch, independent of AI_MODE. AI_MODE=rules_only blocks
// callAnthropic (lib/anthropic.ts); it says nothing about Workers AI. The
// abuse mailbox uses Workers AI only when BOTH hold:
//   - the `AI` binding is present (wrangler.toml [ai]), and
//   - ABUSE_AI_PROVIDER = "workers_ai".
// Unset / any other value → Workers AI is never called (kill switch:
// flip the var, no code change).
//
// Requests go through the existing `averrow-ai-gateway` AI Gateway, so they
// show up in the same logs / analytics / spend limits as the Anthropic path.

import type { Env } from "../types";

/** 70B is the floor for adversarial phishing text; the 8B models are cheap
 *  but easily talked out of a verdict by the email body. */
export const ABUSE_WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const AI_GATEWAY_ID = "averrow-ai-gateway";

export function isAbuseWorkersAiEnabled(env: Env): boolean {
  return !!env.AI && env.ABUSE_AI_PROVIDER === "workers_ai";
}

export class WorkersAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkersAiError";
  }
}

/** Pull the first JSON object out of a model response (string or object). */
export function extractJsonObject(response: unknown): unknown {
  if (response && typeof response === "object") return response;
  if (typeof response !== "string") return null;
  const start = response.indexOf("{");
  const end = response.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(response.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * One chat completion in JSON mode. Returns the parsed object, or throws
 * WorkersAiError (binding missing, transport error, unparseable output).
 */
export async function runWorkersAiJson(
  env: Env,
  opts: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    maxTokens?: number;
    /** Tag for AI Gateway analytics (letters, digits, `:-./@`). */
    tag: string;
  },
): Promise<unknown> {
  const ai = env.AI;
  if (!ai) throw new WorkersAiError("workers_ai_unavailable: AI binding not configured");
  let out: unknown;
  try {
    out = await ai.run(
      ABUSE_WORKERS_AI_MODEL,
      {
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        max_tokens: opts.maxTokens ?? 256,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: opts.jsonSchema },
      },
      { gateway: { id: AI_GATEWAY_ID, skipCache: true }, tags: [opts.tag] },
    );
  } catch (err) {
    throw new WorkersAiError(`workers_ai_error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
  }
  const response = out && typeof out === "object" && "response" in out
    ? (out as { response: unknown }).response
    : out;
  const parsed = extractJsonObject(response);
  if (!parsed) throw new WorkersAiError("parse_error: Workers AI output was not a JSON object");
  return parsed;
}

/**
 * Count one call against a per-consumer daily cap (UTC day, KV). Returns
 * false once the cap is reached. Best-effort: KV is eventually consistent,
 * so concurrent isolates can overshoot slightly; a KV failure fails CLOSED
 * (no call) because the alternative is unbounded postpaid spend.
 */
export async function reserveWorkersAiCall(env: Env, consumer: string, cap: number): Promise<boolean> {
  if (!env.CACHE) return false;
  const day = new Date().toISOString().slice(0, 10);
  const key = `workers_ai:calls:${consumer}:${day}`;
  try {
    const used = Number((await env.CACHE.get(key)) ?? "0") || 0;
    if (used >= cap) return false;
    await env.CACHE.put(key, String(used + 1), { expirationTtl: 2 * 86_400 });
    return true;
  } catch {
    return false;
  }
}
