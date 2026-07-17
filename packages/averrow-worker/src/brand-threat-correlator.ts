/**
 * Brand Threat Correlation Engine — Phase 3
 *
 * Combines first-party data (spam trap catches, DMARC reports, email security scans)
 * with external signals (PhishTank, URLhaus, AbuseIPDB) to produce unified
 * brand threat assessments with composite risk scoring.
 */

import type { Env } from "./types";

// ─── Types ─────────────────────────────────────────────────────────

export interface BrandThreatAssessment {
  brand_id: string;
  brand_name: string;
  brand_domain: string;

  // Overall risk
  composite_risk_score: number;
  risk_level: string;
  risk_factors: string[];

  // Email security posture
  email_security_grade: string | null;
  has_dmarc: boolean;
  has_spf: boolean;
  has_dkim: boolean;
  dmarc_policy: string | null;

  // Spam trap signals
  trap_catches_30d: number;
  trap_phishing_catches_30d: number;
  trap_unique_senders_30d: number;
  trap_unique_ips_30d: number;
  latest_trap_catch: string | null;

  // Phishing pattern signals
  ai_generated_phishing_detected: boolean;
  ai_phishing_count_30d: number;
  common_impersonation_techniques: string[];

  // External signals
  phishtank_active_urls: number;
  urlhaus_malware_urls: number;
  credential_breaches: number;

  // DMARC report signals
  dmarc_failures_30d: number;
  unauthorized_senders_30d: number;

  // Composite narratives
  threat_summary: string;
  recommended_actions: string[];

  assessed_at: string;
}

interface BrandInfo {
  id: string;
  name: string;
  canonical_domain: string;
  email_security_grade: string | null;
  email_security_score: number | null;
}

// ─── Risk Level Mapping ────────────────────────────────────────────

function riskLevel(score: number): string {
  if (score >= 81) return "critical";
  if (score >= 61) return "high";
  if (score >= 41) return "medium";
  if (score >= 21) return "low";
  return "minimal";
}

// ─── Core Correlation Function ─────────────────────────────────────

