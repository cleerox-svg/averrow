/**
 * Pathfinder Agent — Sales intelligence & lead generation pipeline.
 *
 * Two-phase architecture to prevent Worker timeouts:
 *
 *   Phase 1 — identifyAndCreate():
 *     Score brands from platform data, insert qualified leads immediately.
 *     No AI calls. Completes in < 10s for 10+ brands.
 *
 *   Phase 2 — enrichLeadWithAI():
 *     Pick up ONE unenriched lead, call Haiku for summary + outreach + research,
 *     then mark it enriched. Separate execution, 25s timeout guard.
 *
 * The main run() calls both phases on every cron tick, so leads are created fast
 * and enriched incrementally over subsequent runs.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import type { Env } from "../types";
import { getBrandSocialIntel } from "../lib/social-intel";
import { HOT_PATH_HAIKU } from "../lib/ai-models";
import { createLead, getUnenrichedLead, enrichLead, rejectLead } from "../db/sales-leads";
import { callAnthropicJSON, AnthropicError } from "../lib/anthropic";

// ─── Types ──────────────────────────────────────────────────────

interface ProspectCandidate {
  brand_id: string;
  brand_name: string;
  brand_domain: string;
  prospect_score: number;
  score_breakdown: Record<string, number>;
  email_security_grade: string | null;
  threat_count_30d: number;
  phishing_urls_active: number;
  trap_catches_30d: number;
  composite_risk_score: number | null;
  pitch_angle: string;
  findings_summary: string;
  // Firmographic + buying-signal snapshot — pulled from brand_firmographics
  // at candidate-build time, persisted onto the sales_leads row by createLead.
  revenue_band: string | null;
  employee_band: string | null;
  industry_naics: string | null;
  is_public: number | null;
  ticker: string | null;
  founded_year: number | null;
  parent_company: string | null;
  last_breach_disclosed_at: string | null;
  security_news_headline: string | null;
  security_news_url: string | null;
  cyber_10k_mentions: number | null;
}


// ─── Scoring weights ────────────────────────────────────────────

const SCORING = {
  email_grade_f_or_d: 30,
  email_grade_c: 15,
  dmarc_none_or_missing: 20,
  active_phishing_urls: 25,
  spam_trap_catches: 20,
  high_risk_score: 15,
  ai_phishing_detected: 10,
  tranco_top_10k: 10,
  multiple_campaigns: 15,
  recent_risk_spike: 10,
  social_impersonation: 15,
  social_high_risk: 10,
  social_takedown_needed: 10,
  // Buying-signal boosts — evidence the brand cares about the problem.
  // Free public data (SEC 10-K, news disclosures), not paid intent data.
  recent_breach_disclosure: 25,   // disclosed breach in last 180 days
  cyber_10k_disclosure_high: 10,  // 10+ cybersecurity mentions in latest 10-K
  recent_security_news: 5,        // any security-tagged news mention
};

const BREACH_LOOKBACK_DAYS = 180;
const CYBER_10K_MENTION_THRESHOLD = 10;

const MODEL = HOT_PATH_HAIKU;
const MAX_IDENTIFIED = 20;
const MIN_SCORE = 35;
const AI_TIMEOUT_MS = 25000;

/**
 * Tranco rank boundaries for targeting. Brands ranked higher than
 * MIN_TRANCO_RANK are Fortune-100 caliber enterprises with massive
 * security teams — they won't procure from a startup. Brands ranked
 * lower than MAX_TRANCO_RANK already appear in the SQL WHERE clause.
 */
const MIN_TRANCO_RANK = 500;

/**
 * Subdomain hosts that indicate a preview/dev/squatting domain rather
 * than the canonical brand domain. A "brand" whose canonical_domain
 * sits on webflow.io / vercel.app / etc. is almost always a phishing
 * lookalike that the brand-matcher misclassified — selling to it makes
 * no sense. Production confirmed `coeensquarelogin.webflow.io` was
 * being surfaced as a Square lead.
 */
const PREVIEW_HOST_SUFFIXES = [
  ".webflow.io",
  ".netlify.app",
  ".vercel.app",
  ".pages.dev",
  ".github.io",
  ".replit.app",
  ".glitch.me",
  ".codesandbox.io",
  ".firebaseapp.com",
  ".herokuapp.com",
];

function isPreviewHost(domain: string): boolean {
  const lower = domain.toLowerCase();
  return PREVIEW_HOST_SUFFIXES.some(s => lower.endsWith(s));
}

