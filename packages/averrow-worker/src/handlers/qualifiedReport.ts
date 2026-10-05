// Averrow — Sales-Qualified Brand Risk Plan
//
// A sharable report for a scan lead. Unlike the public free-scan
// response (public DNS facts + counts only), it contains:
//   1. Executive summary (every finding conditional on actual counts)
//   2. Email security (grade, SPF/DKIM/DMARC/MX/BIMI)
//   3. Active threats targeting the brand (no feed/source names)
//   4. Hosting infrastructure (provider names + counts; no ASNs)
//   5. Registered lookalike domains (names)
//   6. Summary + remediation plan (qualified_report agent; deterministic
//      count-conditional fallbacks under AI_MODE=rules_only)
//   7. What Averrow would watch
//   8. Illustrative analyst-time estimate
//
// Two content modes (ReportContent):
//   - "full"      — staff-generated (super_admin endpoints below): every
//                   section above.
//   - "scan_only" — auto-delivered from POST /api/leads when the lead's
//                   email host is exactly the scanned domain (H1). Carries
//                   ONLY what the public scan shows (email grade + SPF/
//                   DKIM/DMARC/MX/BIMI) and the registered lookalike NAMES
//                   that scan found (DNS-derivable, read from the linked
//                   brand_scans row). No threats, IPs, providers,
//                   campaigns, feed data or lookalike_domains rows; no
//                   threats queries; no AI call (deterministic text).
//                   Stored with generated_by = AUTO_REPORT_GENERATED_BY and
//                   deleted after 90 days with the scan
//                   (lib/brand-scan-retention.ts).
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
import { qualifiedReportAgent, deterministicNarrative, deterministicPlan } from "../agents/qualified-report";
import type { QualifiedReportInput, QualifiedReportOutput } from "../agents/qualified-report";
import { saveEmailSecurityScan, type EmailSecurityResult } from "../email-security";
import {
  isEmailGrade, parseStoredPublicView, runEmailSecurityScanWithin, EMAIL_SCAN_BUDGET_MS, AUTO_REPORT_GENERATED_BY,
  type StoredPublicView,
} from "../lib/free-scan-view";
import { normalizePublicHostname } from "../lib/public-hostname";
import type { Env } from "../types";

// Email-posture freshness: if the latest email_security_scans row for the
// lead's domain is older than this (or missing), re-scan at report-build
// time rather than serving a possibly weeks-old grade. Bounded by a
// wall-clock guard so a slow DNS lookup can't stall report generation.
const EMAIL_SCAN_STALE_MS = 14 * 24 * 60 * 60 * 1000;

export { AUTO_REPORT_GENERATED_BY };

/** What a report may contain — see the header comment. */
export type ReportContent = "full" | "scan_only";

// ─── ROI defaults ──────────────────────────────────────────────────
// Illustrative analyst-time estimate only (CLAUDE.md §13 positioning:
// replaces 2-3 analyst headcount). The old "breach prevention value"
// line (4% of an industry average breach cost) had no source for the 4%
// and was removed (Section 7, 2026-10-05). Old stored payloads still
// carry those fields; the template ignores them.
const ROI = {
  analyst_hours_saved_per_year:   3_500,           // ~70/wk × 50wk replaced
  hourly_rate_usd:                75,              // for hour-savings math
  takedowns_per_brand_per_month:  6,               // rough avg per customer
};

/** Cap on lookalike names listed in the report. */
const REPORT_LOOKALIKE_NAME_CAP = 50;

// ─── Types ─────────────────────────────────────────────────────────
//
// Prospect-facing. Deliberately carries no feed/source names, no ASNs
// and no vendor names: threat samples list type/severity/indicator/
// country/date only, providers list name + count only.

