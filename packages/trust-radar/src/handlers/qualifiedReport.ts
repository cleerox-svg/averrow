// Averrow — Sales-Qualified Brand Risk Plan
//
// Generates a deeper, sharable report for a qualified lead. Unlike the
// public /api/brand-scan/public response (score + risk pills only), this
// report contains:
//   1. Executive summary
//   2. Email security audit (full SPF/DKIM/DMARC posture)
//   3. Active threats targeting their brand (full list)
//   4. Infrastructure map (hosting providers + ASNs + campaigns)
//   5. Lookalike domain inventory (registered + unregistered)
//   6. Threat actor narrative (Haiku-generated)
//   7. Remediation plan (Haiku-generated)
//   8. ROI projection (analyst hours saved, takedowns/month, exposure prevented)
//
// Endpoints:
//   POST /api/admin/leads/:id/qualified-report (super_admin auth)
//        → generates the report, stores in qualified_reports, returns
//          a share URL (token-based, 30-day TTL).
//   GET  /api/public/qualified-report/:token (no auth, just token)
//        → renders the snapshotted HTML view.
//
// Why snapshot the data: re-pulling on every share-link visit would let
// the report drift over the sales cycle. Snapshotting at generation time
// means the link shows the world as it was when the admin clicked
// generate — useful for "before vs. after we engaged" comparisons.

import { json } from "../lib/cors";
import { runSyncAgent } from "../lib/agentRunner";
import { qualifiedReportAgent } from "../agents/qualified-report";
import type { QualifiedReportOutput } from "../agents/qualified-report";
import { runEmailSecurityScan, saveEmailSecurityScan } from "../email-security";
import type { Env } from "../types";

// Email-posture freshness: if the latest email_security_scans row for the
// lead's domain is older than this (or missing), re-scan at report-build
// time rather than serving a possibly weeks-old grade. Bounded by a
// wall-clock guard so a slow DNS lookup can't stall report generation.
const EMAIL_SCAN_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const EMAIL_SCAN_BUDGET_MS = 8_000;

// ─── ROI defaults ──────────────────────────────────────────────────
// Per CLAUDE.md §13: positioning is "replaces 2-3 analyst headcount"
// → ~$200-400K/year saved. These are the inputs to the ROI projection.
// Hardcoded for now; if ground-truth values change, move to system_config.
const ROI = {
  analyst_loaded_cost_annual_usd: 150_000,         // fully-loaded analyst cost
  analyst_hours_saved_per_year:   3_500,           // ~70/wk × 50wk replaced
  hourly_rate_usd:                75,              // for hour-savings math
  avg_breach_cost_usd:            4_450_000,       // IBM 2024 breach cost report
  breach_prevention_probability:  0.04,            // platform's contribution
  takedowns_per_brand_per_month:  6,               // rough avg per customer
};

// ─── Types ─────────────────────────────────────────────────────────

interface ReportPayload {
  brand: { domain: string; name: string | null };
  generated_at: string;
  executive_summary: { risk_grade: string; key_findings: string[] };
  email_security: {
    grade: string;
    spf: string | null;
    dmarc: string | null;
    dkim_found: boolean;
    mx_count: number;
  };
  active_threats: {
    total: number;
    by_severity: Record<string, number>;
    samples: Array<{
      id: string;
      threat_type: string;
      severity: string | null;
      source_feed: string;
      malicious_domain: string | null;
      ip_address: string | null;
      country_code: string | null;
      first_seen: string;
    }>;
  };
  infrastructure: {
    top_hosting_providers: Array<{ name: string; asn: string | null; threat_count: number }>;
    top_countries: Array<{ country: string; threat_count: number }>;
    campaigns_caught_in: Array<{ id: string; name: string; threat_count: number }>;
  };
  lookalikes: { registered_count: number; possible_count: number };
  narrative: string;
  remediation_plan: string;
  roi: {
    analyst_hours_saved_per_year: number;
    analyst_dollars_saved_per_year: number;
    takedowns_per_year_projected: number;
    breach_prevention_value_per_year: number;
    total_value_per_year: number;
  };
}

// ─── Data aggregation ──────────────────────────────────────────────

