/**
 * Brand Enricher — synchronous AI agent that classifies a brand
 * into a fixed sector taxonomy (finance / tech / ecommerce / …).
 *
 * Wraps the existing classifySector() helper in lib/brand-enricher.ts.
 * The lib function fetches the brand's homepage title (best-effort)
 * for context, then asks Haiku to pick a sector from a fixed list.
 *
 * Phase 3.7 of agent audit. Single short Haiku call (20-token reply
 * cap), highly bounded — the AI can only return one of 15 known
 * strings.
 *
 * The "brand-enricher" agentId is preserved for budget_ledger
 * continuity even though the agent's role is specifically sector
 * classification (the lib function name is more accurate than the
 * agentId; renaming would orphan historical attribution).
 */

import { z } from "zod";
import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { classifySector, SECTORS, type Sector } from "../lib/brand-enricher";

// ─── Input contract ─────────────────────────────────────────────

export const BrandEnricherInputSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+$/, "domain must be lowercase alphanumeric, dots, or hyphens only"),
  brandName: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9 &.,'\-/()]+$/, "brand name must be alphanumeric or simple punctuation"),
});

export type BrandEnricherInput = z.infer<typeof BrandEnricherInputSchema>;

// ─── Output contract ────────────────────────────────────────────

export const BrandEnricherOutputSchema = z.object({
  sector: z.enum(SECTORS),
  /** True iff the AI returned a known sector (vs the lib's
   *  null-on-error path, which we coerce to "other"). */
  aiSucceeded: z.boolean(),
});

export type BrandEnricherOutput = z.infer<typeof BrandEnricherOutputSchema>;

const PROMPT_VERSION = "v1.0.0";

// ─── Agent module ───────────────────────────────────────────────

export const brandEnricherAgent: AgentModule = {
  name: "brand_enricher",
  displayName: "Brand Enricher",
  description: "Synchronous AI agent that classifies brands into a fixed sector taxonomy (Haiku, 20-token bounded reply)",
  color: "#A78BFA",
  trigger: "api",
  requiresApproval: false,
  stallThresholdMinutes: 5,
  parallelMax: 4,
  costGuard: "enforced",
  // Single 20-token reply per call. Volume bound by brand registration
  // rate + Enricher's hourly backfill of unenriched brands.
  budget: { monthlyTokenCap: 1_000_000 },
  // Sync agent — delegates to lib/brand-enricher's classifySector,
  // which does its own SQL via the lib helper.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "active",
  category: "sync",
  pipelinePosition: 28,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const agentOutputs: AgentOutputEntry[] = [];

    const parseResult = BrandEnricherInputSchema.safeParse(ctx.input);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      agentOutputs.push({
        type: "diagnostic",
        summary: `brand_enricher rejected input: ${issues.join("; ")}`,
        severity: "high",
        details: { issues },
      });
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { error: "input_schema_failed", issues },
        agentOutputs,
      };
    }
    const input = parseResult.data;

    let sector: Sector | null = null;
    let aiSucceeded = false;
    try {
      // classifySector returns null on AI failure or unknown reply.
      // The lib function already coerces unknown replies to "other",
      // so any non-null is valid — null only on catastrophic failure
      // (network, throw inside Anthropic helper).
      sector = await classifySector(env, input.domain, input.brandName);
      aiSucceeded = sector !== null;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      agentOutputs.push({
        type: "diagnostic",
        summary: "brand_enricher AI call failed, defaulting to 'other'",
        severity: "medium",
        details: { error: errMsg, promptVersion: PROMPT_VERSION },
      });
    }

    // Coerce null/error to "other" so the handler always gets a
    // valid Sector. Output schema enforces the enum.
    const finalOutput: BrandEnricherOutput = {
      sector: sector ?? "other",
      aiSucceeded,
    };
    const finalParse = BrandEnricherOutputSchema.safeParse(finalOutput);
    if (!finalParse.success) {
      throw new Error(
        `brand_enricher final output failed schema: ${finalParse.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
    }

    return {
      itemsProcessed: 1,
      itemsCreated: 0,
      itemsUpdated: 0,
      output: finalParse.data,
      agentOutputs,
    };
  },
};
