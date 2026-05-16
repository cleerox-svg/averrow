/**
 * Data access layer — sales_leads table.
 *
 * Typed query functions for the Pathfinder agent pipeline.
 * Replaces inline INSERT/UPDATE/SELECT in agents/pathfinder.ts.
 */

import type { SalesLead, CreateLeadInput, EnrichLeadInput, Env } from "../types";

// Re-export for consumers that import from db/sales-leads
export type { SalesLead, CreateLeadInput, EnrichLeadInput };

// ─── Queries ──────────────────────────────────────────────────────

/**
 * Insert a new lead, but only if no active (non-rejected) lead already
 * exists for this brand_id. Returns the new row id, or null when an
 * active lead already exists. This is the only path through which new
 * sales_leads rows should be created — see migration 0191 which adds a
 * partial unique index as the database-level safety net.
 */
export async function createLead(env: Env, input: CreateLeadInput): Promise<number | null> {
  const result = await env.DB.prepare(`
    INSERT INTO sales_leads (
      brand_id, prospect_score, score_breakdown_json, status,
      company_name, company_domain,
      email_security_grade, threat_count_30d, phishing_urls_active,
      trap_catches_30d, composite_risk_score, pitch_angle, findings_summary,
      revenue_band, employee_band, industry_naics, is_public, ticker,
      founded_year, parent_company,
      last_breach_disclosed_at, security_news_headline, security_news_url,
      cyber_10k_mentions,
      identified_by, ai_enriched,
      created_at, updated_at
    )
    SELECT
      ?, ?, ?, 'new',
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?,
      ?, 0,
      datetime('now'), datetime('now')
    WHERE NOT EXISTS (
      SELECT 1 FROM sales_leads
      WHERE brand_id = ? AND status NOT IN ('rejected','declined')
    )
  `).bind(
    input.brand_id,
    input.prospect_score,
    input.score_breakdown_json ?? null,
    input.company_name ?? null,
    input.company_domain ?? null,
    input.email_security_grade ?? null,
    input.threat_count_30d ?? null,
    input.phishing_urls_active ?? null,
    input.trap_catches_30d ?? null,
    input.composite_risk_score ?? null,
    input.pitch_angle ?? null,
    input.findings_summary ?? null,
    input.revenue_band ?? null,
    input.employee_band ?? null,
    input.industry_naics ?? null,
    input.is_public ?? null,
    input.ticker ?? null,
    input.founded_year ?? null,
    input.parent_company ?? null,
    input.last_breach_disclosed_at ?? null,
    input.security_news_headline ?? null,
    input.security_news_url ?? null,
    input.cyber_10k_mentions ?? null,
    input.identified_by ?? 'pathfinder_agent',
    input.brand_id,
  ).run();

  if (result.meta?.changes === 0) {
    return null;
  }
  return result.meta?.last_row_id as number;
}

/**
 * Fetch the highest-scored lead that hasn't been AI-enriched yet.
 * Used by the Prospector's Phase 2 enrichment loop.
 */
export async function getUnenrichedLead(env: Env): Promise<SalesLead | null> {
  return env.DB.prepare(
    "SELECT * FROM sales_leads WHERE ai_enriched = 0 ORDER BY prospect_score DESC LIMIT 1"
  ).first<SalesLead>();
}

/**
 * Mark a lead as AI-enriched. Persists structured fields from the Haiku
 * research JSON into dedicated columns so the UI doesn't have to crack
 * the blob. The blob is still saved for forensics + future reprocessing.
 */
