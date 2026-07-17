// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Brand Threat Report — Generates comprehensive report data for a brand.
 * GET /api/brands/:id/report?period=7d|30d|90d
 */

import { json } from "../lib/cors";
import { runSyncAgent } from "../lib/agentRunner";
import { brandReportAgent } from "../agents/brand-report";
import type { BrandReportOutput } from "../agents/brand-report";
import type { Env } from "../types";

interface EmailSecuritySection {
  score: number;
  grade: string;
  dmarc: { exists: boolean; policy: string | null; reporting_enabled: boolean };
  spf: { exists: boolean; policy: string | null; too_many_lookups: boolean };
  dkim: { exists: boolean; selectors_found: string[] };
  mx: { exists: boolean; providers: string[] };
  recommendations: string[];
  scanned_at: string | null;
}

interface ReportData {
  reportId: string;
  generatedAt: string;
  period: { label: string; days: number; start: string; end: string };
  brand: { id: string; name: string; canonical_domain: string; logo_url: string };
  executive: {
    trustScore: number;
    riskLevel: string;
    totalThreats: number;
    activeThreats: number;
    remediatedThreats: number;
    countriesInvolved: number;
    campaignsIdentified: number;
    hostingProviders: number;
    aiSummary: string;
  };
  emailSecurity: EmailSecuritySection | null;
  threatBreakdown: {
    byType: Array<{ type: string; count: number }>;
    bySeverity: Array<{ severity: string; count: number }>;
    topThreats: Array<{
      id: string; malicious_url: string | null; malicious_domain: string | null;
      threat_type: string; severity: string; status: string; first_seen: string;
    }>;
  };
  campaigns: Array<{
    id: string; name: string; status: string;
    threat_count: number; first_seen: string; last_seen: string;
  }>;
  infrastructure: {
    providers: Array<{ name: string; threat_count: number; active_count: number }>;
    countries: Array<{ country_code: string; count: number }>;
    asns: Array<{ asn: string; count: number }>;
  };
  timeline: Array<{ period: string; count: number; phishing: number; typosquatting: number; malware: number }>;
  spamTrapEvidence: {
    totalCatches: number;
    topSourceIps: Array<{ ip: string; count: number; country_code: string | null }>;
    sampleSubjects: string[];
    authFailBreakdown: { spfFail: number; dkimFail: number; dmarcFail: number };
  } | null;
  recommendations: string[];
}

