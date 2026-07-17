// Tenant weekly digest — email builder (S4, docs/IMPROVEMENT_PLAN_2026-06.md).
//
// Pure HTML construction over a pre-collected OrgDigestData snapshot so the
// rendering is unit-testable without DB or network. Transport (Resend) lives
// at the bottom, mirroring lib/briefing-email.ts.
//
// One email per org per week, covering only the org's brands whose
// monitoring config has weekly_digest=true. All numbers are 7-day windows.

import type { Env } from "../types";
import { emailShell, escapeHtml } from "./email-layout";

const FROM_ADDRESS = "Averrow Intelligence <digest@averrow.com>";

const COLOR = {
  bgCard:   "#111A2C",
  border:   "rgba(255,255,255,0.07)",
  text:     "#E8ECF2",
  textDim:  "#9AAABF",
  amber:    "#E5A832",
  red:      "#F87171",
  orange:   "#FB923C",
  yellow:   "#FBBF24",
  blue:     "#60A5FA",
  green:    "#34D399",
} as const;

const SEVERITY_COLOR: Record<string, string> = {
  critical: COLOR.red,
  high:     COLOR.orange,
  medium:   COLOR.yellow,
  low:      COLOR.blue,
};

export interface BrandDigestData {
  brandId:    string;
  brandName:  string;
  newThreats: number;
  threatsBySeverity: Partial<Record<"critical" | "high" | "medium" | "low", number>>;
  topThreats: Array<{ indicator: string; threat_type: string; severity: string }>;
  alertsOpened:   number;
  alertsResolved: number;
  emailGrade:     string | null;
}

export interface OrgDigestData {
  orgName:      string;
  weekStartIso: string; // inclusive, YYYY-MM-DD
  weekEndIso:   string; // inclusive, YYYY-MM-DD
  brands:       BrandDigestData[];
  takedowns: {
    submitted: number;
    completed: number;
    pending:   number;
  };
}

export interface DigestEmail {
  subject:   string;
  preheader: string;
  html:      string;
}

function severityChips(by: BrandDigestData["threatsBySeverity"]): string {
  const parts: string[] = [];
  for (const sev of ["critical", "high", "medium", "low"] as const) {
    const n = by[sev] ?? 0;
    if (n === 0) continue;
    parts.push(
      `<span style="color:${SEVERITY_COLOR[sev]};font-weight:700;">${n} ${sev}</span>`,
    );
  }
  return parts.length ? parts.join('<span style="color:#3a4458;"> · </span>') : `<span style="color:${COLOR.textDim};">none</span>`;
}