export interface ReportPayload {
  /** Absent on payloads stored before 2026-10-05 → "full". */
  content?: ReportContent;
  brand: { domain: string; name: string | null };
  generated_at: string;
  executive_summary: { risk_grade: string; key_findings: string[] };
  email_security: {
    grade: string;
    spf: string | null;
    dmarc: string | null;
    dkim_found: boolean;
    mx_count: number;
    bimi_present?: boolean | null;
  };
  /** Absent on "scan_only" reports. */
  active_threats?: {
    total: number;
    by_severity: Record<string, number>;
    samples: Array<{
      id: string;
      threat_type: string;
      severity: string | null;
      malicious_domain: string | null;
      ip_address: string | null;
      country_code: string | null;
      first_seen: string;
    }>;
  };
  /** Absent on "scan_only" reports. */
  infrastructure?: {
    top_hosting_providers: Array<{ name: string; threat_count: number }>;
    top_countries: Array<{ country: string; threat_count: number }>;
    campaigns_caught_in: Array<{ id: string; name: string; threat_count: number }>;
  };
  /**
   * `checked: false` (scan-only reports only) — no lookalike check backs
   * this report (no stored scan view), so it makes no lookalike claim and
   * the template omits the section. Absent → checked.
   */
  lookalikes: { registered_count: number; possible_count: number; names?: string[]; checked?: boolean };
  narrative: string;
  remediation_plan: string;
  watch_list?: string[];
  roi: {
    analyst_hours_saved_per_year: number;
    analyst_dollars_saved_per_year: number;
    takedowns_per_year_projected: number;
  };
}

type Sample = NonNullable<ReportPayload["active_threats"]>["samples"][number];

function parseNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** What Averrow would watch for this domain — no social-media promise. */
export function buildWatchList(domain: string, registeredLookalikes: number): string[] {
  const list: string[] = [];
  if (registeredLookalikes > 0) {
    list.push(`The ${registeredLookalikes} registered lookalike domain${registeredLookalikes === 1 ? "" : "s"} of ${domain}: new mail servers, new web content, new certificates, and phishing pages going live.`);
  }
  list.push(`New lookalike domains of ${domain} as they are registered.`);
  list.push(`Changes to the email authentication records of ${domain} (SPF, DKIM, DMARC, BIMI), so a weakened policy is caught quickly.`);
  list.push(`Phishing and impersonation sites that use the ${domain} name or brand, with takedown requests when they appear.`);
  return list;
}

function emailFromView(view: StoredPublicView): ReportPayload["email_security"] {
  const e = view.email;
  return {
    grade: e.grade,
    spf: e.spf.status,
    dmarc: e.dmarc.policy,
    dkim_found: e.dkim.found,
    mx_count: e.mx.present ? 1 : 0,
    bimi_present: e.bimi.present,
  };
}

function emailFromEngine(scan: EmailSecurityResult): ReportPayload["email_security"] {
  return {
    grade: scan.grade,
    spf: scan.spf.policy ?? (scan.spf.exists ? "neutral" : null),
    dmarc: scan.dmarc.exists ? scan.dmarc.policy : null,
    dkim_found: scan.dkim.exists,
    mx_count: scan.mx.exists ? Math.max(1, scan.mx.providers.length) : 0,
    bimi_present: scan.bimi.record !== null,
  };
}

function roiBlock(): ReportPayload["roi"] {
  return {
    analyst_hours_saved_per_year: ROI.analyst_hours_saved_per_year,
    analyst_dollars_saved_per_year: ROI.analyst_hours_saved_per_year * ROI.hourly_rate_usd,
    takedowns_per_year_projected: ROI.takedowns_per_brand_per_month * 12,
  };
}

function riskGradeFor(totalThreats: number, emailGrade: string, registeredLookalikes: number): string {
  return totalThreats >= 20 || emailGrade === "F"
    ? "CRITICAL"
    : totalThreats >= 10 || emailGrade === "D"
    ? "HIGH"
    : totalThreats >= 3 || emailGrade === "C" || registeredLookalikes >= 5
    ? "MODERATE"
    : "LOW";
}

// ─── Data aggregation ──────────────────────────────────────────────