export async function correlateBrandThreats(
  env: Env,
  brandId: string,
): Promise<BrandThreatAssessment | null> {
  // 1. Load brand info
  const brand = await env.DB.prepare(
    "SELECT id, name, canonical_domain, email_security_grade, email_security_score FROM brands WHERE id = ?"
  ).bind(brandId).first<BrandInfo>();

  if (!brand) return null;

  const now = new Date().toISOString();

  // 2. Query email_security_scans for latest scan
  const emailScan = await env.DB.prepare(`
    SELECT has_dmarc, has_spf, has_dkim, dmarc_policy
    FROM email_security_scans
    WHERE brand_id = ?
    ORDER BY scanned_at DESC LIMIT 1
  `).bind(brandId).first<{
    has_dmarc: number; has_spf: number; has_dkim: number; dmarc_policy: string | null;
  }>().catch(() => null);

  // 3. Query spam_trap_captures for last 30 days
  const trapStats = await env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN classification = 'phishing' THEN 1 ELSE 0 END) as phishing,
      COUNT(DISTINCT sender_email) as unique_senders,
      COUNT(DISTINCT sending_ip) as unique_ips,
      MAX(captured_at) as latest
    FROM spam_trap_captures
    WHERE spoofed_brand_id = ? AND captured_at >= datetime('now', '-30 days')
  `).bind(brandId).first<{
    total: number; phishing: number; unique_senders: number;
    unique_ips: number; latest: string | null;
  }>().catch(() => ({
    total: 0, phishing: 0, unique_senders: 0, unique_ips: 0, latest: null,
  }));

  // 4. Query phishing_pattern_signals for AI detection markers
  const aiPhishing = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM phishing_pattern_signals pps
    JOIN spam_trap_captures stc ON stc.id = pps.capture_id
    WHERE stc.spoofed_brand_id = ?
      AND pps.created_at >= datetime('now', '-30 days')
      AND pps.ai_generated = 1
  `).bind(brandId).first<{ count: number }>().catch(() => ({ count: 0 }));

  // 5. Query threat_signals for external signals
  const externalSignals = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN source = 'phishtank' THEN 1 ELSE 0 END) as phishtank_urls,
      SUM(CASE WHEN source = 'urlhaus' THEN 1 ELSE 0 END) as urlhaus_urls,
      SUM(CASE WHEN signal_type = 'credential_breach' THEN 1 ELSE 0 END) as breaches
    FROM threat_signals
    WHERE brand_match_id = ?
      AND created_at >= datetime('now', '-90 days')
  `).bind(brandId).first<{
    phishtank_urls: number; urlhaus_urls: number; breaches: number;
  }>().catch(() => ({
    phishtank_urls: 0, urlhaus_urls: 0, breaches: 0,
  }));

  // 6. Query DMARC report data (if tables exist)
  const dmarcFailures = await env.DB.prepare(`
    SELECT COUNT(*) as failures
    FROM dmarc_reports
    WHERE brand_id = ?
      AND created_at >= datetime('now', '-30 days')
      AND (spf_result = 'fail' OR dkim_result = 'fail')
  `).bind(brandId).first<{ failures: number }>().catch(() => ({ failures: 0 }));

  const unauthorizedSenders = await env.DB.prepare(`
    SELECT COUNT(DISTINCT source_ip) as count
    FROM dmarc_reports
    WHERE brand_id = ?
      AND created_at >= datetime('now', '-30 days')
      AND (spf_result = 'fail' OR dkim_result = 'fail')
  `).bind(brandId).first<{ count: number }>().catch(() => ({ count: 0 }));

  // 7. Compute composite risk score
  let score = 0;
  const riskFactors: string[] = [];
  const actions: string[] = [];

  const grade = brand.email_security_grade;
  if (grade === "F" || grade === "D") {
    score += 30;
    riskFactors.push(`Email security grade ${grade} — weak spoofing protection`);
    actions.push("Implement DMARC with reject policy, configure SPF and DKIM");
  } else if (grade === "C") {
    score += 15;
    riskFactors.push(`Email security grade ${grade} — moderate protection gaps`);
    actions.push("Strengthen DMARC policy to quarantine or reject");
  }

  const dmarcPolicy = emailScan?.dmarc_policy ?? null;
  if (!dmarcPolicy || dmarcPolicy === "none") {
    score += 20;
    riskFactors.push(dmarcPolicy ? "DMARC policy set to 'none' — no enforcement" : "No DMARC record configured");
    if (!actions.some(a => a.includes("DMARC"))) {
      actions.push("Configure DMARC with enforcement policy (quarantine or reject)");
    }
  }

  const ptUrls = externalSignals?.phishtank_urls ?? 0;
  if (ptUrls > 0) {
    const ptScore = Math.min(ptUrls * 15, 30);
    score += ptScore;
    riskFactors.push(`${ptUrls} active PhishTank URL${ptUrls > 1 ? "s" : ""} targeting this brand`);
    actions.push("Submit takedown requests for active phishing URLs");
  }

  const trapTotal = trapStats?.total ?? 0;
  if (trapTotal > 0) {
    const trapScore = trapTotal <= 5 ? 10 : trapTotal <= 20 ? 20 : 30;
    score += trapScore;
    riskFactors.push(`${trapTotal} spam trap catches impersonating this brand in last 30 days`);
  }

  const aiCount = aiPhishing?.count ?? 0;
  if (aiCount > 0) {
    score += 15;
    riskFactors.push(`${aiCount} AI-generated phishing attempt${aiCount > 1 ? "s" : ""} detected`);
    actions.push("Monitor for AI-generated phishing campaigns");
  }

  const breaches = externalSignals?.breaches ?? 0;
  if (breaches > 0) {
    const breachScore = Math.min(breaches * 10, 20);
    score += breachScore;
    riskFactors.push(`${breaches} credential breach${breaches > 1 ? "es" : ""} involving brand domain`);
    actions.push("Notify affected users and enforce password resets");
  }

  const uhUrls = externalSignals?.urlhaus_urls ?? 0;
  if (uhUrls > 0) {
    score += 20;
    riskFactors.push(`${uhUrls} malware URL${uhUrls > 1 ? "s" : ""} on brand infrastructure (URLhaus)`);
    actions.push("Investigate and remediate malware distribution on brand domains");
  }

  // Cap at 100
  score = Math.min(score, 100);

  // Generate threat summary
  const level = riskLevel(score);
  let summary = `${brand.name} has a ${level} risk level (score: ${score}/100).`;
  if (riskFactors.length > 0) {
    summary += ` Key factors: ${riskFactors.slice(0, 3).join("; ")}.`;
  }
  if (riskFactors.length === 0) {
    summary += " No significant threat indicators detected.";
  }

  // Impersonation techniques from spam trap data
  const techniques: string[] = [];
  if (trapTotal > 0) techniques.push("Email impersonation");
  if (ptUrls > 0) techniques.push("Phishing pages");
  if (aiCount > 0) techniques.push("AI-generated content");
  if (uhUrls > 0) techniques.push("Malware distribution");

  const assessment: BrandThreatAssessment = {
    brand_id: brandId,
    brand_name: brand.name,
    brand_domain: brand.canonical_domain,

    composite_risk_score: score,
    risk_level: level,
    risk_factors: riskFactors,

    email_security_grade: grade ?? null,
    has_dmarc: !!(emailScan?.has_dmarc),
    has_spf: !!(emailScan?.has_spf),
    has_dkim: !!(emailScan?.has_dkim),
    dmarc_policy: dmarcPolicy,

    trap_catches_30d: trapTotal,
    trap_phishing_catches_30d: trapStats?.phishing ?? 0,
    trap_unique_senders_30d: trapStats?.unique_senders ?? 0,
    trap_unique_ips_30d: trapStats?.unique_ips ?? 0,
    latest_trap_catch: trapStats?.latest ?? null,

    ai_generated_phishing_detected: aiCount > 0,
    ai_phishing_count_30d: aiCount,
    common_impersonation_techniques: techniques,

    phishtank_active_urls: ptUrls,
    urlhaus_malware_urls: uhUrls,
    credential_breaches: breaches,

    dmarc_failures_30d: dmarcFailures?.failures ?? 0,
    unauthorized_senders_30d: unauthorizedSenders?.count ?? 0,

    threat_summary: summary,
    recommended_actions: actions,

    assessed_at: now,
  };

  return assessment;
}

// ─── Store Assessment Snapshot ─────────────────────────────────────

export async function storeAssessment(
  db: D1Database,
  assessment: BrandThreatAssessment,
): Promise<void> {
  await db.prepare(`
    INSERT INTO brand_threat_assessments
      (brand_id, composite_risk_score, risk_level, risk_factors_json,
       email_security_grade, trap_catches_30d, trap_phishing_catches_30d,
       ai_phishing_detected, phishtank_active_urls, urlhaus_malware_urls,
       credential_breaches, dmarc_failures_30d, threat_summary,
       recommended_actions_json, assessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    assessment.brand_id,
    assessment.composite_risk_score,
    assessment.risk_level,
    JSON.stringify(assessment.risk_factors),
    assessment.email_security_grade,
    assessment.trap_catches_30d,
    assessment.trap_phishing_catches_30d,
    assessment.ai_phishing_count_30d > 0 ? 1 : 0,
    assessment.phishtank_active_urls,
    assessment.urlhaus_malware_urls,
    assessment.credential_breaches,
    assessment.dmarc_failures_30d,
    assessment.threat_summary,
    JSON.stringify(assessment.recommended_actions),
    assessment.assessed_at,
  ).run();
}

