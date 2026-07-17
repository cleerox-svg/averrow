// New-lead notification — emails sales@averrow.com when a public scan
// submission lands in scan_leads.
//
// Decoupled from the in-app notification system (lib/notifications.ts)
// which has known schema-CHECK gaps for non-user-toggleable events.
// Direct email keeps delivery reliable while that gets sorted.
//
// Failures here are non-fatal — the lead INSERT must succeed even if
// the alert email throws (the prospect already submitted, they
// shouldn't see an error if our internal pipeline hiccups). Caller
// wraps in try/catch.
//
// FROM address matches the outreach email so threading stays clean.

import type { Env } from "../types";
import { logger } from "./logger";

const FROM_ADDRESS = "Averrow Sales <sales@averrow.com>";
const NOTIFY_TO = "sales@averrow.com";

interface NewLeadNotifyParams {
  leadId: string;
  email: string;
  name: string | null;
  company: string | null;
  domain: string | null;
  phone: string | null;
  message: string | null;
  correlatedBrandId: string | null;
  adminUrlBase: string;
}

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
}

export async function notifySalesOfNewLead(
  env: Env,
  params: NewLeadNotifyParams,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.RESEND_API_KEY) {
    logger.warn("scan-lead-notify-skipped", { leadId: params.leadId, reason: "no RESEND_API_KEY" });
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const subject = params.correlatedBrandId
    ? `New scan lead — ${params.email} (already-monitored brand)`
    : `New scan lead — ${params.email}`;

  // Scan Leads now lives as a tab inside the Leads page; deep-link
  // straight into it via `?view=scan`. The legacy /v2/admin/scan-leads
  // route still resolves (it redirects here) so older emails keep
  // working.
  const adminLink = `${params.adminUrlBase}/v2/leads?view=scan`;
  const html = buildHtml({ ...params, adminLink });
  const text = buildText({ ...params, adminLink });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [NOTIFY_TO],
      subject,
      html,
      text,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as ResendResponse;
  if (!res.ok) {
    const error = body.message ?? body.error ?? `HTTP ${res.status}`;
    logger.error("scan-lead-notify", { leadId: params.leadId, error });
    return { ok: false, error };
  }
  logger.info("scan-lead-notify", { leadId: params.leadId, resendId: body.id });
  return { ok: true, id: body.id };
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function buildHtml(p: NewLeadNotifyParams & { adminLink: string }): string {
  const correlatedBadge = p.correlatedBrandId
    ? `<span style="background:#fff8e6;color:#b07c00;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;">Already monitored</span>`
    : `<span style="background:#e6f7ee;color:#1a6b3c;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;">New brand</span>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;color:#222;line-height:1.6;">
    <div style="color:#E5A832;font-weight:600;letter-spacing:2px;font-size:11px;text-transform:uppercase;margin-bottom:12px;">New Scan Lead · Averrow</div>
    <h2 style="font-size:18px;margin:0 0 16px;color:#111;">A new lead just submitted the scan form</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#666;width:30%;">Email</td><td style="padding:6px 0;"><strong>${escapeHtml(p.email)}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#666;">Name</td><td style="padding:6px 0;">${escapeHtml(p.name ?? "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Company</td><td style="padding:6px 0;">${escapeHtml(p.company ?? "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Domain</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(p.domain ?? "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Phone</td><td style="padding:6px 0;">${escapeHtml(p.phone ?? "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Brand status</td><td style="padding:6px 0;">${correlatedBadge}</td></tr>
    </table>
    ${p.message ? `<div style="margin-top:16px;padding:12px;background:#f7f7f7;border-left:3px solid #E5A832;font-size:13px;"><strong>Message:</strong> ${escapeHtml(p.message)}</div>` : ""}
    <div style="text-align:center;margin:24px 0 0;">
      <a href="${escapeHtml(p.adminLink)}" style="display:inline-block;background:#E5A832;color:#111;text-decoration:none;font-weight:600;padding:10px 24px;border-radius:4px;">Open in admin →</a>
    </div>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
    <div style="color:#888;font-size:11px;text-align:center;">
      Lead id: <code>${escapeHtml(p.leadId)}</code>
    </div>
  </div>
</body></html>`;
}

function buildText(p: NewLeadNotifyParams & { adminLink: string }): string {
  return [
    "New Scan Lead · Averrow",
    "",
    `Email:        ${p.email}`,
    `Name:         ${p.name ?? "—"}`,
    `Company:      ${p.company ?? "—"}`,
    `Domain:       ${p.domain ?? "—"}`,
    `Phone:        ${p.phone ?? "—"}`,
    `Brand status: ${p.correlatedBrandId ? "Already monitored" : "New brand"}`,
    "",
    p.message ? `Message: ${p.message}` : "",
    "",
    `Open in admin: ${p.adminLink}`,
    "",
    `Lead id: ${p.leadId}`,
  ].filter(Boolean).join("\n");
}

// ─── Prospect-facing acknowledgement ─────────────────────────────────
// The public scan-results page tells the visitor "check your inbox" the
// moment they hand over a business email. Until this existed, the only
// email that fired was the internal sales alert above — the prospect
// received nothing, so the on-screen promise was false. This sends them
// an immediate, on-brand confirmation. The full Brand Exposure Report is
// still delivered by sales (admin generates it via
// /api/admin/leads/:id/qualified-report), so the copy here sets that
// expectation rather than claiming an instant attachment.

// Transactional sender (verified domain, same one used for invites and
// magic-links) — distinct from the sales@ alias so prospect replies
// don't thread into the internal lead alert.
const PROSPECT_FROM_ADDRESS = "Averrow <noreply@averrow.com>";

interface ProspectAckParams {
  email: string;
  name: string | null;
  domain: string | null;
}

export async function sendScanReportAcknowledgement(
  env: Env,
  params: ProspectAckParams,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.RESEND_API_KEY) {
    logger.warn("scan-ack-skipped", { email: params.email, reason: "no RESEND_API_KEY" });
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const domain = params.domain?.trim() || "your domain";
  const subject = `Your Averrow Brand Exposure Report — ${domain}`;
  const html = buildProspectAckHtml(params, domain);
  const text = buildProspectAckText(params, domain);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: PROSPECT_FROM_ADDRESS,
      to: [params.email],
      reply_to: "sales@averrow.com",
      subject,
      html,
      text,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as ResendResponse;
  if (!res.ok) {
    const error = body.message ?? body.error ?? `HTTP ${res.status}`;
    logger.error("scan-ack", { email: params.email, error });
    return { ok: false, error };
  }
  logger.info("scan-ack", { email: params.email, resendId: body.id });
  return { ok: true, id: body.id };
}

function buildProspectAckHtml(p: ProspectAckParams, domain: string): string {
  const greeting = p.name ? `Hi ${escapeHtml(p.name)},` : "Hi there,";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;color:#222;line-height:1.6;">
    <div style="color:#C83C3C;font-weight:700;letter-spacing:2px;font-size:12px;text-transform:uppercase;margin-bottom:4px;">Averrow</div>
    <div style="color:#888;font-weight:600;letter-spacing:1px;font-size:10px;text-transform:uppercase;margin-bottom:16px;">Threat Interceptor</div>
    <h2 style="font-size:18px;margin:0 0 16px;color:#111;">We've received your scan request</h2>
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 14px;">Thanks for scanning <strong style="font-family:monospace;">${escapeHtml(domain)}</strong> with Averrow. We've logged your request for the full Brand Exposure Report.</p>
    <p style="margin:0 0 14px;">Your full report goes deeper than the on-screen score — threat-actor analysis, infrastructure mapping, lookalike-domain inventory, and a specific remediation plan. A member of the Averrow team will review your results and deliver it to this inbox shortly.</p>
    <p style="margin:0 0 14px;">In the meantime, just reply to this email if you'd like to fast-track the conversation or have questions about what we found.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
    <div style="color:#888;font-size:11px;">
      Averrow · Threat Interceptor · LRX Enterprises Inc.<br>
      AI-first threat intelligence — detect · analyze · correlate · respond
    </div>
  </div>
</body></html>`;
}

function buildProspectAckText(p: ProspectAckParams, domain: string): string {
  const greeting = p.name ? `Hi ${p.name},` : "Hi there,";
  return [
    "Averrow · Threat Interceptor",
    "",
    "We've received your scan request",
    "",
    greeting,
    "",
    `Thanks for scanning ${domain} with Averrow. We've logged your request for the full Brand Exposure Report.`,
    "",
    "Your full report goes deeper than the on-screen score — threat-actor analysis, infrastructure mapping, lookalike-domain inventory, and a specific remediation plan. A member of the Averrow team will review your results and deliver it to this inbox shortly.",
    "",
    "In the meantime, just reply to this email if you'd like to fast-track the conversation or have questions about what we found.",
    "",
    "Averrow · LRX Enterprises Inc.",
  ].join("\n");
}