export async function buildReportPayload(
  env: Env,
  lead: { domain: string; company: string | null; scanId?: string | null },
  opts: { content?: ReportContent } = {},
): Promise<ReportPayload> {
  return opts.content === "scan_only"
    ? buildScanOnlyReportPayload(env, lead)
    : buildFullReportPayload(env, lead);
}

/** Deterministic summary for a scan-only report. Makes no claim about Averrow threat data. */
export function scanOnlyNarrative(
  domain: string, registeredLookalikes: number, emailGrade: string, lookalikesChecked = true,
): string {
  const parts: string[] = [
    lookalikesChecked
      ? `This report covers what the free scan of ${domain} checked from public DNS: email authentication and registered lookalike domains.`
      : `This report covers what was checked for ${domain} from public DNS: email authentication.`,
  ];
  if (!lookalikesChecked) {
    // No lookalike check backs this report — make no claim either way.
  } else if (registeredLookalikes > 0) {
    parts.push(`${registeredLookalikes} lookalike domain${registeredLookalikes === 1 ? " is" : "s are"} registered that could be used to impersonate ${domain}; registration alone is not proof of abuse, but each one is worth watching.`);
  } else {
    parts.push("None of the lookalike domains the scan checked are registered.");
  }
  if (emailGrade === "A" || emailGrade === "A+") {
    parts.push(`Email authentication is strong (grade ${emailGrade}).`);
  } else {
    parts.push(`Email authentication grades ${emailGrade}, so spoofed mail claiming to come from ${domain} is harder for recipients to reject.`);
  }
  parts.push("For a review of active impersonation targeting your brand, reply to the email this report came with.");
  return parts.join(" ");
}

/**
 * Scan-only report (auto-delivery, H1). Reads ONLY the linked free scan
 * (brand_scans by id, else the latest public scan of the domain). No
 * brands / threats / lookalike_domains / email_security_scans reads, no
 * writes, no AI call. Throws when there is no email posture to report
 * (no stored scan and the time-boxed live scan failed) so the caller
 * falls back to a team follow-up rather than mailing a guessed grade.
 */
async function buildScanOnlyReportPayload(
  env: Env,
  lead: { domain: string; company: string | null; scanId?: string | null },
): Promise<ReportPayload> {
  const domain = lead.domain.toLowerCase().trim();
  const scanRow = await (lead.scanId
    ? env.DB.prepare(`
        SELECT registered_lookalikes, public_view FROM brand_scans WHERE id = ? AND domain = ?
      `).bind(lead.scanId, domain)
    : env.DB.prepare(`
        SELECT registered_lookalikes, public_view FROM brand_scans
        WHERE domain = ? AND public_view IS NOT NULL ORDER BY created_at DESC LIMIT 1
      `).bind(domain)
  ).first<{ registered_lookalikes: string | null; public_view: string | null }>();

  const view = parseStoredPublicView(scanRow?.public_view ?? null);
  const email = view ? emailFromView(view) : emailFromEngine(await runEmailSecurityScanWithin(domain, EMAIL_SCAN_BUDGET_MS));
  // A lookalike claim ("none registered") needs a scan that actually ran
  // the lookalike check. Without one the report says nothing about
  // lookalikes rather than implying a clean result.
  const lookalikesChecked = view !== null && view.lookalikes.checked > 0;

  // Only names the scan itself found registered, re-validated as plain hostnames.
  const names = [...new Set(
    parseNames(view ? scanRow?.registered_lookalikes : null)
      .filter((d) => normalizePublicHostname(d) === d),
  )].sort().slice(0, REPORT_LOOKALIKE_NAME_CAP);
  const registeredLookalikes = names.length;
  const emailGrade = isEmailGrade(email.grade) ? email.grade : "F";

  const keyFindings: string[] = [];
  if (registeredLookalikes > 0) keyFindings.push(`${registeredLookalikes} registered lookalike domain${registeredLookalikes === 1 ? "" : "s"} resembling ${domain}`);
  if (emailGrade !== "A" && emailGrade !== "A+") keyFindings.push(`Email security grade ${emailGrade} — gaps in email authentication make ${domain} easier to spoof`);
  if (keyFindings.length === 0) {
    keyFindings.push(lookalikesChecked
      ? `Email authentication for ${domain} is strong and none of the lookalike domains the scan checked are registered`
      : `Email authentication for ${domain} is strong`);
  }

  const plan = deterministicPlan({
    domain,
    companyName: domain,
    totalThreats: 0,
    topProviders: [],
    topCountries: [],
    campaignCount: 0,
    registeredLookalikes,
    emailGrade,
    spfPolicy: email.spf,
    dmarcPolicy: email.dmarc,
  });

  return {
    content: "scan_only",
    brand: { domain, name: lead.company },
    generated_at: new Date().toISOString(),
    executive_summary: { risk_grade: riskGradeFor(0, emailGrade, registeredLookalikes), key_findings: keyFindings },
    email_security: email,
    lookalikes: lookalikesChecked
      ? { registered_count: registeredLookalikes, possible_count: view?.lookalikes.checked ?? 0, names, checked: true }
      : { registered_count: 0, possible_count: 0, names: [], checked: false },
    narrative: scanOnlyNarrative(domain, registeredLookalikes, emailGrade, lookalikesChecked),
    remediation_plan: plan,
    watch_list: buildWatchList(domain, registeredLookalikes),
    roi: roiBlock(),
  };
}