// ─── Daily Assessment Cron ─────────────────────────────────────────

export interface AssessmentCronResult {
  brandsAssessed: number;
  highRiskBrands: number;
  scoreSpikes: number;
}

/**
 * Run brand threat assessments for all monitored brands.
 * Throttled to once per 24 hours via KV.
 */
export async function runDailyAssessments(env: Env): Promise<AssessmentCronResult> {
  const THROTTLE_KEY = "pipeline:assessments:last_run";
  const now = Date.now();

  const lastRun = await env.CACHE.get(THROTTLE_KEY);
  if (lastRun && now - parseInt(lastRun, 10) < 86400_000) {
    return { brandsAssessed: 0, highRiskBrands: 0, scoreSpikes: 0 };
  }

  await env.CACHE.put(THROTTLE_KEY, String(now), { expirationTtl: 90000 });

  // Get monitored brands (or brands with recent activity)
  const brands = await env.DB.prepare(`
    SELECT DISTINCT b.id
    FROM brands b
    LEFT JOIN threats t ON t.target_brand_id = b.id
    WHERE b.is_monitored = 1
       OR t.created_at >= datetime('now', '-7 days')
    LIMIT 100
  `).all<{ id: string }>().catch(() => ({ results: [] as Array<{ id: string }> }));

  let brandsAssessed = 0;
  let highRiskBrands = 0;
  let scoreSpikes = 0;

  for (const { id } of brands.results) {
    try {
      const assessment = await correlateBrandThreats(env, id);
      if (!assessment) continue;

      await storeAssessment(env.DB, assessment);
      brandsAssessed++;

      if (assessment.composite_risk_score > 60) highRiskBrands++;

      // Check for score spike (20+ point jump from previous)
      const prev = await env.DB.prepare(`
        SELECT composite_risk_score
        FROM brand_threat_assessments
        WHERE brand_id = ?
        ORDER BY assessed_at DESC
        LIMIT 1 OFFSET 1
      `).bind(id).first<{ composite_risk_score: number }>();

      if (prev && assessment.composite_risk_score - prev.composite_risk_score >= 20) {
        scoreSpikes++;
      }
    } catch (err) {
      console.error(`[correlator] assessment failed for brand ${id}:`, err);
    }
  }

  return { brandsAssessed, highRiskBrands, scoreSpikes };
}