export async function enrichLead(
  env: Env,
  leadId: number,
  data: EnrichLeadInput,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE sales_leads SET
      findings_summary       = ?,
      outreach_variant_1     = ?,
      outreach_variant_2     = ?,
      research_json          = ?,
      company_industry       = COALESCE(?, company_industry),
      company_size           = COALESCE(?, company_size),
      company_hq             = COALESCE(?, company_hq),
      target_name            = COALESCE(?, target_name),
      target_title           = COALESCE(?, target_title),
      target_email           = COALESCE(?, target_email),
      target_linkedin        = COALESCE(?, target_linkedin),
      security_maturity      = COALESCE(?, security_maturity),
      security_news_headline = COALESCE(?, security_news_headline),
      security_news_url      = COALESCE(?, security_news_url),
      last_breach_disclosed_at = COALESCE(?, last_breach_disclosed_at),
      ai_enriched            = 1,
      ai_enriched_at         = datetime('now'),
      researched_at          = datetime('now'),
      updated_at             = datetime('now')
    WHERE id = ?
  `).bind(
    data.findings_summary,
    data.outreach_variant_1,
    data.outreach_variant_2,
    data.research_json,
    data.company_industry ?? null,
    data.company_size ?? null,
    data.company_hq ?? null,
    data.target_name ?? null,
    data.target_title ?? null,
    data.target_email ?? null,
    data.target_linkedin ?? null,
    data.security_maturity ?? null,
    data.security_news_headline ?? null,
    data.security_news_url ?? null,
    data.last_breach_disclosed_at ?? null,
    leadId,
  ).run();
}

/**
 * Reject a lead post-enrichment with a reason. Sets status to 'rejected'
 * and stores the rejection_reason for auditability.
 */
export async function rejectLead(
  env: Env,
  leadId: number,
  reason: string,
  researchJson: string | null = null,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE sales_leads SET
      status = 'rejected',
      rejection_reason = ?,
      research_json = COALESCE(?, research_json),
      ai_enriched = 1,
      ai_enriched_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(reason, researchJson, leadId).run();
}

export async function getLeadById(env: Env, id: number): Promise<SalesLead | null> {
  return env.DB.prepare("SELECT * FROM sales_leads WHERE id = ?")
    .bind(id)
    .first<SalesLead>();
}

export async function getLeadByBrandId(env: Env, brandId: string): Promise<SalesLead | null> {
  return env.DB.prepare(
    "SELECT * FROM sales_leads WHERE brand_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(brandId).first<SalesLead>();
}

/**
 * Copy the latest brand_firmographics row onto a sales_leads row. Used
 * by the manual refresh endpoint when a rep wants to update the lead
 * with the most current revenue/employee/ticker data without rerunning
 * AI enrichment.
 */
export async function refreshLeadFirmographics(env: Env, leadId: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    UPDATE sales_leads SET
      revenue_band   = COALESCE(bf.revenue_band,   sales_leads.revenue_band),
      employee_band  = COALESCE(bf.employee_band,  sales_leads.employee_band),
      industry_naics = COALESCE(bf.industry_naics, sales_leads.industry_naics),
      is_public      = COALESCE(bf.is_public,      sales_leads.is_public),
      ticker         = COALESCE(bf.ticker,         sales_leads.ticker),
      founded_year   = COALESCE(bf.founded_year,   sales_leads.founded_year),
      parent_company = COALESCE(bf.parent_company, sales_leads.parent_company),
      last_breach_disclosed_at = COALESCE(bf.last_breach_disclosed_at, sales_leads.last_breach_disclosed_at),
      security_news_headline   = COALESCE(bf.security_news_headline,   sales_leads.security_news_headline),
      security_news_url        = COALESCE(bf.security_news_url,        sales_leads.security_news_url),
      cyber_10k_mentions       = COALESCE(bf.cyber_10k_mentions,       sales_leads.cyber_10k_mentions),
      updated_at = datetime('now')
    FROM (
      SELECT * FROM brand_firmographics
      WHERE brand_id = (SELECT brand_id FROM sales_leads WHERE id = ?)
    ) AS bf
    WHERE sales_leads.id = ?
  `).bind(leadId, leadId).run();
  return (result.meta?.changes ?? 0) > 0;
}