async function buildFullReportPayload(
  env: Env,
  lead: { domain: string; company: string | null; scanId?: string | null },
): Promise<ReportPayload> {
  const domain = lead.domain.toLowerCase().trim();

  // Brand first (idx_brands_domain). Threat + lookalike reads are scoped
  // by brand id so they ride idx_threats_brand_* / idx_lookalike_brand_domain
  // instead of a leading-wildcard LIKE over threats (a full scan). This
  // report is now also generated from the public lead form, so it must
  // stay cheap.
  const brandRow = await env.DB.prepare(`
    SELECT id, name, email_security_grade
    FROM brands WHERE canonical_domain = ? LIMIT 1
  `).bind(domain).first<{ id: string | number; name: string; email_security_grade: string | null }>();
  const brandId = brandRow?.id ?? null;

  const none = <T>() => Promise.resolve({ results: [] as T[] });
  const [
    threatsResult, severityResult, providersResult, countriesResult, campaignsResult,
    lookalikeCounts, platformLookalikes, emailScanRow, scanRow,
  ] = await Promise.all([
    brandId != null ? env.DB.prepare(`
      SELECT id, threat_type, severity, malicious_domain, ip_address, country_code, created_at AS first_seen
      FROM threats WHERE target_brand_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 50
    `).bind(brandId).all<Sample>() : none<Sample>(),
    brandId != null ? env.DB.prepare(`
      SELECT severity, COUNT(*) AS n FROM threats
      WHERE target_brand_id = ? AND status = 'active' GROUP BY severity
    `).bind(brandId).all<{ severity: string | null; n: number }>() : none<{ severity: string | null; n: number }>(),
    brandId != null ? env.DB.prepare(`
      SELECT hp.name, COUNT(*) AS threat_count
      FROM threats t JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE t.target_brand_id = ? AND t.status = 'active'
      GROUP BY hp.id ORDER BY threat_count DESC LIMIT 10
    `).bind(brandId).all<{ name: string; threat_count: number }>() : none<{ name: string; threat_count: number }>(),
    brandId != null ? env.DB.prepare(`
      SELECT country_code AS country, COUNT(*) AS threat_count FROM threats
      WHERE target_brand_id = ? AND status = 'active' AND country_code IS NOT NULL
      GROUP BY country_code ORDER BY threat_count DESC LIMIT 10
    `).bind(brandId).all<{ country: string; threat_count: number }>() : none<{ country: string; threat_count: number }>(),
    brandId != null ? env.DB.prepare(`
      SELECT c.id, c.name, COUNT(*) AS threat_count
      FROM threats t JOIN campaigns c ON c.id = t.campaign_id
      WHERE t.target_brand_id = ? AND t.status = 'active'
      GROUP BY c.id ORDER BY threat_count DESC LIMIT 5
    `).bind(brandId).all<{ id: string; name: string; threat_count: number }>() : none<{ id: string; name: string; threat_count: number }>(),
    // lookalike_domains is keyed by brand_id (there is no target_brand column).
    brandId != null ? env.DB.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN registered = 1 THEN 1 ELSE 0 END) AS registered
      FROM lookalike_domains WHERE brand_id = ? AND COALESCE(status, 'monitoring') != 'benign'
    `).bind(brandId).first<{ total: number | null; registered: number | null }>() : Promise.resolve(null),
    brandId != null ? env.DB.prepare(`
      SELECT domain FROM lookalike_domains
      WHERE brand_id = ? AND registered = 1 AND COALESCE(status, 'monitoring') != 'benign'
      ORDER BY domain LIMIT ?
    `).bind(brandId, REPORT_LOOKALIKE_NAME_CAP).all<{ domain: string }>() : none<{ domain: string }>(),
    env.DB.prepare(`
      SELECT spf_policy, dmarc_policy, dkim_exists, mx_exists, mx_providers, email_security_grade, scanned_at
      FROM email_security_scans WHERE domain = ?
      ORDER BY scanned_at DESC LIMIT 1
    `).bind(domain).first<{ spf_policy: string | null; dmarc_policy: string | null; dkim_exists: number | null; mx_exists: number | null; mx_providers: string | null; email_security_grade: string | null; scanned_at: string | null }>(),
    // The free scan this lead came from, else the latest free scan of the
    // domain (idx_brand_scans_domain). Holds the registered lookalike names
    // and the email view checked at scan time.
    lead.scanId
      ? env.DB.prepare(`
          SELECT registered_lookalikes, public_view FROM brand_scans WHERE id = ? AND domain = ?
        `).bind(lead.scanId, domain).first<{ registered_lookalikes: string | null; public_view: string | null }>()
      : env.DB.prepare(`
          SELECT registered_lookalikes, public_view FROM brand_scans
          WHERE domain = ? AND public_view IS NOT NULL ORDER BY created_at DESC LIMIT 1
        `).bind(domain).first<{ registered_lookalikes: string | null; public_view: string | null }>(),
  ]);

  // ── Email posture ────────────────────────────────────────────────
  // 1. The free scan's own email view (checked minutes ago, has DKIM/BIMI).
  // 2. Otherwise the latest stored scan, re-scanned when stale (B6),
  //    best-effort and time-boxed.
  const scanView = parseStoredPublicView(scanRow?.public_view ?? null);
  let email: ReportPayload["email_security"];
  if (scanView) {
    email = emailFromView(scanView);
  } else {
    let fresh: ReportPayload["email_security"] | null = null;
    const scanAgeMs = emailScanRow?.scanned_at
      ? Date.now() - new Date(emailScanRow.scanned_at).getTime()
      : Infinity;
    if (scanAgeMs > EMAIL_SCAN_STALE_MS) {
      try {
        const scan = await runEmailSecurityScanWithin(domain, EMAIL_SCAN_BUDGET_MS);
        fresh = emailFromEngine(scan);
        // Persist for next time (brand_id is required on the scans table).
        if (brandId != null) {
          try { await saveEmailSecurityScan(env.DB, brandId, scan); } catch { /* ignore */ }
        }
      } catch { /* keep cached values */ }
    }
    email = fresh ?? {
      grade: emailScanRow?.email_security_grade ?? brandRow?.email_security_grade ?? "F",
      spf: emailScanRow?.spf_policy ?? null,
      dmarc: emailScanRow?.dmarc_policy ?? null,
      dkim_found: emailScanRow?.dkim_exists === 1,
      mx_count: emailScanRow?.mx_providers
        ? Math.max(emailScanRow.mx_exists ? 1 : 0, parseNames(emailScanRow.mx_providers).length)
        : (emailScanRow?.mx_exists ? 1 : 0),
      bimi_present: null,
    };
  }
  const emailGrade = email.grade;

  // ── Threats ─────────────────────────────────────────────────────
  const bySeverity: Record<string, number> = {};
  let totalThreats = 0;
  for (const row of severityResult.results) {
    bySeverity[row.severity ?? "unknown"] = row.n;
    totalThreats += row.n;
  }

  // ── Lookalikes: free-scan names ∪ platform-tracked registered names ──
  const names = [...new Set([
    ...parseNames(scanRow?.registered_lookalikes),
    ...platformLookalikes.results.map((r) => r.domain),
  ])].sort().slice(0, REPORT_LOOKALIKE_NAME_CAP);
  const registeredLookalikes = Math.max(names.length, lookalikeCounts?.registered ?? 0);

  const riskGrade = riskGradeFor(totalThreats, emailGrade, registeredLookalikes);

  // Every finding is conditional on an actual count.
  const keyFindings: string[] = [];
  if (totalThreats > 0) keyFindings.push(`${totalThreats} active threat${totalThreats === 1 ? "" : "s"} targeting ${domain} recorded by Averrow`);
  if (registeredLookalikes > 0) keyFindings.push(`${registeredLookalikes} registered lookalike domain${registeredLookalikes === 1 ? "" : "s"} resembling ${domain}`);
  if (emailGrade !== "A" && emailGrade !== "A+") keyFindings.push(`Email security grade ${emailGrade} — gaps in email authentication make ${domain} easier to spoof`);
  if (providersResult.results.length > 0) keyFindings.push(`Malicious infrastructure hosted across ${providersResult.results.length} hosting provider${providersResult.results.length === 1 ? "" : "s"}`);
  if (campaignsResult.results.length > 0) keyFindings.push(`Linked to ${campaignsResult.results.length} active campaign${campaignsResult.results.length === 1 ? "" : "s"} Averrow is tracking`);
  if (totalThreats === 0 && registeredLookalikes === 0) keyFindings.push(`No active threats or registered lookalike domains targeting ${domain} were found when this report was generated`);

  // Narrative + remediation plan via the qualified_report sync agent
  // (input sanitising, AI calls, schema checks, deterministic,
  // count-conditional fallbacks).
  const agentInput: QualifiedReportInput = {
    domain,
    companyName: lead.company ?? domain,
    totalThreats,
    topProviders: providersResult.results.map((p) => p.name).slice(0, 10),
    topCountries: countriesResult.results.map((c) => c.country).slice(0, 10),
    campaignCount: campaignsResult.results.length,
    registeredLookalikes,
    emailGrade: isEmailGrade(emailGrade) ? emailGrade : "F",
    spfPolicy: email.spf,
    dmarcPolicy: email.dmarc,
  };
  let ai: QualifiedReportOutput | null = null;
  try {
    ai = (await runSyncAgent<QualifiedReportOutput>(env, qualifiedReportAgent, agentInput)).data;
  } catch { ai = null; }
  const narrative = ai?.narrative ?? deterministicNarrative(agentInput);
  const plan = ai?.plan ?? deterministicPlan(agentInput);

  return {
    content: "full",
    brand: { domain, name: lead.company },
    generated_at: new Date().toISOString(),
    executive_summary: { risk_grade: riskGrade, key_findings: keyFindings },
    email_security: email,
    active_threats: { total: totalThreats, by_severity: bySeverity, samples: threatsResult.results },
    infrastructure: {
      top_hosting_providers: providersResult.results,
      top_countries: countriesResult.results,
      campaigns_caught_in: campaignsResult.results,
    },
    lookalikes: {
      registered_count: registeredLookalikes,
      possible_count: lookalikeCounts?.total ?? 0,
      names,
    },
    narrative,
    remediation_plan: plan,
    watch_list: buildWatchList(domain, registeredLookalikes),
    roi: roiBlock(),
  };
}

// ─── Create + store a report ───────────────────────────────────────

export interface CreatedReport {
  reportId: string;
  shareToken: string;
  shareUrl: string;
  expiresAt: string;
  riskGrade: string;
  /** The stored snapshot. */
  payload: ReportPayload;
}

/**
 * Build, snapshot and store a report; returns its share link. Used by
 * the admin generate endpoint ("full") and by lead-capture auto-delivery
 * (generatedBy AUTO_REPORT_GENERATED_BY, content "scan_only").
 */
export async function createQualifiedReport(
  env: Env,
  p: {
    leadId: string; domain: string; company: string | null; scanId?: string | null;
    generatedBy: string; appOrigin: string; content?: ReportContent;
  },
): Promise<CreatedReport> {
  const payload = await buildReportPayload(
    env, { domain: p.domain, company: p.company, scanId: p.scanId ?? null }, { content: p.content ?? "full" },
  );

  // 24 random bytes encoded as URL-safe base64 → 32 chars.
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
  `).bind(reportId, p.leadId, p.domain, shareToken, JSON.stringify(payload), expiresAt, p.generatedBy).run();

  return {
    reportId,
    shareToken,
    shareUrl: `${p.appOrigin}/qualified-report/${shareToken}`,
    expiresAt,
    riskGrade: payload.executive_summary.risk_grade,
    payload,
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
      "SELECT id, company, domain, scan_id FROM scan_leads WHERE id = ?",
    ).bind(leadId).first<{ id: string; company: string | null; domain: string | null; scan_id: string | null }>();

    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);
    if (!lead.domain) return json({ success: false, error: "Lead has no domain to scan" }, 400, origin);

    const report = await createQualifiedReport(env, {
      leadId,
      domain: lead.domain,
      company: lead.company,
      scanId: lead.scan_id,
      generatedBy: userId,
      appOrigin: new URL(request.url).origin,
    });

    return json({
      success: true,
      data: {
        report_id: report.reportId,
        share_url: report.shareUrl,
        share_token: report.shareToken,
        expires_at: report.expiresAt,
        risk_grade: report.riskGrade,
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
      "SELECT id, company, domain, scan_id FROM scan_leads WHERE id = ?",
    ).bind(leadId).first<{ id: string; company: string | null; domain: string | null; scan_id: string | null }>();

    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);
    if (!lead.domain) return json({ success: false, error: "Lead has no domain to scan" }, 400, origin);

    // Most recent report regardless of expiry — renewing a lapsed link is
    // the whole point.
    const existing = await env.DB.prepare(`
      SELECT id, share_token, generated_by, json_extract(payload_json, '$.content') AS content
      FROM qualified_reports
      WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).bind(leadId).first<{ id: string; share_token: string; generated_by: string | null; content: string | null }>();

    if (!existing) {
      return json({
        success: false,
        error: "No report to renew for this lead. Generate one first via POST /api/admin/leads/:id/qualified-report.",
      }, 404, origin);
    }

    // The share link may already be in the prospect's inbox: a scan-only
    // report (auto-delivered, or staff-sent to an address that does not
    // match the scanned domain) stays scan-only when renewed. Staff who
    // want the full content generate a new report.
    const content: ReportContent =
      existing.generated_by === AUTO_REPORT_GENERATED_BY || existing.content === "scan_only" ? "scan_only" : "full";
    const payload = await buildReportPayload(
      env, { domain: lead.domain, company: lead.company, scanId: lead.scan_id }, { content },
    );
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // An auto report's retention (lib/brand-scan-retention.ts, 90 days on
    // created_at) runs from its latest snapshot, so renewing it resets
    // created_at; staff reports keep their original creation time.
    await env.DB.prepare(`
      UPDATE qualified_reports
      SET payload_json = ?, expires_at = ?,
          created_at = CASE WHEN generated_by = ? THEN datetime('now') ELSE created_at END
      WHERE id = ?
    `).bind(JSON.stringify(payload), expiresAt, AUTO_REPORT_GENERATED_BY, existing.id).run();

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