// ─── API: Get Latest Assessment ────────────────────────────────────

export async function getLatestAssessment(
  env: Env,
  brandId: string,
): Promise<BrandThreatAssessment | null> {
  // Check if latest assessment is recent enough (within 24h)
  const latest = await env.DB.prepare(`
    SELECT assessed_at FROM brand_threat_assessments
    WHERE brand_id = ? ORDER BY assessed_at DESC LIMIT 1
  `).bind(brandId).first<{ assessed_at: string }>();

  const isStale = !latest ||
    (Date.now() - new Date(latest.assessed_at + (latest.assessed_at.includes("Z") ? "" : "Z")).getTime() > 86400_000);

  if (isStale) {
    // Generate fresh assessment
    const assessment = await correlateBrandThreats(env, brandId);
    if (assessment) {
      await storeAssessment(env.DB, assessment);
      return assessment;
    }
    return null;
  }

  // Return the cached one
  return correlateBrandThreats(env, brandId);
}

// ─── API: Get Assessment History ───────────────────────────────────

export async function getAssessmentHistory(
  db: D1Database,
  brandId: string,
  limit = 30,
): Promise<Array<{
  composite_risk_score: number;
  risk_level: string;
  risk_factors_json: string | null;
  threat_summary: string | null;
  assessed_at: string;
}>> {
  const rows = await db.prepare(`
    SELECT composite_risk_score, risk_level, risk_factors_json,
           threat_summary, assessed_at
    FROM brand_threat_assessments
    WHERE brand_id = ?
    ORDER BY assessed_at DESC
    LIMIT ?
  `).bind(brandId, limit).all<{
    composite_risk_score: number;
    risk_level: string;
    risk_factors_json: string | null;
    threat_summary: string | null;
    assessed_at: string;
  }>();

  return rows.results;
}