/**
 * Domains belonging to hosting providers, CDNs, registrars, and
 * infrastructure companies. These are entities we *track* as providers
 * in the platform, not companies we sell to.
 */
const SERVICE_PROVIDER_DOMAINS = new Set([
  // Cloud / hosting
  "cloudflare.com", "amazonaws.com", "aws.amazon.com", "azure.microsoft.com",
  "cloud.google.com", "digitalocean.com", "linode.com", "vultr.com",
  "hetzner.com", "ovh.com", "ovhcloud.com", "ionos.com", "hostinger.com",
  "bluehost.com", "siteground.com", "dreamhost.com", "a2hosting.com",
  "inmotionhosting.com", "hostgator.com", "liquidweb.com", "rackspace.com",
  "kamatera.com", "contabo.com", "scaleway.com", "upcloud.com",
  // CDN / edge
  "akamai.com", "fastly.com", "cdn77.com", "stackpath.com", "bunny.net",
  "cloudfront.net", "keycdn.com",
  // Registrars
  "godaddy.com", "namecheap.com", "name.com", "enom.com", "tucows.com",
  "epik.com", "dynadot.com", "porkbun.com", "hover.com", "gandi.net",
  "register.com", "networksolutions.com",
  // Security / cybersecurity vendors
  "crowdstrike.com", "paloaltonetworks.com", "fortinet.com", "zscaler.com",
  "sentinelone.com", "trellix.com", "sophos.com", "kaspersky.com",
  "bitdefender.com", "malwarebytes.com", "nortonlifelock.com", "mcafee.com",
  "proofpoint.com", "mimecast.com", "barracuda.com", "knowbe4.com",
  "rapid7.com", "qualys.com", "tenable.com", "cyberark.com",
  // DNS / domain services
  "dnsimple.com", "dnsmadeeasy.com", "cloudns.net", "ns1.com",
  // Mega-tech (security teams too large, won't procure)
  "google.com", "microsoft.com", "apple.com", "amazon.com", "meta.com",
  "facebook.com", "netflix.com", "oracle.com", "ibm.com", "cisco.com",
  "intel.com", "nvidia.com", "salesforce.com", "adobe.com", "vmware.com",
]);

// ─── Haiku JSON helper ───────────────────────────────────────────
// Thin envelope around the canonical Anthropic wrapper. Preserves
// the legacy { success, data, error } shape used by the call sites
// below so the rest of this file is unchanged. Cost attribution +
// budget_ledger writes happen automatically inside callAnthropicJSON.