export async function handleBrandReport(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const periodParam = url.searchParams.get("period") ?? "30d";
    const days = periodParam === "7d" ? 7 : periodParam === "90d" ? 90 : 30;
    const since = `datetime('now', '-${days} days')`;

    // ─── Brand info ───────────────────────────────────────────
    const brand = await env.DB.prepare(
      "SELECT id, name, canonical_domain FROM brands WHERE id = ?"
    ).bind(brandId).first<{ id: string; name: string; canonical_domain: string }>();
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    // ─── Gather all data in parallel ──────────────────────────
    const [
      statsRow, severityRows, typeRows, activeRow, remediatedRow,
      countryRows, campaignRows, providerRows, asnRows,
      topThreats, timelineRows, emailSecRow,
    ] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) AS total FROM threats
        WHERE target_brand_id = ? AND created_at >= ${since}
      `).bind(brandId).first<{ total: number }>(),

      env.DB.prepare(`
        SELECT COALESCE(severity, 'info') AS severity, COUNT(*) AS count FROM threats
        WHERE target_brand_id = ? AND created_at >= ${since}
        GROUP BY severity ORDER BY count DESC
      `).bind(brandId).all<{ severity: string; count: number }>(),

      env.DB.prepare(`
        SELECT threat_type AS type, COUNT(*) AS count FROM threats
        WHERE target_brand_id = ? AND created_at >= ${since}
        GROUP BY threat_type ORDER BY count DESC
      `).bind(brandId).all<{ type: string; count: number }>(),

      env.DB.prepare(`
        SELECT COUNT(*) AS n FROM threats
        WHERE target_brand_id = ? AND status = 'active' AND created_at >= ${since}
      `).bind(brandId).first<{ n: number }>(),

      env.DB.prepare(`
        SELECT COUNT(*) AS n FROM threats
        WHERE target_brand_id = ? AND status = 'remediated' AND created_at >= ${since}
      `).bind(brandId).first<{ n: number }>(),

      env.DB.prepare(`
        SELECT country_code, COUNT(*) AS count FROM threats
        WHERE target_brand_id = ? AND country_code IS NOT NULL AND country_code NOT IN ('XX','PRIV')
          AND created_at >= ${since}
        GROUP BY country_code ORDER BY count DESC LIMIT 15
      `).bind(brandId).all<{ country_code: string; count: number }>(),

      env.DB.prepare(`
        SELECT DISTINCT c.id, c.name, c.status, c.threat_count, c.first_seen, c.last_seen
        FROM campaigns c JOIN threats t ON t.campaign_id = c.id
        WHERE t.target_brand_id = ? ORDER BY c.last_seen DESC LIMIT 10
      `).bind(brandId).all<{ id: string; name: string; status: string; threat_count: number; first_seen: string; last_seen: string }>(),

      env.DB.prepare(`
        SELECT COALESCE(hp.name, t.hosting_provider_id) AS name,
               COUNT(*) AS threat_count,
               SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active_count
        FROM threats t LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
        WHERE t.target_brand_id = ? AND t.hosting_provider_id IS NOT NULL AND t.created_at >= ${since}
        GROUP BY t.hosting_provider_id ORDER BY threat_count DESC LIMIT 15
      `).bind(brandId).all<{ name: string; threat_count: number; active_count: number }>(),

      env.DB.prepare(`
        SELECT asn, COUNT(*) AS count FROM threats
        WHERE target_brand_id = ? AND asn IS NOT NULL AND created_at >= ${since}
        GROUP BY asn ORDER BY count DESC LIMIT 10
      `).bind(brandId).all<{ asn: string; count: number }>(),

      env.DB.prepare(`
        SELECT id, malicious_url, malicious_domain, threat_type, severity, status, first_seen
        FROM threats WHERE target_brand_id = ? AND created_at >= ${since}
        ORDER BY created_at DESC LIMIT 10
      `).bind(brandId).all<{ id: string; malicious_url: string | null; malicious_domain: string | null; threat_type: string; severity: string; status: string; first_seen: string }>(),

      env.DB.prepare(`
        SELECT date(created_at) AS period, COUNT(*) AS count,
               SUM(CASE WHEN threat_type = 'phishing' THEN 1 ELSE 0 END) AS phishing,
               SUM(CASE WHEN threat_type = 'typosquatting' THEN 1 ELSE 0 END) AS typosquatting,
               SUM(CASE WHEN threat_type IN ('malware_distribution','c2') THEN 1 ELSE 0 END) AS malware
        FROM threats WHERE target_brand_id = ? AND created_at >= ${since}
        GROUP BY date(created_at) ORDER BY period ASC
      `).bind(brandId).all<{ period: string; count: number; phishing: number; typosquatting: number; malware: number }>(),

      // Latest email security scan for this brand
      env.DB.prepare(`
        SELECT dmarc_exists, dmarc_policy, dmarc_rua, spf_exists, spf_policy, spf_too_many_lookups,
               dkim_exists, dkim_selectors_found, mx_exists, mx_providers,
               email_security_score, email_security_grade, scanned_at
        FROM email_security_scans WHERE brand_id = ?
        ORDER BY scanned_at DESC LIMIT 1
      `).bind(brandId).first<{
        dmarc_exists: number; dmarc_policy: string | null; dmarc_rua: string | null;
        spf_exists: number; spf_policy: string | null; spf_too_many_lookups: number;
        dkim_exists: number; dkim_selectors_found: string | null;
        mx_exists: number; mx_providers: string | null;
        email_security_score: number; email_security_grade: string;
        scanned_at: string;
      }>(),
    ]);

    // ─── Spam trap evidence ──────────────────────────────────
    let spamTrapEvidence: ReportData["spamTrapEvidence"] = null;
    try {
      const trapTotal = await env.DB.prepare(
        "SELECT COUNT(*) as c FROM spam_trap_captures WHERE spoofed_brand_id = ?"
      ).bind(brandId).first<{ c: number }>();
      if (trapTotal && trapTotal.c > 0) {
        const [topIps, subjects, authFails] = await Promise.all([
          env.DB.prepare(`
            SELECT sending_ip as ip, COUNT(*) as count, country_code
            FROM spam_trap_captures WHERE spoofed_brand_id = ? AND sending_ip IS NOT NULL
            GROUP BY sending_ip ORDER BY count DESC LIMIT 5
          `).bind(brandId).all<{ ip: string; count: number; country_code: string | null }>(),
          env.DB.prepare(`
            SELECT DISTINCT subject FROM spam_trap_captures
            WHERE spoofed_brand_id = ? AND subject IS NOT NULL AND subject != ''
            ORDER BY captured_at DESC LIMIT 5
          `).bind(brandId).all<{ subject: string }>(),
          env.DB.prepare(`
            SELECT
              SUM(CASE WHEN spf_result = 'fail' THEN 1 ELSE 0 END) as spf_fail,
              SUM(CASE WHEN dkim_result = 'fail' THEN 1 ELSE 0 END) as dkim_fail,
              SUM(CASE WHEN dmarc_result = 'fail' THEN 1 ELSE 0 END) as dmarc_fail
            FROM spam_trap_captures WHERE spoofed_brand_id = ?
          `).bind(brandId).first<{ spf_fail: number; dkim_fail: number; dmarc_fail: number }>(),
        ]);
        spamTrapEvidence = {
          totalCatches: trapTotal.c,
          topSourceIps: topIps.results,
          sampleSubjects: subjects.results.map(s => s.subject),
          authFailBreakdown: {
            spfFail: authFails?.spf_fail ?? 0,
            dkimFail: authFails?.dkim_fail ?? 0,
            dmarcFail: authFails?.dmarc_fail ?? 0,
          },
        };
      }
    } catch { /* spam trap tables may not exist yet */ }

    const totalThreats = statsRow?.total ?? 0;
    const activeThreats = activeRow?.n ?? 0;
    const remediatedThreats = remediatedRow?.n ?? 0;
    const countriesInvolved = countryRows.results.length;
    const campaignsIdentified = campaignRows.results.length;
    const hostingProviders = providerRows.results.length;

    // Trust score: 100 - penalties
    let trustScore = 100;
    for (const s of severityRows.results) {
      if (s.severity === "critical") trustScore -= s.count * 8;
      else if (s.severity === "high") trustScore -= s.count * 4;
      else if (s.severity === "medium") trustScore -= s.count * 2;
      else trustScore -= s.count * 1;
    }
    trustScore += remediatedThreats * 2;
    trustScore = Math.max(0, Math.min(100, trustScore));

    const riskLevel = trustScore >= 80 ? "Low" : trustScore >= 60 ? "Medium" : trustScore >= 40 ? "High" : "Critical";

    // ─── AI-generated content ─────────────────────────────────
    const typeBreakdown = typeRows.results.map(r => `${r.type}: ${r.count}`).join(", ");

    // Phase 3.4 of agent audit: brand-report is now a sync agent.
    // The agent owns input validation (sanitises brand name +
    // threat-type/campaign/provider lists), the two parallel AI
    // calls, per-field output schema, and deterministic fallbacks.
    const agentRun = await runSyncAgent<BrandReportOutput>(
      env,
      brandReportAgent,
      {
        brandName: brand.name,
        days,
        totalThreats,
        activeThreats,
        remediatedThreats,
        campaignsIdentified,
        threatTypes: typeRows.results.map((r) => ({ type: r.type, count: r.count })),
        campaigns: campaignRows.results.map((c) => c.name),
        providers: providerRows.results.map((p) => p.name),
      },
    );

    // Defence-in-depth — agent throws on catastrophic schema failure;
    // null data here means we synthesise minimal text so the report
    // still renders.
    const aiSummary = agentRun.data?.summary
      ?? `${brand.name} faced ${totalThreats} threats over the past ${days} days. ${activeThreats} remain active. Primary threat types: ${typeBreakdown || "none detected"}.`;
    const recommendations = agentRun.data?.recommendations ?? [
      "Monitor for new typosquatting domains daily",
      "Consider DMARC enforcement to prevent email spoofing",
      "Report phishing URLs to registrars for takedown",
      "Implement brand monitoring across social media",
    ];

    // ─── Build period info ────────────────────────────────────
    const now = new Date();
    const start = new Date(now.getTime() - days * 86400000);
    const periodLabel = `${start.toLocaleDateString("en-US", { month: "long", day: "numeric" })} – ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

    // Build email security section
    let emailSecurity: EmailSecuritySection | null = null;
    if (emailSecRow) {
      const safeJsonArr = (s: string | null): string[] => {
        if (!s) return [];
        try { return JSON.parse(s) as string[]; } catch { return []; }
      };
      const { generateRecommendations } = await import('../email-security');
      emailSecurity = {
        score: emailSecRow.email_security_score,
        grade: emailSecRow.email_security_grade,
        dmarc: {
          exists: !!emailSecRow.dmarc_exists,
          policy: emailSecRow.dmarc_policy,
          reporting_enabled: !!emailSecRow.dmarc_rua,
        },
        spf: {
          exists: !!emailSecRow.spf_exists,
          policy: emailSecRow.spf_policy,
          too_many_lookups: !!emailSecRow.spf_too_many_lookups,
        },
        dkim: {
          exists: !!emailSecRow.dkim_exists,
          selectors_found: safeJsonArr(emailSecRow.dkim_selectors_found),
        },
        mx: {
          exists: !!emailSecRow.mx_exists,
          providers: safeJsonArr(emailSecRow.mx_providers),
        },
        recommendations: generateRecommendations({
          dmarc: { exists: !!emailSecRow.dmarc_exists, policy: emailSecRow.dmarc_policy, pct: null, rua: emailSecRow.dmarc_rua, ruf: null, raw: null },
          spf: { exists: !!emailSecRow.spf_exists, policy: emailSecRow.spf_policy, includes: 0, tooManyLookups: !!emailSecRow.spf_too_many_lookups, raw: null },
          dkim: { exists: !!emailSecRow.dkim_exists, selectorsFound: safeJsonArr(emailSecRow.dkim_selectors_found), raw: null },
          mx: { exists: !!emailSecRow.mx_exists, providers: safeJsonArr(emailSecRow.mx_providers) },
        }),
        scanned_at: emailSecRow.scanned_at,
      };
    }

    const report: ReportData = {
      reportId: `RPT-${brandId.slice(0, 8)}-${Date.now().toString(36)}`,
      generatedAt: now.toISOString(),
      period: { label: periodLabel, days, start: start.toISOString(), end: now.toISOString() },
      brand: {
        id: brand.id,
        name: brand.name,
        canonical_domain: brand.canonical_domain,
        logo_url: `https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=128`,
      },
      executive: {
        trustScore, riskLevel, totalThreats, activeThreats, remediatedThreats,
        countriesInvolved, campaignsIdentified, hostingProviders, aiSummary,
      },
      emailSecurity,
      threatBreakdown: {
        byType: typeRows.results,
        bySeverity: severityRows.results,
        topThreats: topThreats.results,
      },
      campaigns: campaignRows.results,
      infrastructure: {
        providers: providerRows.results,
        countries: countryRows.results,
        asns: asnRows.results,
      },
      timeline: timelineRows.results,
      spamTrapEvidence,
      recommendations,
    };

    return json({ success: true, data: report }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
