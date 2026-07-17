// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Brand Exposure Report — Public scan endpoint.
 *
 * POST /api/scan/report
 * Generates a comprehensive Brand Exposure Report combining:
 *   1. Email security posture (SPF, DKIM, DMARC, MX)
 *   2. Threat feed cross-reference
 *   3. Lookalike domain detection via dnstwist permutations
 *   4. Social handle availability checks
 *   5. AI assessment narrative via Claude Haiku
 *
 * Rate limited: 5 scans/hour per IP (unauthenticated).
 * Results cached in KV for 24 hours.
 */

import { json } from '../lib/cors';
import { runEmailSecurityScan } from '../email-security';
import type { EmailSecurityResult } from '../email-security';
import { generatePermutations, checkLookalikeDNS } from '../lib/dnstwist';
import type { LookalikeCheckResult } from '../lib/dnstwist';
import { checkSocialHandles } from '../lib/social-check';
import type { SocialCheckResult } from '../lib/social-check';
import { computeExposureScore } from '../lib/scoring-utils';
import { runSyncAgent } from '../lib/agentRunner';
import { scanReportAgent, type ScanReportOutput } from '../agents/scan-report';
import type { Env } from '../types';

// ─── Report Types ───────────────────────────────────────────────

export interface BrandExposureReport {
  domain: string;
  brand_name: string;
  scan_date: string;
  exposure_score: number;   // 0-100 (100 = most exposed / worst)
  risk_level: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
  email_security: {
    grade: string;
    spf: { status: string; record?: string };
    dkim: { status: string; selectors_checked: string[] };
    dmarc: { status: string; policy?: string };
    mx_provider: string;
  };
  domain_risk: {
    score: number;
    similar_domains_found: number;
    lookalikes: Array<{ domain: string; type: string; registered: boolean }>;
  };
  threat_feeds: {
    total_hits: number;
    phishtank: number;
    urlhaus: number;
    openphish: number;
  };
  social_presence: {
    issues: number;
    platforms: SocialCheckResult[];
  };
  ai_assessment: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function normalizeDomain(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

function deriveBrandName(domain: string): string {
  const name = domain.split('.')[0] ?? domain;
  // Capitalize first letter
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function emailGradeToStatus(exists: boolean, detail?: string | null): string {
  if (!exists) return 'missing';
  if (detail === 'reject' || detail === '-all') return 'pass';
  if (detail === 'quarantine' || detail === '~all') return 'partial';
  if (detail === 'none' || detail === '?all') return 'weak';
  return 'present';
}


function riskLevel(score: number): 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' {
  if (score >= 75) return 'CRITICAL';
  if (score >= 50) return 'HIGH';
  if (score >= 25) return 'MODERATE';
  return 'LOW';
}

// ─── Threat Feed Query ──────────────────────────────────────────

async function queryThreatFeeds(
  domain: string,
  db: D1Database,
): Promise<{ total_hits: number; phishtank: number; urlhaus: number; openphish: number }> {
  try {
    const rows = await db
      .prepare(
        `SELECT source, COUNT(*) as cnt
         FROM threats
         WHERE domain LIKE ? OR ioc_value LIKE ?
         GROUP BY source`,
      )
      .bind(`%${domain}%`, `%${domain}%`)
      .all<{ source: string; cnt: number }>();

    let phishtank = 0;
    let urlhaus = 0;
    let openphish = 0;
    let total = 0;

    for (const row of rows.results) {
      total += row.cnt;
      const src = row.source.toLowerCase();
      if (src.includes('phishtank')) phishtank += row.cnt;
      else if (src.includes('urlhaus')) urlhaus += row.cnt;
      else if (src.includes('openphish')) openphish += row.cnt;
    }

    return { total_hits: total, phishtank, urlhaus, openphish };
  } catch {
    return { total_hits: 0, phishtank: 0, urlhaus: 0, openphish: 0 };
  }
}

// ─── AI Assessment ──────────────────────────────────────────────

/** Strip characters the scan_report input schema doesn't allow.
 *  Anything outside the agent's brand-name charset becomes a space,
 *  collapsed runs trimmed. Empty result → 'Brand'. */
function sanitizeBrandName(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9 &.,'\-/()]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || 'Brand';
}

function localFallback(report: Omit<BrandExposureReport, 'ai_assessment'>): string {
  return `${report.brand_name} has an email security grade of ${report.email_security.grade} with ${report.domain_risk.similar_domains_found} registered lookalike domains detected. ${report.threat_feeds.total_hits > 0 ? `The domain appears in ${report.threat_feeds.total_hits} threat feed entries.` : 'No current threat feed mentions were found.'} Overall exposure score: ${report.exposure_score}/100 (${report.risk_level}).`;
}

async function generateAIAssessment(
  env: Env,
  report: Omit<BrandExposureReport, 'ai_assessment'>,
): Promise<string> {
  try {
    const { data } = await runSyncAgent<ScanReportOutput>(env, scanReportAgent, {
      brandName: sanitizeBrandName(report.brand_name),
      domain: report.domain,
      emailGrade: report.email_security.grade || 'F',
      spfStatus: report.email_security.spf.status,
      dkimStatus: report.email_security.dkim.status,
      dmarcStatus: report.email_security.dmarc.status,
      mxProvider: report.email_security.mx_provider || 'Unknown',
      similarDomainsFound: report.domain_risk.similar_domains_found,
      threatFeedTotal: report.threat_feeds.total_hits,
      threatFeedPhishtank: report.threat_feeds.phishtank,
      threatFeedUrlhaus: report.threat_feeds.urlhaus,
      threatFeedOpenphish: report.threat_feeds.openphish,
      socialIssues: report.social_presence.issues,
      exposureScore: report.exposure_score,
      riskLevel: report.risk_level,
    });
    if (data?.assessment) return data.assessment;
    return localFallback(report);
  } catch {
    return localFallback(report);
  }
}

// ─── Main Handler ───────────────────────────────────────────────

export async function handleScanReport(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get('Origin');

  try {
    const body = (await request.json()) as { domain?: string; brand_name?: string };
    const domain = normalizeDomain(body.domain ?? '');

    if (!domain || !domain.includes('.')) {
      return json({ success: false, error: 'A valid domain is required (e.g., example.com)' }, 400, origin);
    }

    const brandName = body.brand_name?.trim() || deriveBrandName(domain);

    // ── Check KV cache (24 hour TTL) ────────────────────────────
    const cacheKey = `scan-report:${domain}`;
    try {
      const cached = await env.CACHE.get(cacheKey, 'json');
      if (cached) {
        return json({ success: true, data: cached, cached: true }, 200, origin);
      }
    } catch {
      // Cache miss or error — proceed with scan
    }

    // ── Run pipeline in parallel ────────────────────────────────
    const [emailResult, threatFeeds, lookalikeResults, socialResults] = await Promise.all([
      runEmailSecurityScan(domain),
      queryThreatFeeds(domain, env.DB),
      (async () => {
        const perms = generatePermutations(domain);
        return checkLookalikeDNS(perms, 20);
      })(),
      checkSocialHandles(brandName),
    ]);

    // ── Build email security section ────────────────────────────
    const emailSection = {
      grade: emailResult.grade,
      spf: {
        status: emailGradeToStatus(emailResult.spf.exists, emailResult.spf.policy),
        record: emailResult.spf.record ?? undefined,
      },
      dkim: {
        status: emailResult.dkim.exists ? 'pass' : 'missing',
        selectors_checked: emailResult.dkim.selectors_found,
      },
      dmarc: {
        status: emailGradeToStatus(emailResult.dmarc.exists, emailResult.dmarc.policy),
        policy: emailResult.dmarc.policy ?? undefined,
      },
      mx_provider: emailResult.mx.providers.join(', ') || 'Unknown',
    };

    // ── Build domain risk section ───────────────────────────────
    const registeredLookalikes = lookalikeResults.filter((l) => l.registered);
    const domainRiskScore = Math.min(100, registeredLookalikes.length * 10);
    const domainRisk = {
      score: domainRiskScore,
      similar_domains_found: registeredLookalikes.length,
      lookalikes: lookalikeResults.map((l) => ({
        domain: l.domain,
        type: l.type,
        registered: l.registered,
      })),
    };

    // ── Build social presence section ───────────────────────────
    // "available" handles = risk (could be claimed by impersonators)
    const socialIssues = socialResults.filter((s) => s.available === true).length;
    const socialPresence = {
      issues: socialIssues,
      platforms: socialResults,
    };

    // ── Compute exposure score ───────────────────────────────────
    const exposureScore = computeExposureScore({
      emailGrade: emailResult.grade,
      domainRisk: registeredLookalikes.length,
      threatCount: threatFeeds.total_hits,
      socialRisk: socialIssues,
    });

    // ── Assemble partial report (before AI) ─────────────────────
    const partialReport: Omit<BrandExposureReport, 'ai_assessment'> = {
      domain,
      brand_name: brandName,
      scan_date: new Date().toISOString(),
      exposure_score: exposureScore,
      risk_level: riskLevel(exposureScore),
      email_security: emailSection,
      domain_risk: domainRisk,
      threat_feeds: threatFeeds,
      social_presence: socialPresence,
    };

    // ── AI assessment (non-blocking — use fallback if AI fails) ──
    const aiAssessment = await generateAIAssessment(env, partialReport);

    const report: BrandExposureReport = {
      ...partialReport,
      ai_assessment: aiAssessment,
    };

    // ── Cache result for 24 hours ───────────────────────────────
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(report), {
        expirationTtl: 86400,
      });
    } catch {
      // Non-critical — report was generated successfully
    }

    return json({ success: true, data: report }, 200, origin);
  } catch (err) {
    console.error('[scan-report] Error:', err);
    return json(
      { success: false, error: 'Scan failed. Please try again.' },
      500,
      origin,
    );
  }
}
