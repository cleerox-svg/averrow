/**
 * Campaign Hunter tool surface.
 *
 * Read-only tools that wrap the existing deterministic substrate (threats,
 * brands, hosting_providers, lookalike_domains). The agent decides which to
 * call; this module defines the schemas and the prepared-statement dispatch.
 *
 * Read-only by design — the agent can look but not mutate. The only write is
 * persisting its own report at the end of execute(), through the standard
 * agent_outputs path. Every tool input is untrusted and is Zod-validated
 * before it touches the DB; all queries are prepared statements.
 *
 * Phase 1 ships four DB-backed tools + the terminal submit_report. Live
 * external lookups (dns_lookup, whois_lookup) are Phase 2 — see
 * docs/AGENTIC_DEEP_SCAN_SPEC.md §3.3.
 */

import { z } from "zod";
import type { Env } from "../types";
import type { ToolDef } from "./agent-loop";

export const TERMINAL_TOOL = "submit_report";

/** Brand identity resolved once at execute() start and closed over by dispatch. */
export interface HunterBrandContext {
  brandId: string;
  brandName: string;
  brandDomain: string;
}

// ─── Tool definitions (JSON Schema; descriptions are prescriptive about
//     WHEN to call — recent models reach for tools conservatively) ───────

export const HUNTER_TOOLS: ToolDef[] = [
  {
    name: "brand_overview",
    description:
      "Call this FIRST. Returns the brand's known threat count and the timestamp of its most recent threat — the baseline before you pivot to specifics. Takes no input.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "query_brand_threats",
    description:
      "List the brand's recent threats (URL, domain, IP, ASN, country, type, severity, status, feed). Call this to see what infrastructure and patterns are already on record before deciding whether a campaign is active.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max threats to return (default 25)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "provider_history",
    description:
      "Look up a hosting provider's reputation and threat history by ASN or name. Call this when query_brand_threats surfaces a recurring ASN/provider and you want to know if that provider is a known abuse source.",
    input_schema: {
      type: "object",
      properties: {
        asn: { type: "integer", description: "Autonomous System Number to look up." },
        name: { type: "string", description: "Provider name (partial match) to look up." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scan_lookalikes",
    description:
      "Return known lookalike / typosquat domains registered against this brand, with threat level and registration date. Call this to confirm or rule out coordinated domain registration as part of a campaign.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max lookalikes to return (default 25)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: TERMINAL_TOOL,
    description:
      "Call this exactly once, when your investigation is complete, to submit the final structured report. This ends the investigation.",
    input_schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["active_campaign", "isolated_threats", "no_significant_threat"] },
        confidence: { type: "integer", minimum: 0, maximum: 100 },
        summary: { type: "string", description: "2-4 sentence executive summary." },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["lookalike_domain", "shared_infrastructure", "active_phishing", "registration_pattern", "other"],
              },
              evidence: { type: "string" },
              indicators: { type: "array", items: { type: "string" } },
              severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            },
            required: ["type", "evidence", "severity"],
            additionalProperties: false,
          },
        },
        suspected_actor: { type: ["string", "null"] },
        recommended_actions: { type: "array", items: { type: "string" } },
      },
      required: ["verdict", "confidence", "summary", "findings"],
      additionalProperties: false,
    },
  },
];

// ─── Input validation ───────────────────────────────────────────────────

const LimitInput = z.object({ limit: z.number().int().min(1).max(50).optional() });
const ProviderInput = z.object({
  asn: z.number().int().positive().optional(),
  name: z.string().min(1).max(200).optional(),
});

// ─── Report shape (validates the terminal tool payload) ─────────────────

export const HunterReportSchema = z.object({
  verdict: z.enum(["active_campaign", "isolated_threats", "no_significant_threat"]),
  confidence: z.number().int().min(0).max(100),
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      type: z.enum(["lookalike_domain", "shared_infrastructure", "active_phishing", "registration_pattern", "other"]),
      evidence: z.string(),
      indicators: z.array(z.string()).optional(),
      severity: z.enum(["critical", "high", "medium", "low"]),
    }),
  ),
  suspected_actor: z.string().nullable().optional(),
  recommended_actions: z.array(z.string()).optional(),
});

export type HunterReport = z.infer<typeof HunterReportSchema>;

// ─── Dispatch ───────────────────────────────────────────────────────────

/** Build the runTool closure for one investigation. Read-only, prepared
 *  statements only. Returns a JSON string the model reads back. */
export function buildHunterDispatch(
  env: Env,
  brand: HunterBrandContext,
): (name: string, input: unknown) => Promise<string> {
  return async (name: string, input: unknown): Promise<string> => {
    switch (name) {
      case "brand_overview": {
        const row = await env.DB.prepare(
          `SELECT id, name, threat_count, last_threat_seen FROM brands WHERE id = ?`,
        ).bind(brand.brandId).first();
        return JSON.stringify(row ?? { note: "brand not found", brandId: brand.brandId });
      }

      case "query_brand_threats": {
        const { limit = 25 } = LimitInput.parse(input ?? {});
        const rows = await env.DB.prepare(
          `SELECT id, malicious_url, malicious_domain, ip_address, asn, country_code,
                  threat_type, source_feed, status, severity
             FROM threats
            WHERE target_brand_id = ?
            ORDER BY rowid DESC
            LIMIT ?`,
        ).bind(brand.brandId, limit).all();
        return JSON.stringify({ count: rows.results?.length ?? 0, threats: rows.results ?? [] });
      }

      case "provider_history": {
        const { asn, name: providerName } = ProviderInput.parse(input ?? {});
        if (asn === undefined && !providerName) {
          return JSON.stringify({ error: "provide asn or name" });
        }
        const rows = await env.DB.prepare(
          `SELECT id, name, asn, country, reputation_score,
                  active_threat_count, total_threat_count, trend_7d
             FROM hosting_providers
            WHERE (?1 IS NOT NULL AND asn = ?1)
               OR (?2 IS NOT NULL AND name LIKE ?2)
            LIMIT 5`,
        ).bind(asn ?? null, providerName ? `%${providerName}%` : null).all();
        return JSON.stringify({ count: rows.results?.length ?? 0, providers: rows.results ?? [] });
      }

      case "scan_lookalikes": {
        const { limit = 25 } = LimitInput.parse(input ?? {});
        const rows = await env.DB.prepare(
          `SELECT * FROM lookalike_domains
            WHERE brand_id = ?
            ORDER BY threat_level DESC, created_at DESC
            LIMIT ?`,
        ).bind(brand.brandId, limit).all();
        return JSON.stringify({ count: rows.results?.length ?? 0, lookalikes: rows.results ?? [] });
      }

      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  };
}