function brandCard(b: BrandDigestData): string {
  const topRows = b.topThreats
    .map(
      (t) => `<tr>
        <td style="padding:4px 0;color:${COLOR.text};font-family:monospace;font-size:13px;word-break:break-all;">${escapeHtml(t.indicator)}</td>
        <td style="padding:4px 0 4px 12px;color:${COLOR.textDim};font-size:12px;white-space:nowrap;">${escapeHtml(t.threat_type)}</td>
        <td style="padding:4px 0 4px 12px;color:${SEVERITY_COLOR[t.severity] ?? COLOR.textDim};font-size:12px;text-transform:uppercase;white-space:nowrap;">${escapeHtml(t.severity)}</td>
      </tr>`,
    )
    .join("");

  const gradeChip = b.emailGrade
    ? `<span style="color:${b.emailGrade.startsWith("A") || b.emailGrade.startsWith("B") ? COLOR.green : COLOR.orange};font-weight:700;">${escapeHtml(b.emailGrade)}</span>`
    : `<span style="color:${COLOR.textDim};">—</span>`;

  return `
  <div style="background:${COLOR.bgCard};border:1px solid ${COLOR.border};border-radius:10px;padding:16px 18px;margin:0 0 14px 0;">
    <div style="font-size:15px;font-weight:700;color:${COLOR.text};margin-bottom:10px;">${escapeHtml(b.brandName)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
      <tr>
        <td style="color:${COLOR.textDim};padding:2px 0;">New threats (7d)</td>
        <td style="text-align:right;color:${COLOR.text};font-weight:700;">${b.newThreats}</td>
      </tr>
      <tr>
        <td style="color:${COLOR.textDim};padding:2px 0;">By severity</td>
        <td style="text-align:right;">${severityChips(b.threatsBySeverity)}</td>
      </tr>
      <tr>
        <td style="color:${COLOR.textDim};padding:2px 0;">Alerts opened / resolved</td>
        <td style="text-align:right;color:${COLOR.text};">${b.alertsOpened} / ${b.alertsResolved}</td>
      </tr>
      <tr>
        <td style="color:${COLOR.textDim};padding:2px 0;">Email security grade</td>
        <td style="text-align:right;">${gradeChip}</td>
      </tr>
    </table>
    ${
      topRows
        ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid ${COLOR.border};">
             <div style="color:${COLOR.textDim};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;">Top new threats</div>
             <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${topRows}</table>
           </div>`
        : ""
    }
  </div>`;
}

export function buildTenantDigestEmail(data: OrgDigestData): DigestEmail {
  const totalNew = data.brands.reduce((s, b) => s + b.newThreats, 0);
  const subject = `Averrow weekly digest — ${totalNew} new threat${totalNew === 1 ? "" : "s"} across ${data.brands.length} brand${data.brands.length === 1 ? "" : "s"}`;
  const preheader = `Week ${data.weekStartIso} – ${data.weekEndIso}: ${totalNew} new threats, ${data.takedowns.submitted} takedowns submitted.`;

  const body = `
    <div style="color:${COLOR.textDim};font-size:13px;margin:0 0 16px 0;">
      Weekly protection summary for <span style="color:${COLOR.text};font-weight:700;">${escapeHtml(data.orgName)}</span>
      &nbsp;·&nbsp; ${data.weekStartIso} – ${data.weekEndIso}
    </div>

    <div style="background:${COLOR.bgCard};border:1px solid ${COLOR.border};border-radius:10px;padding:16px 18px;margin:0 0 14px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
        <tr>
          <td style="color:${COLOR.textDim};padding:2px 0;">Takedowns submitted (7d)</td>
          <td style="text-align:right;color:${COLOR.text};font-weight:700;">${data.takedowns.submitted}</td>
        </tr>
        <tr>
          <td style="color:${COLOR.textDim};padding:2px 0;">Takedowns completed (7d)</td>
          <td style="text-align:right;color:${COLOR.green};font-weight:700;">${data.takedowns.completed}</td>
        </tr>
        <tr>
          <td style="color:${COLOR.textDim};padding:2px 0;">Takedowns in flight</td>
          <td style="text-align:right;color:${COLOR.text};">${data.takedowns.pending}</td>
        </tr>
      </table>
    </div>

    ${data.brands.map(brandCard).join("")}

    <div style="color:${COLOR.textDim};font-size:12px;margin-top:18px;">
      You receive this because weekly digest is enabled for these brands.
      Manage delivery in <a href="https://averrow.com/tenant/settings" style="color:${COLOR.amber};">notification settings</a>.
    </div>`;

  const html = emailShell({
    title:     subject,
    preheader,
    tagline:   "WEEKLY PROTECTION DIGEST",
    body,
    footerNote: `Sent to members of ${escapeHtml(data.orgName)} · Averrow brand protection`,
  });

  return { subject, preheader, html };
}

export interface DigestSendResult {
  ok:     boolean;
  id?:    string;
  error?: string;
}

/** Plain Resend transport (mirrors briefing-email). Never throws. */
export async function sendDigestEmail(
  env: Env,
  to: string,
  email: DigestEmail,
): Promise<DigestSendResult> {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not configured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:    FROM_ADDRESS,
        to:      [to],
        subject: email.subject,
        html:    email.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res
      .json<{ id?: string; message?: string }>()
      .catch(() => ({}) as { id?: string; message?: string });
    if (!res.ok) return { ok: false, error: json.message ?? `Resend HTTP ${res.status}` };
    return { ok: true, id: json.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
