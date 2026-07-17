/**
 * Sparrow Phase 3 — AI-Powered Evidence Assembler
 *
 * When a takedown request is created, collects all available intelligence
 * about the target and calls Haiku to generate a structured evidence package
 * suitable for submission to abuse providers.
 */

import type { Env, TakedownRequest } from "../types";
import { runSyncAgent } from "./agentRunner";
import { evidenceAssemblerAgent, type EvidenceAssemblerInput, type EvidenceAssemblerOutput } from "../agents/evidence-assembler";

// ─── Types ──────────────────────────────────────────────────────

export interface EvidencePackage {
  takedown_id: string;
  target_summary: string;
  brand_impact: string;
  technical_evidence: string;
  recommended_action: string;
  provider_submission_draft: string;
  evidence_items: Array<{
    type: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
}

// ─── Main ───────────────────────────────────────────────────────

/**
 * Assemble comprehensive evidence for a takedown request.
 * Collects all available data, then calls Haiku to generate a structured report.
 */
export async function assembleEvidence(
  env: Env,
  takedownId: string,
): Promise<EvidencePackage> {
  // 1. Load the takedown request
  const takedown = await env.DB.prepare(
    "SELECT * FROM takedown_requests WHERE id = ?",
  )
    .bind(takedownId)
    .first<TakedownRequest>();

  if (!takedown) throw new Error(`Takedown ${takedownId} not found`);

  // 2. Collect all available intelligence based on target type
  const intel = await collectIntelligence(env, takedown);

  // 3. Hand the takedown + intel bundle to the evidence_assembler
  //    sync agent. The agent owns the AI call (cost guard, schema
  //    validation, deterministic fallback). Each call lands a
  //    sync agent_runs row so FC supervision and budget_ledger
  //    attribution work uniformly.
  const agentInput: EvidenceAssemblerInput = {
    takedownId,
    targetType: takedown.target_type,
    targetValue: takedown.target_value,
    targetPlatform: takedown.target_platform || null,
    targetUrl: takedown.target_url || null,
    brandJson: truncateJson(intel.brand ?? "Unknown"),
    relatedThreatsJson: truncateJson(intel.related_threats ?? []),
    urlScanJson: truncateJson(intel.url_scan ?? "None"),
    socialProfileJson: truncateJson(intel.social_profile ?? "None"),
    whoisJson: truncateJson(intel.whois ?? "None"),
    existingEvidenceJson: truncateJson(intel.existing_evidence ?? []),
    providerJson: truncateJson(intel.provider ?? "Unknown"),
  };
  const { data: aiReport } = await runSyncAgent<EvidenceAssemblerOutput>(env, evidenceAssemblerAgent, agentInput);
  // The agent always produces a valid output (deterministic fallback
  // path on any AI failure). If `data` is null the agent's input
  // schema rejected our bundle — surface the takedown's existing
  // detail and let the operator inspect it.
  const evidenceText =
    aiReport?.targetSummary ||
    takedown.evidence_detail ||
    "";

  // 4. Save AI evidence report
  await env.DB.prepare(`
    INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
    VALUES (?, ?, 'ai_report', 'AI Evidence Assessment', ?, ?, datetime('now'))
  `).bind(
    crypto.randomUUID(),
    takedownId,
    evidenceText,
    JSON.stringify(aiReport ?? { error: "agent_input_rejected" }),
  ).run();

  // 5. Update takedown with enriched evidence
  const updatedDetail =
    aiReport?.providerSubmissionDraft ||
    aiReport?.targetSummary ||
    takedown.evidence_detail;

  await env.DB.prepare(`
    UPDATE takedown_requests
    SET evidence_detail = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(updatedDetail, takedownId).run();

  // 6. Build response
  return {
    takedown_id: takedownId,
    target_summary: aiReport?.targetSummary || "",
    brand_impact: aiReport?.brandImpact || "",
    technical_evidence: aiReport?.technicalEvidence || "",
    recommended_action: aiReport?.recommendedAction || "",
    provider_submission_draft: aiReport?.providerSubmissionDraft || "",
    evidence_items: (intel.existing_evidence || []).map((e) => ({
      type: (e as Record<string, unknown>).evidence_type as string,
      title: (e as Record<string, unknown>).title as string,
      content: (e as Record<string, unknown>).content_text as string,
    })),
  };
}

// ─── Intel JSON helper ──────────────────────────────────────────
//
// The evidence_assembler agent's input schema length-caps each JSON
// blob to keep the prompt predictable. Truncate here so a brand with
// thousands of related threats doesn't bust the schema and force the
// run to its deterministic fallback.

function truncateJson(value: unknown, maxChars = 7500): string {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= maxChars) return json;
  return json.slice(0, maxChars - 30) + '..."<truncated>"]';
}

// ─── Intelligence Collection ────────────────────────────────────

interface IntelBundle {
  brand?: Record<string, unknown> | null;
  url_scan?: Record<string, unknown> | null;
  social_profile?: Record<string, unknown> | null;
  related_threats?: Record<string, unknown>[];
  threat_count?: number;
  provider?: Record<string, unknown> | null;
  existing_evidence?: Record<string, unknown>[];
  whois?: Record<string, unknown> | null;
}

async function collectIntelligence(
  env: Env,
  takedown: TakedownRequest,
): Promise<IntelBundle> {
  const intel: IntelBundle = {};

  // Run independent queries in parallel
  const [brand, urlScan, socialProfile, threats, provider, existingEvidence, whois] =
    await Promise.all([
      // Brand info
      takedown.brand_id
        ? env.DB.prepare(
            "SELECT name, canonical_domain, email_security_grade, threat_count, exposure_score FROM brands WHERE id = ?",
          ).bind(takedown.brand_id).first()
        : null,

      // URL scan results
      takedown.source_type === "url_scan" && takedown.source_id
        ? env.DB.prepare(
            "SELECT * FROM url_scan_results WHERE id = ?",
          ).bind(takedown.source_id).first()
        : null,

      // Social profile data
      takedown.source_type === "social_profile" && takedown.source_id
        ? env.DB.prepare(
            "SELECT * FROM social_profiles WHERE id = ?",
          ).bind(takedown.source_id).first()
        : null,

      // Related threats for the target domain
      takedown.target_value
        ? env.DB.prepare(`
            SELECT threat_type, severity, source_feed, hosting_provider_id, created_at
            FROM threats
            WHERE (malicious_domain = ? OR malicious_url LIKE ?)
            AND status = 'active'
            ORDER BY created_at DESC LIMIT 20
          `).bind(takedown.target_value, `%${takedown.target_value}%`).all()
        : null,

      // Hosting provider info
      takedown.provider_name
        ? env.DB.prepare(
            "SELECT * FROM takedown_providers WHERE provider_name = ?",
          ).bind(takedown.provider_name).first()
        : null,

      // Existing evidence artifacts
      env.DB.prepare(
        "SELECT * FROM takedown_evidence WHERE takedown_id = ? ORDER BY created_at",
      ).bind(takedown.id).all(),

      // WHOIS / infrastructure data from threats table
      takedown.target_type === "domain" || takedown.target_type === "url"
        ? env.DB.prepare(`
            SELECT registrar, ip_address, asn, country_code
            FROM threats WHERE malicious_domain = ? LIMIT 1
          `).bind(takedown.target_value).first()
        : null,
    ]);

  intel.brand = brand;
  intel.url_scan = urlScan;
  intel.social_profile = socialProfile;
  intel.related_threats = threats?.results as Record<string, unknown>[] | undefined;
  intel.threat_count = threats?.results?.length ?? 0;
  intel.provider = provider;
  intel.existing_evidence = existingEvidence.results as Record<string, unknown>[];
  intel.whois = whois;

  return intel;
}

// AI report generation + prompt building moved to
// agents/evidence-assembler.ts in Phase 4.6 — the agent owns the
// entire AI surface (cost guard, schema validation, deterministic
// fallback). The lib function below stays as the orchestrator that
// collects intel and persists writes.
