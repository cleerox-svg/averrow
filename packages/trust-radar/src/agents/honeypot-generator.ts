/**
 * Honeypot Generator — synchronous batch AI agent that renders a
 * complete honeypot website (index + contact + team pages) with
 * embedded trap mailto links via three parallel Haiku calls.
 *
 * Wraps the existing pure-function generator in lib/honeypot-generator.ts
 * — implementation stays put, this module owns the lifecycle (input
 * validation, output bounds, agent_runs row, agent_outputs diagnostic
 * on partial-page failure).
 *
 * Phase 3.6 of agent audit. Sixth sync-agent migration.
 *
 * Single agent run = three internal AI calls (one per page). Per-call
 * cost guard already enforced inside callAnthropicText. Run-level
 * lifecycle covers all three pages.
 */

import { z } from "zod";
import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { generateHoneypotSite } from "../honeypot-generator";

// ─── Input contract ─────────────────────────────────────────────

export const HoneypotGeneratorInputSchema = z.object({
  hostname: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+$/, "hostname must be lowercase alphanumeric, dots, or hyphens only"),
  businessName: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9 &.,'\-/()]+$/, "business name must be alphanumeric or simple punctuation"),
  businessType: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[A-Za-z0-9 &.,'\-/()]+$/, "business type must be alphanumeric or simple punctuation"),
  city: z
    .string()
    .min(2)
    .max(120)
    .regex(/^[A-Za-z0-9 ,.\-]+$/, "city must be alphanumeric, commas, periods, or hyphens"),
  trapAddresses: z.array(
    z.object({
      address: z.string().min(3).max(254),
      role: z.string().min(1).max(40),
      displayName: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z0-9 &.,'\-]+$/)
        .optional(),
    }),
  ).min(1).max(40),
  teamMembers: z.array(
    z.object({
      name: z.string().min(1).max(80).regex(/^[A-Za-z0-9 &.,'\-]+$/),
      title: z.string().min(1).max(120).regex(/^[A-Za-z0-9 &.,'\-/()]+$/),
      email: z.string().min(3).max(254),
    }),
  ).min(1).max(40),
});

export type HoneypotGeneratorInput = z.infer<typeof HoneypotGeneratorInputSchema>;

// ─── Output contract ────────────────────────────────────────────
//
// Validates the AI returned recognisable HTML, but doesn't try to
// parse it — too brittle. We check three things:
//   - non-empty
//   - bounded length (avoid runaway responses)
//   - contains <!DOCTYPE html> (proof the AI followed format
//     instructions)
//
// Per-page failure is OK — the run can still succeed if one page
// renders deterministically. Catastrophic failure (all 3 fail)
// throws upstream → run marked 'failed'.

const HtmlPageSchema = z
  .string()
  .min(200)
  .max(120_000)
  .refine(
    (s) => /<!DOCTYPE\s+html>/i.test(s),
    "page must start with <!DOCTYPE html>",
  );

export const HoneypotGeneratorOutputSchema = z.object({
  index: HtmlPageSchema,
  contact: HtmlPageSchema,
  team: HtmlPageSchema,
  sitemap: z.string().min(1).max(8000),
  robots: z.string().min(1).max(2000),
  /** True iff every page parsed cleanly and contains a mailto: link
   *  for at least one of the trap addresses. False on any partial. */
  aiSucceeded: z.boolean(),
});

export type HoneypotGeneratorOutput = z.infer<typeof HoneypotGeneratorOutputSchema>;

const PROMPT_VERSION = "v1.0.0";

// ─── Agent module ───────────────────────────────────────────────

export const honeypotGeneratorAgent: AgentModule = {
  name: "honeypot_generator",
  displayName: "Honeypot Generator",
  description: "Synchronous batch AI agent — renders complete honeypot trap websites (index + contact + team pages, Haiku × 3 in parallel)",
  color: "#F472B6",
  trigger: "api",
  requiresApproval: false,
  stallThresholdMinutes: 10,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 5_000_000 },
  // Sync agent — pure AI rendering, no D1 surface.
  reads: [],
  writes: [],
  outputs: [{ type: "diagnostic" }],
  status: "retired",  // PR-P 2026-05-14: zero real usage in 14d (last call 2026-04-30 from a one-time test harness). Doc-only retirement — file + API route intact, re-activate by flipping status back.
  category: "sync",
  pipelinePosition: 27,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const agentOutputs: AgentOutputEntry[] = [];

    // ── Input schema gate ──────────────────────────────────────
    const parseResult = HoneypotGeneratorInputSchema.safeParse(ctx.input);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      agentOutputs.push({
        type: "diagnostic",
        summary: `honeypot_generator rejected input: ${issues.join("; ")}`,
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

    // ── Generate (delegates to lib/honeypot-generator.ts) ──────
    let site: Awaited<ReturnType<typeof generateHoneypotSite>>;
    try {
      site = await generateHoneypotSite(ctx.env, input);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // The lib function calls Haiku 3× in parallel — if one of them
      // throws, all of them propagate (Promise.all). Mark run failed.
      throw new Error(`honeypot_generator render failed: ${errMsg}`);
    }

    // ── Output schema gate (per-page) ──────────────────────────
    const candidate: HoneypotGeneratorOutput = {
      index: site.index,
      contact: site.contact,
      team: site.team,
      sitemap: site.sitemap,
      robots: site.robots,
      // Will be downgraded if any page fails the schema check below.
      aiSucceeded: true,
    };

    const finalParse = HoneypotGeneratorOutputSchema.safeParse(candidate);
    if (!finalParse.success) {
      const issues = finalParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      agentOutputs.push({
        type: "diagnostic",
        summary: `honeypot_generator output failed schema: ${issues.join("; ")}`,
        severity: "high",
        details: {
          issues,
          page_lengths: {
            index: site.index?.length ?? 0,
            contact: site.contact?.length ?? 0,
            team: site.team?.length ?? 0,
          },
          promptVersion: PROMPT_VERSION,
        },
      });
      // Schema failure on Haiku-generated HTML means the AI returned
      // unusable output — caller can't ship malformed HTML to the
      // honeypot domain. Throw upstream so the run is marked
      // 'failed' and the operator sees it.
      throw new Error(
        `honeypot_generator output failed schema: ${issues.slice(0, 3).join("; ")}`,
      );
    }

    return {
      itemsProcessed: 3, // 3 pages rendered
      itemsCreated: 1,   // 1 site bundle
      itemsUpdated: 0,
      output: finalParse.data,
      agentOutputs,
    };
  },
};
