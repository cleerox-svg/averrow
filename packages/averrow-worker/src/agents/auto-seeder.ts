/**
 * Recon (auto_seeder) — weekly bulk seeding of spam-trap addresses.
 *
 * Plants synthetic Firstname.Lastname@<honeypot-domain> addresses
 * into seed_addresses, attributed to seeded_location =
 * 'auto-seeder:<domain>:<page>'. The /admin-portal and /internal-staff
 * page handlers (src/index.ts) read this same seeded_location at
 * render time and embed every active row as a visible mailto:
 * link, so the next time a harvester scrapes us they pick up the
 * fresh addresses.
 *
 * Per-page volume: SEEDS_PER_PAGE addresses / week × 2 pages × 52
 * weeks ≈ 600 addresses/year. Plenty of trap surface even before
 * we extend seeding to external paste sites / forums (a follow-up).
 *
 * Cohort tag (YYYYMMDD of run start) is embedded in agent_outputs
 * so an operator can see "this week's batch was N rows" without
 * cross-referencing seed_addresses.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { plantBatch, cohortTag } from "../lib/auto-seeder-planter";

// Default per-page seed count, used when seed_domains.seeds_per_page is NULL.
const DEFAULT_SEEDS_PER_PAGE = 6;

// Fallback used only when seed_domains is empty or unreachable (migration 0181
// not applied, transient D1 error). Keeps the agent from no-oping silently on
// a fresh deploy. After migration 0181 these targets come from D1.
const FALLBACK_TARGETS: Array<{ domain: string; page: string; seedsPerPage: number }> = [
  { domain: "averrow.com", page: "/admin-portal",   seedsPerPage: DEFAULT_SEEDS_PER_PAGE },
  { domain: "averrow.com", page: "/internal-staff", seedsPerPage: DEFAULT_SEEDS_PER_PAGE },
];

interface SeedDomainRow {
  domain:         string;
  pages:          string;
  seeds_per_page: number;
}

async function loadActiveTargets(
  env: AgentContext['env'],
): Promise<Array<{ domain: string; page: string; seedsPerPage: number }>> {
  try {
    const rows = await env.DB.prepare(
      `SELECT domain, pages, seeds_per_page
       FROM seed_domains
       WHERE status = 'active'
       ORDER BY domain ASC`,
    ).all<SeedDomainRow>();
    const out: Array<{ domain: string; page: string; seedsPerPage: number }> = [];
    for (const r of rows.results) {
      const pages = (r.pages ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      const spp = r.seeds_per_page > 0 ? r.seeds_per_page : DEFAULT_SEEDS_PER_PAGE;
      for (const page of pages) {
        out.push({ domain: r.domain, page, seedsPerPage: spp });
      }
    }
    if (out.length > 0) return out;
  } catch {
    // migration 0181 not applied or D1 transient — fall through to fallback.
  }
  return FALLBACK_TARGETS;
}

export const autoSeederAgent: AgentModule = {
  name: "auto_seeder",
  displayName: "Recon",
  description: "Spam-trap seeding agent — plants honeypot addresses into harvester channels and tracks per-location yield",
  color: "#10B981",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 12100,
  parallelMax: 1,
  costGuard: "enforced",
  // No AI calls — auto-seeder plants spam-trap addresses. Cap at 0
  // so the diagnostic flags any unexpected AI spend as a regression.
  budget: { monthlyTokenCap: 0 },
  // Most SQL delegated to lib/auto-seeder-planter; seed_domains read
  // happens inline (loadActiveTargets) for the target list.
  reads: [
    { kind: "d1_table", name: "seed_domains" },
  ],
  writes: [],
  outputs: [{ type: "insight" }, { type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 19,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const tag = cohortTag();
    const outputs: AgentOutputEntry[] = [];
    let totalCreated = 0;
    const perTarget: Array<{ location: string; planted: number }> = [];

    // Wave-2.1 PR-AF: targets now come from seed_domains (operator-
    // editable). Falls back to the legacy hardcoded list when the
    // table is empty or unreachable.
    const targets = await loadActiveTargets(env);

    for (const target of targets) {
      const seedLocationKey = `auto-seeder:${target.domain}:${target.page}`;
      try {
        const planted = await plantBatch(env, {
          domain: target.domain,
          seedLocationKey,
          count: target.seedsPerPage,
          cohortTag: tag,
        });
        totalCreated += planted.length;
        perTarget.push({ location: seedLocationKey, planted: planted.length });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        outputs.push({
          type: "diagnostic",
          summary: `Recon: planting failed for ${seedLocationKey} — ${errMsg}`,
          severity: "high",
          details: { seedLocationKey, error: errMsg },
        });
        perTarget.push({ location: seedLocationKey, planted: 0 });
      }
    }

    outputs.push({
      type: "insight",
      summary: `Recon planted ${totalCreated} spam-trap addresses across ${targets.length} honeypot pages (cohort ${tag})`,
      severity: "info",
      details: { cohortTag: tag, perTarget, target_count: targets.length },
    });

    return {
      itemsProcessed: targets.length,
      itemsCreated: totalCreated,
      itemsUpdated: 0,
      output: { cohortTag: tag, perTarget },
      agentOutputs: outputs,
    };
  },
};
