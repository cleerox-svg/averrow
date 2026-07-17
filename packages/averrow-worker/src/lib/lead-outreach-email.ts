// Sales outreach email — sent post-call after a scan_leads row is
// qualified. Carries the qualified-report share URL plus a teaser
// pulled from the report payload (risk grade + top 3 key findings).
//
// Sent from sales@averrow.com (per product decision). The Resend
// domain must have an MX record + DMARC allowing this sender; if not
// configured, the call returns ok:false with the upstream error.

import { logger } from "./logger";

const FROM_ADDRESS = "Averrow Sales <sales@averrow.com>";

interface LeadOutreachEmailParams {
  recipientEmail: string;
  recipientName: string | null;
  brandName: string;
  brandDomain: string;
  riskGrade: string;
  keyFindings: string[];
  qualifiedReportUrl: string;
  senderName: string | null;     // resolved from the super_admin user record
  unsubscribeUrl: string;
}

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
}

export async function sendLeadOutreachEmail(
  apiKey: string,
  params: LeadOutreachEmailParams,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const subject = `Brand Risk Plan for ${params.brandName} — ${params.riskGrade} exposure detected`;
  const html = buildOutreachHtml(params);
  const text = buildOutreachText(params);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [params.recipientEmail],
      subject,
      html,
      text,
    }),
  });

  const body = (await res.json()) as ResendResponse;
  if (!res.ok) {
    const error = body.message ?? body.error ?? `HTTP ${res.status}`;
    logger.error("lead-outreach-email", { to: params.recipientEmail, error });
    return { ok: false, error };
  }

  logger.info("lead-outreach-email", { to: params.recipientEmail, resendId: body.id });
  return { ok: true, id: body.id };
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function buildOutreachHtml(p: LeadOutreachEmailParams): string {
  const findings = p.keyFindings.slice(0, 3).map((f) => `<li style="margin: 6px 0;">${escapeHtml(f)}</li>`).join("");
  const greeting = p.recipientName ? `Hi ${escapeHtml(p.recipientName)},` : `Hello,`;
  const senderLine = p.senderName ? `${escapeHtml(p.senderName)}<br>Averrow` : `The Averrow team`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;background:#fff;color:#222;line-height:1.6;">
    <div style="color:#E5A832;font-weight:600;letter-spacing:2px;font-size:11px;text-transform:uppercase;margin-bottom:16px;">Averrow · Brand Risk Plan</div>
    <h2 style="font-size:20px;margin:0 0 16px;color:#111;">${greeting}</h2>
    <p>We ran a brand-exposure assessment on <strong>${escapeHtml(p.brandDomain)}</strong> using our threat-intelligence platform. The full plan is attached at the link below — three findings worth flagging up front:</p>
    <div style="background:#fff8e6;border-left:3px solid #E5A832;padding:12px 16px;margin:16px 0;">
      <div style="font-weight:600;color:#111;margin-bottom:6px;">Risk grade: ${escapeHtml(p.riskGrade)}</div>
      <ul style="margin:0;padding-left:20px;color:#444;">${findings}</ul>
    </div>
    <p>The full Brand Risk Plan covers active threats targeting ${escapeHtml(p.brandName)}, infrastructure used to stage attacks, recommended remediation steps, and projected ROI for moving onto the platform:</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(p.qualifiedReportUrl)}"
         style="display:inline-block;background:#E5A832;color:#111;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:4px;">
        View the Brand Risk Plan →
      </a>
    </div>
    <p style="color:#555;font-size:14px;">This link is valid for 30 days. Reply to this email and I'll set up time to walk through the findings.</p>
    <p style="margin:24px 0 0;color:#222;">— ${senderLine}</p>
    <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;">
    <div style="color:#888;font-size:11px;text-align:center;">
      Averrow · LRX Enterprises Inc.<br>
      <a href="${escapeHtml(p.unsubscribeUrl)}" style="color:#888;">Unsubscribe</a>
    </div>
  </div>
</body></html>`;
}

function buildOutreachText(p: LeadOutreachEmailParams): string {
  const greeting = p.recipientName ? `Hi ${p.recipientName},` : `Hello,`;
  const findings = p.keyFindings.slice(0, 3).map((f, i) => `  ${i + 1}. ${f}`).join("\n");
  const senderLine = p.senderName ? `— ${p.senderName}\n  Averrow` : `— The Averrow team`;
  return [
    greeting,
    "",
    `We ran a brand-exposure assessment on ${p.brandDomain} using our threat-intelligence platform. The full plan is at the link below — three findings worth flagging up front:`,
    "",
    `Risk grade: ${p.riskGrade}`,
    findings,
    "",
    `The full Brand Risk Plan covers active threats targeting ${p.brandName}, infrastructure used to stage attacks, recommended remediation steps, and projected ROI for moving onto the platform.`,
    "",
    `View the Brand Risk Plan: ${p.qualifiedReportUrl}`,
    "",
    `This link is valid for 30 days. Reply to this email and I'll set up time to walk through the findings.`,
    "",
    senderLine,
    "",
    "—",
    "Averrow · LRX Enterprises Inc.",
    `Unsubscribe: ${p.unsubscribeUrl}`,
  ].join("\n");
}