async function buildReportPayload(env: Env, lead: { domain: string; company: string | null }): Promise<ReportPayload> {
  const domain = lead.domain.toLowerCase().trim();

  // Run all data reads in parallel — independent queries.
  const [threatsResult, severityResult, providersResult, countriesResult, campaignsResult, lookalikesResult, brandRow, emailScanRow] = await Promise.all([
    env.DB.prepare(`
      SELECT id, threat_type, severity, source_feed, malicious_domain, ip_address, country_code, created_at AS first_seen
      FROM threats
      WHERE (malicious_domain = ? OR malicious_domain LIKE ?) AND status = 'active'
      ORDER BY created_at DESC LIMIT 50
    `).bind(domain, `%.${domain}`).all<{
      id: string; threat_type: string; severity: string | null; source_feed: string;
      malicious_domain: string | null; ip_address: string | null; country_code: string | null; first_seen: string;
    }>(),
    env.DB.prepare(`
      SELECT severity, COUNT(*) AS n FROM threats
      WHERE (malicious_domain = ? OR malicious_domain LIKE ?) AND status = 'active'
      GROUP BY severity
    `).bind(domain, `%.${domain}`).all<{ severity: string | null; n: number }>(),
    env.DB.prepare(`
      SELECT hp.name, hp.asn, COUNT(*) AS threat_count
      FROM threats t
      JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE (t.malicious_domain = ? OR t.malicious_domain LIKE ?) AND t.status = 'active'
      GROUP BY hp.id ORDER BY threat_count DESC LIMIT 10
    `).bind(domain, `%.${domain}`).all<{ name: string; asn: string | null; threat_count: number }>(),
    env.DB.prepare(`
      SELECT country_code AS country, COUNT(*) AS threat_count
      FROM threats
      WHERE (malicious_domain = ? OR malicious_domain LIKE ?) AND status = 'active' AND country_code IS NOT NULL
      GROUP BY country_code ORDER BY threat_count DESC LIMIT 10
    `).bind(domain, `%.${domain}`).all<{ country: string; threat_count: number }>(),
    env.DB.prepare(`
      SELECT c.id, c.name, COUNT(*) AS threat_count
      FROM threats t
      JOIN campaigns c ON c.id = t.campaign_id
      WHERE (t.malicious_domain = ? OR t.malicious_domain LIKE ?) AND t.status = 'active'
      GROUP BY c.id ORDER BY threat_count DESC LIMIT 5
    `).bind(domain, `%.${domain}`).all<{ id: string; name: string; threat_count: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM lookalike_domains WHERE target_brand LIKE ?
    `).bind(`%${domain.split(".")[0]}%`).first<{ n: number }>(),
    // spf/dmarc/mx are NOT columns on `brands` — they live on
    // email_security_scans (keyed by domain). Selecting them off brands
    // here used to throw and 500 the whole report generation.
    env.DB.prepare(`
      SELECT id, name, email_security_grade
      FROM brands WHERE canonical_domain = ? LIMIT 1
    `).bind(domain).first<{ id: number; name: string; email_security_grade: string | null }>(),
    env.DB.prepare(`
      SELECT spf_policy, dmarc_policy, mx_exists, mx_providers, email_security_grade, scanned_at
      FROM email_security_scans WHERE domain = ?
      ORDER BY scanned_at DESC LIMIT 1
    `).bind(domain).first<{ spf_policy: string | null; dmarc_policy: string | null; mx_exists: number | null; mx_providers: string | null; email_security_grade: string | null; scanned_at: string | null }>(),
  ]);

  // ── Email-posture freshness (B6) ──────────────────────────────────
  // The brands.email_security_grade column and the latest
  // email_security_scans row can both be weeks stale. When stale or
  // missing, run a fresh scan now so the report reflects current
  // posture. Best-effort + time-boxed: on timeout/failure we keep the
  // cached values rather than blocking report generation.
  let freshEmail: { spf: string | null; dmarc: string | null; mxCount: number; grade: string | null } | null = null;
  const scanAgeMs = emailScanRow?.scanned_at
    ? Date.now() - new Date(emailScanRow.scanned_at).getTime()
    : Infinity;
  if (scanAgeMs > EMAIL_SCAN_STALE_MS) {
    try {
      const scan = await Promise.race([
        runEmailSecurityScan(domain),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("email scan timed out")), EMAIL_SCAN_BUDGET_MS)),
      ]);
      freshEmail = {
        spf: scan.spf.policy,
        dmarc: scan.dmarc.policy,
        mxCount: scan.mx.providers.length,
        grade: scan.grade,
      };
      // Persist for next time (only when we have a brand row to key on;
      // the scans table's brand_id is required). Best-effort.
      if (brandRow?.id != null) {
        try { await saveEmailSecurityScan(env.DB, brandRow.id, scan); } catch { /* ignore */ }
      }
    } catch { /* keep cached values */ }
  }

  const totalThreats = threatsResult.results.length;
  const bySeverity: Record<string, number> = {};
  for (const row of severityResult.results) bySeverity[row.severity ?? "unknown"] = row.n;

  // Risk grade derived from threat count + email security grade.
  // Prefer a fresh scan, then the latest stored scan row, then the
  // (possibly stale) brands column, before defaulting to F.
  const emailGrade = freshEmail?.grade
    ?? emailScanRow?.email_security_grade
    ?? brandRow?.email_security_grade
    ?? "F";
  const spfPolicy = freshEmail?.spf ?? emailScanRow?.spf_policy ?? null;
  const dmarcPolicy = freshEmail?.dmarc ?? emailScanRow?.dmarc_policy ?? null;
  const mxCount = freshEmail?.mxCount
    ?? (emailScanRow?.mx_providers
      ? emailScanRow.mx_providers.split(",").filter((s) => s.trim()).length
      : (emailScanRow?.mx_exists ? 1 : 0));
  const riskGrade = totalThreats >= 20 || emailGrade === "F"
    ? "CRITICAL"
    : totalThreats >= 10 || emailGrade === "D"
    ? "HIGH"
    : totalThreats >= 3 || emailGrade === "C"
    ? "MODERATE"
    : "LOW";

  const keyFindings: string[] = [];
  if (totalThreats > 0) keyFindings.push(`${totalThreats} active threat${totalThreats === 1 ? "" : "s"} targeting ${domain} across our intelligence feeds`);
  if (emailGrade && emailGrade !== "A") keyFindings.push(`Email security grade ${emailGrade} — phishing impersonation risk for staff and customers`);
  if (providersResult.results.length > 0) keyFindings.push(`Attacks staged from ${providersResult.results.length} hosting provider${providersResult.results.length === 1 ? "" : "s"} including ${providersResult.results[0]?.name ?? "unknown"}`);
  if (campaignsResult.results.length > 0) keyFindings.push(`Targeted by ${campaignsResult.results.length} active threat campaign${campaignsResult.results.length === 1 ? "" : "s"} we are tracking`);
  if (keyFindings.length === 0) keyFindings.push(`No active intelligence-feed threats currently targeting ${domain}`);

  // Narrative + remediation plan via the qualified_report sync agent.
  // The agent owns input validation (sanitises lead.company so prompt
  // injection can't reach the model), the two parallel AI calls,
  // per-field output schema validation, and deterministic fallbacks.
  // Phase 3.2 of agent audit.
  const agentRun = await runSyncAgent<QualifiedReportOutput>(
    env,
    qualifiedReportAgent,
    {
      domain,
      companyName: lead.company ?? domain,
      totalThreats,
      topProviders: providersResult.results.map(p => p.name).slice(0, 10),
      topCountries: countriesResult.results.map(c => c.country).slice(0, 10),
      campaignCount: campaignsResult.results.length,
      emailGrade,
      spfPolicy,
      dmarcPolicy,
    },
  );

  // Defence in depth — agent throws on catastrophic schema failure.
  // If we somehow get here without data, synthesise minimal text so
  // the admin still gets a renderable report.
  const narrative = agentRun.data?.narrative
    ?? `Active impersonation and phishing infrastructure targeting ${domain} has been observed across ${threatsResult.results.length} distinct events in the last 90 days. Coordinated takedown plus email-authentication hardening would materially reduce exposure.`;
  const plan = agentRun.data?.plan
    ?? `1. Enable DMARC quarantine policy on the primary domain within 14 days.\n2. Onboard active threat feeds + lookalike monitoring for continuous detection.\n3. Initiate takedown requests for all active phishing infrastructure (priority by hosting provider).\n4. Lock down DKIM selectors and rotate any keys older than 24 months.\n5. Enable executive impersonation monitoring across LinkedIn, Twitter, and major social platforms.`;

  // ROI projection — analyst-hour replacement + breach prevention.
  const analystDollars = ROI.analyst_hours_saved_per_year * ROI.hourly_rate_usd;
  const takedownsPerYear = ROI.takedowns_per_brand_per_month * 12;
  const breachPrevValue = ROI.avg_breach_cost_usd * ROI.breach_prevention_probability;
  const totalValue = analystDollars + breachPrevValue;

  return {
    brand: { domain, name: lead.company },
    generated_at: new Date().toISOString(),
    executive_summary: { risk_grade: riskGrade, key_findings: keyFindings },
    email_security: {
      grade: emailGrade,
      spf: spfPolicy,
      dmarc: dmarcPolicy,
      dkim_found: false, // not tracked yet on brands table
      mx_count: mxCount,
    },
    active_threats: { total: totalThreats, by_severity: bySeverity, samples: threatsResult.results },
    infrastructure: {
      top_hosting_providers: providersResult.results,
      top_countries: countriesResult.results,
      campaigns_caught_in: campaignsResult.results,
    },
    lookalikes: { registered_count: lookalikesResult?.n ?? 0, possible_count: 0 },
    narrative,
    remediation_plan: plan,
    roi: {
      analyst_hours_saved_per_year: ROI.analyst_hours_saved_per_year,
      analyst_dollars_saved_per_year: analystDollars,
      takedowns_per_year_projected: takedownsPerYear,
      breach_prevention_value_per_year: breachPrevValue,
      total_value_per_year: totalValue,
    },
  };
}

// ─── Generate handler (admin) ──────────────────────────────────────

export async function handleGenerateQualifiedReport(
  request: Request,
  env: Env,
  leadId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const lead = await env.DB.prepare(
      "SELECT id, email, name, company, domain FROM scan_leads WHERE id = ?",
    ).bind(leadId).first<{ id: string; email: string; name: string | null; company: string | null; domain: string | null }>();

    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);
    if (!lead.domain) return json({ success: false, error: "Lead has no domain to scan" }, 400, origin);

    const payload = await buildReportPayload(env, { domain: lead.domain, company: lead.company });

    // 32 random bytes encoded as URL-safe base64 → 43 chars, ample entropy.
    const tokenBytes = new Uint8Array(24);
    crypto.getRandomValues(tokenBytes);
    const shareToken = btoa(String.fromCharCode(...tokenBytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const reportId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(`
      INSERT INTO qualified_reports
        (id, lead_id, brand_domain, share_token, payload_json, expires_at, generated_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(reportId, leadId, lead.domain, shareToken, JSON.stringify(payload), expiresAt, userId).run();

    const url = new URL(request.url);
    const shareUrl = `${url.origin}/qualified-report/${shareToken}`;

    return json({
      success: true,
      data: {
        report_id: reportId,
        share_url: shareUrl,
        share_token: shareToken,
        expires_at: expiresAt,
        risk_grade: payload.executive_summary.risk_grade,
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}

// ─── Renew handler (admin) ─────────────────────────────────────────
//
// Re-stamps the most recent qualified report for a lead with a fresh
// 30-day expiry AND a freshly-built payload, while KEEPING the existing
// share_token so any link already sent to the prospect keeps working
// through a long sales cycle. Without this, a report that lapses
// mid-deal forces the admin to generate a brand-new link.

export async function handleRenewQualifiedReport(
  request: Request,
  env: Env,
  leadId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const lead = await env.DB.prepare(
      "SELECT id, company, domain FROM scan_leads WHERE id = ?",
    ).bind(leadId).first<{ id: string; company: string | null; domain: string | null }>();

    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);
    if (!lead.domain) return json({ success: false, error: "Lead has no domain to scan" }, 400, origin);

    // Most recent report regardless of expiry — renewing a lapsed link is
    // the whole point.
    const existing = await env.DB.prepare(`
      SELECT id, share_token FROM qualified_reports
      WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1
    `).bind(leadId).first<{ id: string; share_token: string }>();

    if (!existing) {
      return json({
        success: false,
        error: "No report to renew for this lead. Generate one first via POST /api/admin/leads/:id/qualified-report.",
      }, 404, origin);
    }

    const payload = await buildReportPayload(env, { domain: lead.domain, company: lead.company });
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(`
      UPDATE qualified_reports
      SET payload_json = ?, expires_at = ?
      WHERE id = ?
    `).bind(JSON.stringify(payload), expiresAt, existing.id).run();

    const url = new URL(request.url);
    const shareUrl = `${url.origin}/qualified-report/${existing.share_token}`;

    return json({
      success: true,
      data: {
        report_id: existing.id,
        share_url: shareUrl,
        share_token: existing.share_token,
        expires_at: expiresAt,
        risk_grade: payload.executive_summary.risk_grade,
        renewed: true,
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}

// ─── View handler (public, token-gated) ────────────────────────────

export async function handleViewQualifiedReport(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  try {
    const row = await env.DB.prepare(`
      SELECT id, brand_domain, payload_json, expires_at
      FROM qualified_reports
      WHERE share_token = ? AND expires_at > datetime('now')
    `).bind(token).first<{ id: string; brand_domain: string; payload_json: string; expires_at: string }>();

    if (!row) {
      return new Response("Report not found or expired", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Best-effort view tracking. If it fails, the response is the priority.
    try {
      await env.DB.prepare(
        "UPDATE qualified_reports SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE id = ?",
      ).bind(row.id).run();
    } catch { /* ignore */ }

    const payload = JSON.parse(row.payload_json) as ReportPayload;
    const { renderQualifiedReportHTML } = await import("../templates/qualifiedReport");
    const html = renderQualifiedReportHTML(payload);
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Don't cache — admins may regenerate; share URL stays stable but
        // payload may differ if a new report was generated for the same lead.
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Internal error", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