async function callHaikuJSON<T>(
  env: Env,
  runId: string | null,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 1024,
  tools?: unknown[],
): Promise<{ success: boolean; data?: T; error?: string; tokens_used?: number }> {
  try {
    const { parsed, response } = await callAnthropicJSON<T>(env, {
      agentId: "pathfinder",
      runId,
      model: MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      maxTokens,
      tools,
      timeoutMs: AI_TIMEOUT_MS,
    });
    return {
      success: true,
      data: parsed,
      tokens_used: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    };
  } catch (err) {
    const msg = err instanceof AnthropicError ? err.message : err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// ─── Phase 1: Identify & Create ─────────────────────────────────

export async function identifyAndCreate(env: Env): Promise<{
  candidates_found: number;
  leads_created: number;
  errors: number;
}> {
  // Get brands with their latest email security grade, excluding already-monitored
  // orgs and leads created in the last 90 days
  // Pull candidates with firmographics joined. The outer-join semantics
  // retain brands without firmographic rows — they just have NULLs that
  // the UI hides. Buying-signal columns (cyber_10k_mentions, breach,
  // recent news) live on the same row and ride along for free.
  let emailGrades: { results: Array<{
    brand_id: string; brand_name: string; brand_domain: string;
    tranco_rank: number | null; email_security_grade: string | null; dmarc_policy: string | null;
    revenue_band: string | null; employee_band: string | null;
    industry_naics: string | null; is_public: number | null; ticker: string | null;
    founded_year: number | null; parent_company: string | null;
    last_breach_disclosed_at: string | null;
    security_news_headline: string | null; security_news_url: string | null;
    cyber_10k_mentions: number | null;
  }> };

  try {
    emailGrades = await env.DB.prepare(`
      SELECT
        b.id as brand_id,
        b.name as brand_name,
        b.canonical_domain as brand_domain,
        b.tranco_rank,
        ess.email_security_grade,
        ess.dmarc_policy,
        bf.revenue_band,
        bf.employee_band,
        bf.industry_naics,
        bf.is_public,
        bf.ticker,
        bf.founded_year,
        bf.parent_company,
        bf.last_breach_disclosed_at,
        bf.security_news_headline,
        bf.security_news_url,
        bf.cyber_10k_mentions
      FROM brands b
      LEFT JOIN email_security_scans ess ON ess.brand_id = b.id
        AND ess.scanned_at = (
          SELECT MAX(scanned_at) FROM email_security_scans
          WHERE brand_id = b.id
        )
      LEFT JOIN brand_firmographics bf ON bf.brand_id = b.id
      WHERE b.id NOT IN (SELECT brand_id FROM org_brands)
        AND b.id NOT IN (
          SELECT brand_id FROM sales_leads
          WHERE status NOT IN ('rejected','declined')
             OR created_at > datetime('now', '-90 days')
        )
        AND (b.threat_count > 0 OR b.tranco_rank <= 50000)
        AND (b.tranco_rank IS NULL OR b.tranco_rank > ${MIN_TRANCO_RANK})
      ORDER BY b.threat_count DESC, b.tranco_rank ASC
      LIMIT 500
    `).all<{
      brand_id: string; brand_name: string; brand_domain: string;
      tranco_rank: number | null; email_security_grade: string | null; dmarc_policy: string | null;
      revenue_band: string | null; employee_band: string | null;
      industry_naics: string | null; is_public: number | null; ticker: string | null;
      founded_year: number | null; parent_company: string | null;
      last_breach_disclosed_at: string | null;
      security_news_headline: string | null; security_news_url: string | null;
      cyber_10k_mentions: number | null;
    }>();
  } catch (err) {
    throw err;
  }

  if (!emailGrades.results.length) {
    return { candidates_found: 0, leads_created: 0, errors: 0 };
  }

  // Filter out service providers, hosting companies, mega-tech, and
  // preview-host typosquats (e.g. coeensquarelogin.webflow.io that the
  // brand-matcher mistakenly labelled as "Square").
  const filteredBrands = emailGrades.results.filter(b => {
    const domain = b.brand_domain?.toLowerCase();
    if (!domain) return true; // keep brands without domain for scoring
    if (SERVICE_PROVIDER_DOMAINS.has(domain)) return false;
    if (isPreviewHost(domain)) return false;
    return true;
  });
  emailGrades.results = filteredBrands;

  // Parallel lookups for scoring signals
  const [threatCounts, phishingSignals, trapCatches, riskScores, prevRiskScores, aiPhishing, campaignCounts] =
    await Promise.all([
      env.DB.prepare(`
        SELECT target_brand_id as brand_id,
               COUNT(*) as threat_count,
               SUM(CASE WHEN threat_type = 'phishing' THEN 1 ELSE 0 END) as phishing_count
        FROM threats
        WHERE created_at >= datetime('now', '-30 days')
          AND target_brand_id IS NOT NULL
        GROUP BY target_brand_id
      `).all<{ brand_id: string; threat_count: number; phishing_count: number }>(),

      env.DB.prepare(`
        SELECT brand_match_id, COUNT(*) as signal_count
        FROM threat_signals
        WHERE signal_type = 'phishing_url'
          AND created_at >= datetime('now', '-30 days')
          AND brand_match_id IS NOT NULL
        GROUP BY brand_match_id
      `).all<{ brand_match_id: string; signal_count: number }>(),

      env.DB.prepare(`
        SELECT spoofed_brand_id, COUNT(*) as catch_count
        FROM spam_trap_captures
        WHERE captured_at >= datetime('now', '-30 days')
          AND spoofed_brand_id IS NOT NULL
        GROUP BY spoofed_brand_id
      `).all<{ spoofed_brand_id: string; catch_count: number }>(),

      env.DB.prepare(`
        SELECT brand_id, composite_risk_score
        FROM brand_threat_assessments
        WHERE id IN (
          SELECT id FROM brand_threat_assessments bta2
          WHERE bta2.brand_id = brand_threat_assessments.brand_id
          ORDER BY bta2.assessed_at DESC LIMIT 1
        )
      `).all<{ brand_id: string; composite_risk_score: number }>(),

      env.DB.prepare(`
        SELECT brand_id, composite_risk_score
        FROM brand_threat_assessments
        WHERE id IN (
          SELECT id FROM brand_threat_assessments bta2
          WHERE bta2.brand_id = brand_threat_assessments.brand_id
          ORDER BY bta2.assessed_at DESC LIMIT 1 OFFSET 1
        )
      `).all<{ brand_id: string; composite_risk_score: number }>(),

      env.DB.prepare(`
        SELECT brand_targeted, COUNT(*) as ai_count
        FROM phishing_pattern_signals
        WHERE ai_generated_probability > 0.7
          AND created_at >= datetime('now', '-30 days')
          AND brand_targeted IS NOT NULL
        GROUP BY brand_targeted
      `).all<{ brand_targeted: string; ai_count: number }>(),

      env.DB.prepare(`
        SELECT target_brand_id as brand_id, COUNT(DISTINCT campaign_id) as campaign_count
        FROM threats
        WHERE created_at >= datetime('now', '-30 days')
          AND target_brand_id IS NOT NULL
          AND campaign_id IS NOT NULL
        GROUP BY target_brand_id
      `).all<{ brand_id: string; campaign_count: number }>(),
    ]);

  const threatMap = new Map(threatCounts.results.map(r => [r.brand_id, r]));
  const phishMap = new Map(phishingSignals.results.map(r => [r.brand_match_id, r.signal_count]));
  const trapMap = new Map(trapCatches.results.map(r => [r.spoofed_brand_id, r.catch_count]));
  const riskMap = new Map(riskScores.results.map(r => [r.brand_id, r.composite_risk_score]));
  const prevRiskMap = new Map(prevRiskScores.results.map(r => [r.brand_id, r.composite_risk_score]));
  const aiMap = new Map(aiPhishing.results.map(r => [r.brand_targeted, r.ai_count]));
  const campaignMap = new Map(campaignCounts.results.map(r => [r.brand_id, r.campaign_count]));

  // Pass 1: score using only in-memory maps (cheap)
  const initialCandidates: Array<{
    brand: typeof emailGrades.results[number];
    breakdown: Record<string, number>;
    score: number;
  }> = [];

  for (const brand of emailGrades.results) {
    const breakdown: Record<string, number> = {};
    let score = 0;

    const grade = brand.email_security_grade?.toUpperCase();
    if (grade === 'F' || grade === 'D') {
      breakdown.email_grade_f_or_d = SCORING.email_grade_f_or_d;
      score += SCORING.email_grade_f_or_d;
    } else if (grade === 'C') {
      breakdown.email_grade_c = SCORING.email_grade_c;
      score += SCORING.email_grade_c;
    }

    const dmarc = brand.dmarc_policy?.toLowerCase();
    if (!dmarc || dmarc === 'none') {
      breakdown.dmarc_none_or_missing = SCORING.dmarc_none_or_missing;
      score += SCORING.dmarc_none_or_missing;
    }

    const phishCount = phishMap.get(brand.brand_id) ?? 0;
    if (phishCount > 0) {
      breakdown.active_phishing_urls = SCORING.active_phishing_urls;
      score += SCORING.active_phishing_urls;
    }

    const trapCount = trapMap.get(brand.brand_id) ?? 0;
    if (trapCount > 0) {
      breakdown.spam_trap_catches = SCORING.spam_trap_catches;
      score += SCORING.spam_trap_catches;
    }

    const riskScore = riskMap.get(brand.brand_id);
    if (riskScore && riskScore > 60) {
      breakdown.high_risk_score = SCORING.high_risk_score;
      score += SCORING.high_risk_score;
    }

    const aiCount = aiMap.get(brand.brand_id) ?? 0;
    if (aiCount > 0) {
      breakdown.ai_phishing_detected = SCORING.ai_phishing_detected;
      score += SCORING.ai_phishing_detected;
    }

    if (brand.tranco_rank && brand.tranco_rank <= 10000) {
      breakdown.tranco_top_10k = SCORING.tranco_top_10k;
      score += SCORING.tranco_top_10k;
    }

    const campCount = campaignMap.get(brand.brand_id) ?? 0;
    if (campCount >= 3) {
      breakdown.multiple_campaigns = SCORING.multiple_campaigns;
      score += SCORING.multiple_campaigns;
    }

    const prevScore = prevRiskMap.get(brand.brand_id);
    if (riskScore && prevScore && riskScore - prevScore >= 20) {
      breakdown.recent_risk_spike = SCORING.recent_risk_spike;
      score += SCORING.recent_risk_spike;
    }

    // Buying-signal boosts — these don't change targeting, but a brand
    // that just disclosed a breach or talks about cybersecurity in its
    // 10-K is materially more likely to procure.
    if (brand.last_breach_disclosed_at) {
      const disclosedAt = Date.parse(brand.last_breach_disclosed_at);
      if (Number.isFinite(disclosedAt)) {
        const ageDays = (Date.now() - disclosedAt) / 86_400_000;
        if (ageDays >= 0 && ageDays <= BREACH_LOOKBACK_DAYS) {
          breakdown.recent_breach_disclosure = SCORING.recent_breach_disclosure;
          score += SCORING.recent_breach_disclosure;
        }
      }
    }
    if (brand.cyber_10k_mentions != null && brand.cyber_10k_mentions >= CYBER_10K_MENTION_THRESHOLD) {
      breakdown.cyber_10k_disclosure_high = SCORING.cyber_10k_disclosure_high;
      score += SCORING.cyber_10k_disclosure_high;
    }
    if (brand.security_news_headline) {
      breakdown.recent_security_news = SCORING.recent_security_news;
      score += SCORING.recent_security_news;
    }

    initialCandidates.push({ brand, breakdown, score });
  }

  // Sort and take top N for social intel enrichment (bounded D1 queries)
  const SOCIAL_INTEL_BUDGET = 100;
  initialCandidates.sort((a, b) => b.score - a.score);
  const topForSocial = initialCandidates.slice(0, SOCIAL_INTEL_BUDGET);

  // Pass 2: enrich top candidates with social intel
  for (const candidate of topForSocial) {
    try {
      const socialIntel = await getBrandSocialIntel({ DB: env.DB } as Env, candidate.brand.brand_id);
      if (socialIntel.impersonationProfiles > 0) {
        candidate.breakdown.social_impersonation = SCORING.social_impersonation;
        candidate.score += SCORING.social_impersonation;
      }
      if (socialIntel.socialRiskScore && socialIntel.socialRiskScore >= 60) {
        candidate.breakdown.social_high_risk = SCORING.social_high_risk;
        candidate.score += SCORING.social_high_risk;
      }
      if (socialIntel.aiTakedownRecommendations > 0) {
        candidate.breakdown.social_takedown_needed = SCORING.social_takedown_needed;
        candidate.score += SCORING.social_takedown_needed;
      }
    } catch { /* social intel is best-effort */ }
  }

  // Apply MIN_SCORE filter and build final candidates
  const candidates: ProspectCandidate[] = [];

  for (const item of initialCandidates) {
    if (item.score < MIN_SCORE) continue;
    const brand = item.brand;
    const breakdown = item.breakdown;
    const score = item.score;

    // Determine pitch angle from highest-weighted factor
    const emailScore = breakdown.email_grade_f_or_d ?? breakdown.email_grade_c ?? 0;
    const threatScore = breakdown.active_phishing_urls ?? 0;
    const brandScore = (breakdown.spam_trap_catches ?? 0) + (breakdown.social_impersonation ?? 0);

    let pitchAngle: string;
    if (emailScore >= threatScore && emailScore >= brandScore) {
      pitchAngle = 'email_security_gap';
    } else if (threatScore >= brandScore) {
      pitchAngle = 'high_threat_volume';
    } else {
      pitchAngle = 'brand_protection';
    }

    // Template-based findings summary — no AI required
    const dmarc = brand.dmarc_policy?.toLowerCase();
    const grade = brand.email_security_grade?.toUpperCase();
    const phishCount = phishMap.get(brand.brand_id) ?? 0;
    const trapCount = trapMap.get(brand.brand_id) ?? 0;
    const riskScore = riskMap.get(brand.brand_id);
    const recentThreats = threatMap.get(brand.brand_id)?.threat_count ?? 0;
    const emailGrade = brand.email_security_grade ?? 'unknown';
    const factors: string[] = [];
    if (phishCount > 0) factors.push(`${phishCount} active phishing URLs`);
    if (trapCount > 0) factors.push(`${trapCount} spam trap catches`);
    if (!dmarc || dmarc === 'none') factors.push('no DMARC enforcement');
    if (grade === 'F' || grade === 'D') factors.push(`email grade ${grade}`);
    if (breakdown.social_impersonation) factors.push('social media impersonation');

    const findingsSummary = `${brand.brand_name} (${brand.brand_domain}) has ${recentThreats} active threats in the last 30 days with an email security grade of ${emailGrade}. Risk factors: ${factors.length ? factors.join(', ') : 'composite risk indicators'}.`;

    candidates.push({
      brand_id: brand.brand_id,
      brand_name: brand.brand_name,
      brand_domain: brand.brand_domain,
      prospect_score: score,
      score_breakdown: breakdown,
      email_security_grade: brand.email_security_grade,
      threat_count_30d: recentThreats,
      phishing_urls_active: phishCount,
      trap_catches_30d: trapCount,
      composite_risk_score: riskScore ?? null,
      pitch_angle: pitchAngle,
      findings_summary: findingsSummary,
      revenue_band: brand.revenue_band,
      employee_band: brand.employee_band,
      industry_naics: brand.industry_naics,
      is_public: brand.is_public,
      ticker: brand.ticker,
      founded_year: brand.founded_year,
      parent_company: brand.parent_company,
      last_breach_disclosed_at: brand.last_breach_disclosed_at,
      security_news_headline: brand.security_news_headline,
      security_news_url: brand.security_news_url,
      cyber_10k_mentions: brand.cyber_10k_mentions,
    });
  }

  // Sort by score descending, take top MAX_IDENTIFIED
  candidates.sort((a, b) => b.prospect_score - a.prospect_score);
  const topCandidates = candidates.slice(0, MAX_IDENTIFIED);

  // Insert leads — no AI, just data
  let leadsCreated = 0;
  let errors = 0;

  for (const candidate of topCandidates) {
    try {
      const newId = await createLead(env, {
        brand_id: candidate.brand_id,
        prospect_score: candidate.prospect_score,
        score_breakdown_json: JSON.stringify(candidate.score_breakdown),
        company_name: candidate.brand_name,
        company_domain: candidate.brand_domain,
        email_security_grade: candidate.email_security_grade,
        threat_count_30d: candidate.threat_count_30d,
        phishing_urls_active: candidate.phishing_urls_active,
        trap_catches_30d: candidate.trap_catches_30d,
        composite_risk_score: candidate.composite_risk_score,
        pitch_angle: candidate.pitch_angle,
        findings_summary: candidate.findings_summary,
        revenue_band: candidate.revenue_band,
        employee_band: candidate.employee_band,
        industry_naics: candidate.industry_naics,
        is_public: candidate.is_public,
        ticker: candidate.ticker,
        founded_year: candidate.founded_year,
        parent_company: candidate.parent_company,
        last_breach_disclosed_at: candidate.last_breach_disclosed_at,
        security_news_headline: candidate.security_news_headline,
        security_news_url: candidate.security_news_url,
        cyber_10k_mentions: candidate.cyber_10k_mentions,
        identified_by: 'pathfinder_agent',
      });
      // createLead returns null when an active lead already exists for
      // this brand_id (atomic NOT EXISTS guard). That's a no-op, not an
      // error — the 90-day cooldown filter usually catches this earlier,
      // but the DB-level guard handles races + manual triggers.
      if (newId !== null) leadsCreated++;
    } catch (err) {
      errors++;
    }
  }

  console.log(`[pathfinder] funnel: ${emailGrades.results.length} brands → ${topForSocial.length} social-enriched → ${candidates.length} above MIN_SCORE → ${leadsCreated} leads created`);

  return { candidates_found: topCandidates.length, leads_created: leadsCreated, errors };
}

// ─── Phase 2: AI Enrichment ──────────────────────────────────────

export async function enrichLeadWithAI(env: Env, runId: string | null = null): Promise<{
  enriched: boolean;
  lead_id?: number;
  company_name?: string;
  error?: string;
  rejected?: string;
}> {
  // Pick the highest-scored unenriched lead
  const lead = await getUnenrichedLead(env);

  if (!lead) {
    return { enriched: false };
  }

  try {
    // ── (a) Detailed findings summary ──────────────────────────
    const summaryResult = await callHaikuJSON<{ summary: string }>(
      env,
      runId,
      `You are a concise threat intelligence writer for Averrow, a brand protection platform. Write a 2-3 sentence factual summary of security findings. Reference specific numbers. Output JSON: {"summary": "..."}`,
      `Brand: ${lead.company_name} (${lead.company_domain})
Email security grade: ${lead.email_security_grade || 'Not scanned'}
Active phishing URLs detected (30d): ${lead.phishing_urls_active ?? 0}
Spam trap catches (brand impersonation, 30d): ${lead.trap_catches_30d ?? 0}
Total threats (30d): ${lead.threat_count_30d ?? 0}
Composite risk score: ${lead.composite_risk_score ?? 'N/A'}/100
Pitch angle: ${lead.pitch_angle ?? 'brand_protection'}`,
      256,
    );

    const findingsSummary = summaryResult.data?.summary ?? lead.findings_summary;

    // ── (b) Personalized outreach email variants ────────────────
    const outreachResult = await callHaikuJSON<{
      variant_1_subject: string;
      variant_1_body: string;
      variant_2_subject: string;
      variant_2_body: string;
    }>(
      env,
      runId,
      `You are drafting outreach emails from Averrow to a security leader at a company. Be direct and professional.

AVERROW FINDINGS (share at HIGH LEVEL only — do not reveal specific URLs, IPs, or detailed IOCs):
${findingsSummary}

Email security grade: ${lead.email_security_grade ?? 'Unknown'}
Active phishing URLs detected: ${lead.phishing_urls_active ?? 0}
Spam trap catches (brand impersonation): ${lead.trap_catches_30d ?? 0}
Overall risk score: ${lead.composite_risk_score ?? 'N/A'}/100

Generate TWO email variants as JSON: variant_1_subject, variant_1_body, variant_2_subject, variant_2_body.

VARIANT 1 — "Intelligence briefing" angle: lead with a specific finding, frame as sharing intelligence, offer a 15-minute threat briefing, under 150 words body.
VARIANT 2 — "Peer benchmark" angle: compare their security posture to industry peers, reference specific gaps, offer a free assessment report, under 150 words body.

RULES: Professional, direct tone. No buzzwords. No exclamation marks. Sign off as "Averrow Threat Intelligence Team". Return ONLY valid JSON.`,
      `Draft the two outreach email variants for ${lead.company_name} (${lead.company_domain}).`,
      1024,
    );

    // ── (c) Company research ────────────────────────────────────
    const researchResult = await callHaikuJSON<{
      company_industry?: string | null;
      company_size?: string | null;
      company_hq?: string | null;
      is_service_provider?: boolean | null;
      target_name?: string | null;
      target_title?: string | null;
      security_maturity?: string | null;
      recent_security_news?: string | null;
    }>(
      env,
      runId,
      `You are a sales intelligence researcher. Research the company and return a JSON profile. If you cannot find a field, return null — do NOT fabricate. Return ONLY valid JSON.`,
      `Research "${lead.company_name}" (${lead.company_domain}). Return JSON with:
- company_industry: the company's primary industry sector
- company_size: MUST reflect actual employee headcount — "startup" (<50 employees), "smb" (50-500), "mid-market" (500-5000), "enterprise" (5000+). If uncertain, return null.
- company_hq: city and country of headquarters
- is_service_provider: true if the company is a hosting provider, CDN, registrar, DNS provider, cloud infrastructure vendor, or cybersecurity vendor. false otherwise.
- target_name: name of the CISO, VP Security, or Head of Security
- target_title: their job title
- security_maturity: "high", "medium", or "low" based on public security posture
- recent_security_news: one sentence about recent security incidents or news, or null`,
      1024,
      [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    );

    const research = researchResult.data ?? {};

    // ── Post-enrichment rejection gates ─────────────────────────
    // Reject enterprises (5000+ employees) — they won't procure from a startup
    const companySize = research.company_size?.toLowerCase();
    if (companySize === 'enterprise') {
      await rejectLead(env, lead.id, 'enterprise_too_large', JSON.stringify(research));
      return { enriched: true, lead_id: lead.id, company_name: lead.company_name ?? undefined, rejected: 'enterprise_too_large' };
    }

    // Reject service providers / infrastructure companies
    if (research.is_service_provider === true) {
      await rejectLead(env, lead.id, 'service_provider', JSON.stringify(research));
      return { enriched: true, lead_id: lead.id, company_name: lead.company_name ?? undefined, rejected: 'service_provider' };
    }

    // Reject cybersecurity / hosting / cloud infrastructure industry
    const industry = research.company_industry?.toLowerCase() ?? '';
    const EXCLUDED_INDUSTRIES = ['cybersecurity', 'cyber security', 'information security', 'network security',
      'hosting', 'web hosting', 'cloud hosting', 'cloud infrastructure', 'cloud computing',
      'cdn', 'content delivery', 'domain registrar', 'dns'];
    if (EXCLUDED_INDUSTRIES.some(ex => industry.includes(ex))) {
      await rejectLead(env, lead.id, `excluded_industry:${research.company_industry}`, JSON.stringify(research));
      return { enriched: true, lead_id: lead.id, company_name: lead.company_name ?? undefined, rejected: 'excluded_industry' };
    }

    // ── Update the lead ─────────────────────────────────────────
    // Persist the structured fields from research into dedicated columns so
    // the UI can render firmographics + buying-signals without cracking the
    // JSON blob. The blob is still saved as the source of truth for
    // forensics and any future re-parsing.
    await enrichLead(env, lead.id, {
      findings_summary: findingsSummary ?? '',
      outreach_variant_1: outreachResult.data
        ? JSON.stringify({ subject: outreachResult.data.variant_1_subject, body: outreachResult.data.variant_1_body })
        : null,
      outreach_variant_2: outreachResult.data
        ? JSON.stringify({ subject: outreachResult.data.variant_2_subject, body: outreachResult.data.variant_2_body })
        : null,
      research_json: JSON.stringify(research),
      company_industry: research.company_industry ?? null,
      company_size: research.company_size ?? null,
      company_hq: research.company_hq ?? null,
      target_name: research.target_name ?? null,
      target_title: research.target_title ?? null,
      security_maturity: research.security_maturity ?? null,
      security_news_headline: research.recent_security_news ?? null,
    });

    return { enriched: true, lead_id: lead.id, company_name: lead.company_name ?? undefined };

  } catch (err) {
    // Do NOT mark as enriched — it will be retried next run
    return { enriched: false, lead_id: lead.id, error: String(err) };
  }
}

// ─── Main run() ─────────────────────────────────────────────────

async function run(env: Env): Promise<{
  phase1: { candidates_found: number; leads_created: number; errors: number };
  phase2: { enriched: boolean; lead_id?: number; company_name?: string; error?: string };
}> {
  // Phase 1: always run — identify and create new leads (no AI)
  const phase1 = await identifyAndCreate(env);

  // Phase 2: always run — enrich one existing unenriched lead (AI)
  const phase2 = await enrichLeadWithAI(env);

  return { phase1, phase2 };
}

// ─── Agent Module ────────────────────────────────────────────────

export const pathfinderAgent: AgentModule = {
  name: "pathfinder",
  displayName: "Pathfinder",
  description: "Sales intelligence & lead generation — manual trigger only since 2026-04-29 (Phase 2.6 of agent audit)",
  color: "#28A050",
  trigger: "manual",
  requiresApproval: false,
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 1_000_000 },
  reads: [
    { kind: "kv", namespace: "CACHE" },
    { kind: "d1_table", name: "brand_firmographics" },
    { kind: "d1_table", name: "brand_threat_assessments" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "email_security_scans" },
    { kind: "d1_table", name: "org_brands" },
    { kind: "d1_table", name: "phishing_pattern_signals" },
    { kind: "d1_table", name: "sales_leads" },
    { kind: "d1_table", name: "spam_trap_captures" },
    { kind: "d1_table", name: "threat_signals" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [],
  outputs: [{ type: "insight" }],
  status: "active",
  category: "ops",
  pipelinePosition: 9,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;
    const outputs: AgentOutputEntry[] = [];

    // Check weekly throttle for Phase 1 (lead creation)
    const lastRun = await env.CACHE.get("pathfinder:last_run");
    const throttled = lastRun && Date.now() - parseInt(lastRun) < 7 * 24 * 60 * 60 * 1000;

    let phase1 = { candidates_found: 0, leads_created: 0, errors: 0 };

    if (throttled) {
      // Phase 1 throttled — skip lead creation this tick
    } else {
      phase1 = await identifyAndCreate(env);
      await env.CACHE.put("pathfinder:last_run", Date.now().toString());
    }

    // Phase 2 always runs — enrich one lead on every cron tick
    const phase2 = await enrichLeadWithAI(env, runId);

    const enrichStatus = phase2.rejected
      ? `Rejected lead ${phase2.lead_id} (${phase2.company_name}) — ${phase2.rejected}.`
      : phase2.enriched
        ? `AI-enriched lead ${phase2.lead_id} (${phase2.company_name}).`
        : "No unenriched leads to process.";

    outputs.push({
      type: "insight",
      summary: throttled
        ? `Pathfinder: lead creation throttled. ${enrichStatus}`
        : `Pathfinder created ${phase1.leads_created} leads from ${phase1.candidates_found} candidates. ${enrichStatus}`,
      severity: phase1.leads_created > 0 || phase2.enriched ? "medium" : "info",
      details: { phase1, phase2, throttled: !!throttled },
    });

    return {
      itemsProcessed: phase1.candidates_found,
      itemsCreated: phase1.leads_created,
      itemsUpdated: phase2.enriched ? 1 : 0,
      output: { phase1, phase2 },
      agentOutputs: outputs,
    };
  },
};
